// lib/diffusion/scheduler.ts — D1 §5's automatic-publication wiring (Task 9). One tick loops every
// channel with autoEnabled: check isDue, select the next candidate (schedule-core.ts, Task 8),
// persist lastAutoSendAt BEFORE sending (so a slow send is never picked up twice by the next tick —
// see settings-core.ts's setLastAutoSendAt comment), then sendToChannelCore with
// triggeredBy: 'scheduled', actorId: null (no session — this runs off a timer, not a click).
//
// NEVER THROWS, at any level (tickChannel, the loop, and the exported entrypoint all catch their
// own errors) — this is driven by croner (lib/pipeline/scheduler.ts extends its own singleton to
// call triggerDiffusionTick on a fixed cadence), which fires its callback off its own timer: an
// escaping rejection here would surface only as an unlabeled unhandled rejection, with no
// [scheduler]-prefixed trace for an operator to find. Same convention/wording as
// lib/pipeline/scheduler.ts's own triggerScheduledRun.
import { and, eq, lt, sql } from "drizzle-orm";
import { db, distributions } from "@/db";
import { CHANNELS, type Channel } from "@/lib/studio";
import { isDue, selectNextArticle } from "./schedule-core";
import { getChannelSettings, setLastAutoSendAt } from "./settings-core";
import { sendToChannelCore } from "./send-core";
import { generateCaption } from "./caption";
import { SOCIAL_CHANNELS, type SocialChannel } from "./channels";
import { createAlert } from "@/lib/alerts/notify";
import type { RenderStore } from "@/lib/studio/store";

// ─────────────────────────────────────────────────────────────────────────────
// Stale-'pending' reaper (folded into this tick — see the Task 9 report for why).
//
// send-core.ts documents a known gap: a process crash between its step 4 (insert/update the
// distributions row to 'pending') and step 5 (the final status update) leaves that row stuck at
// 'pending' forever. distributions_one_active_per_article_channel (db/schema.ts) then treats a
// 'pending' row exactly like a 'sent' one — it permanently occupies that (article, channel) pair's
// only active slot, blocking every future retry (manual OR automatic) with "un envoi est déjà en
// cours", even though nothing is actually in flight anymore.
//
// D1's own StubChannel.send is synchronous local work (no network) and a real adapter should still
// complete in well under a minute, so 'pending' is meant to be a fleeting state — anything still
// 'pending' after STALE_PENDING_MINUTES is essentially certainly a dead process, not a legitimately
// slow send. This tick is the natural place to reclaim it, mirroring lib/pipeline/overlap.ts's
// reclaimStaleRuns (reap first, then act) — deliberately simpler, though: a straight age cutoff, no
// liveness signal to cross-check (a distributions row has no per-step activity table the way
// pipeline_runs has pipeline_steps).
//
// Parameterized via DIFFUSION_STALE_PENDING_MINUTES (default 10, unchanged), same env-var
// convention as RUN_STALE_MINUTES (lib/config/pipeline-config.ts's runStaleMinutes) — D1 final
// review, Important 5. Read fresh on every call (not cached at module load) so a test can override
// it via process.env without re-importing this module, same reasoning as
// parsePipelineConfig(process.env) being called fresh per read rather than once at startup.
//
// D1 ships zero real adapters, so 10 minutes is safe today by construction — StubChannel.send does
// no I/O at all. The moment a real adapter (D2+) lands, this cutoff becomes a correctness
// assumption about that adapter's own latency, and it cuts BOTH ways: too short reclaims a
// genuinely in-flight send (a second attempt could double-post before the first's response even
// lands); too long leaves a channel needlessly wedged after a real crash. Revisit this value against
// real adapter latency once one exists — see the D1 spec's own "Post-revue" note for the matching
// D2 obligation (write `externalId` as early as the API allows, so a resend can be short-circuited
// instead of relying on this cutoff alone).
function stalePendingMinutes(): number {
  const raw = process.env.DIFFUSION_STALE_PENDING_MINUTES;
  const n = raw !== undefined ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 10;
}

export async function reclaimStalePendingDistributions(): Promise<void> {
  const staleBefore = new Date(Date.now() - stalePendingMinutes() * 60_000);
  await db.update(distributions)
    .set({
      status: "failed",
      attempts: sql`${distributions.attempts} + 1`,
      lastError: "Envoi interrompu de manière inattendue (processus arrêté avant la fin) — marqué en échec, nouvelle tentative possible.",
    })
    .where(and(eq(distributions.status, "pending"), lt(distributions.at, staleBefore)));
}

// ─────────────────────────────────────────────────────────────────────────────

export type DiffusionTickOptions = {
  now?: Date;
  // Test-only convenience: restricts which channels a call processes, so a test doesn't have to
  // reason about every OTHER channel's settings row (harmless when auto-disabled, but noisy to
  // account for). The production caller (lib/pipeline/scheduler.ts) always omits it — every
  // channel must be considered on every real tick.
  channels?: readonly Channel[];
  // Test-only: forces a channel's `send` to succeed/fail deterministically without touching the
  // real registry — mirrors sendToChannelCore's own channelOverride (send-core.ts's SendToChannelInput).
  // Never supplied by the production caller.
  channelOverrides?: Partial<Record<Channel, SocialChannel>>;
  // Test-only, threaded straight through to sendToChannelCore (and, from there, renderForArticle) —
  // same convention and same reasoning as send-core.ts's own renderStore/fetchImpl fields: without
  // them, a real render attempt hits R2 storage config (lib/studio/store.ts) and, for fetchImpl,
  // real network. send-core.ts itself already gates these on NODE_ENV === "test", so passing them
  // here is inert outside tests even if a caller forgot to omit them.
  renderStore?: RenderStore;
  fetchImpl?: typeof fetch;
};

export async function triggerDiffusionTick(opts: DiffusionTickOptions = {}): Promise<void> {
  const now = opts.now ?? new Date();
  const channels = opts.channels ?? CHANNELS;

  try {
    await reclaimStalePendingDistributions();
  } catch (e) {
    console.error("[scheduler] échec du nettoyage des diffusions bloquées : " + (e as Error).message);
  }

  // Each channel is caught INDIVIDUALLY: one channel throwing (a bug, a transient DB error) must
  // not stop the others from being considered on this same tick, and must never prevent the NEXT
  // tick from running either — that's what "a send failure does not wedge the scheduler" means in
  // practice (Task 9's required test).
  for (const channel of channels) {
    try {
      await tickChannel(channel, now, opts.channelOverrides?.[channel], opts.renderStore, opts.fetchImpl);
    } catch (e) {
      console.error(`[scheduler] échec du tic de diffusion automatique (${channel}) : ` + (e as Error).message);
    }
  }
}

// Important 2 (D1 final review): bounds how many candidates ONE tick may try on a single channel.
// sendToChannelCore can refuse BEFORE it ever writes a distributions row (render failure, R2
// unconfigured, no `social_post` template configured) — left alone, that candidate stays the
// eligible one selectNextArticle keeps returning and gets reselected IDENTICALLY on every future
// due tick, forever, silently wedging the whole channel (nothing else can ever go out while it
// sits there, since nothing marks it as "tried"). Skipping past it lets healthy candidates behind
// it still ship. Bounded rather than "walk the whole backlog" because each attempt still costs a
// real caption LLM call before this tick even reaches sendToChannelCore — 3 gives a channel a real
// chance to route around ONE bad article without a run of several consecutive misconfigured
// articles turning a single tick into an unbounded LLM-spending loop; whatever is left unattempted
// is picked up again (with a fresh alert) on the channel's next due tick.
const MAX_CANDIDATES_PER_TICK = 3;

// Does a distributions row exist at all for (articleId, channel), regardless of status? Used only
// to tell apart send-core.ts's two kinds of refusal after the fact: a row means the refusal
// happened at/after step 4 (a real send attempt was recorded — 'failed', already audited via
// article_revisions, and deliberately left retryable by selectNextArticle); no row means the
// refusal happened BEFORE step 4 and left no trace anywhere except the console.error below — the
// Important 2 "pre-row refusal" case.
async function hasDistributionRow(articleId: string, channel: Channel): Promise<boolean> {
  const [row] = await db.select({ id: distributions.id }).from(distributions)
    .where(and(eq(distributions.articleId, articleId), eq(distributions.channel, channel)))
    .limit(1);
  return row !== undefined;
}

async function tickChannel(
  channel: Channel,
  now: Date,
  channelOverride: SocialChannel | undefined,
  renderStore: RenderStore | undefined,
  fetchImpl: typeof fetch | undefined,
): Promise<void> {
  const settings = await getChannelSettings(channel);
  // Important 3 (D1 final review): `enabled` (manual-send gate, checked by sendToChannelCore
  // itself) and `autoEnabled` (this scheduler's own gate) are two UNCOUPLED switches on the same
  // form (components/settings/social-channel-form.tsx) — autoEnabled:true + enabled:false is
  // reachable, and checking only autoEnabled here left it silently expensive: every due tick still
  // selected a candidate, persisted lastAutoSendAt, made a PAID LLM caption call, and only THEN got
  // refused by sendToChannelCore's own `enabled` check — indefinitely, with no distributions row
  // ever written (the exact Important 2 "pre-row refusal" wedge, on every tick, forever). Checking
  // both here closes it off before any of that work starts.
  if (!settings.enabled || !settings.autoEnabled) return;

  const due = isDue({
    now,
    lastAutoSendAt: settings.lastAutoSendAt,
    autoIntervalHours: settings.autoIntervalHours,
    autoWindowStartHour: settings.autoWindowStartHour,
    autoWindowEndHour: settings.autoWindowEndHour,
  });
  if (!due) return; // outside the window or the interval hasn't elapsed — lastAutoSendAt untouched, spec §5

  const excludeIds: string[] = [];

  for (let attempt = 0; attempt < MAX_CANDIDATES_PER_TICK; attempt++) {
    const candidate = await selectNextArticle({
      channel, now, maxBacklogDays: settings.autoMaxBacklogDays, excludeIds,
    });
    if (!candidate) {
      if (attempt === 0) console.log(`[scheduler] diffusion automatique (${channel}) : rien à publier`);
      return;
    }

    if (attempt === 0) {
      // Set BEFORE sending (spec §5's anti-doublon guarantee — see setLastAutoSendAt's own comment
      // in settings-core.ts). From here on, this channel has "used" this tick regardless of what
      // happens next below (caption fallback, send failure(s), or success) — its next due moment is
      // a full autoIntervalHours away, not simply "whenever this function next happens to run". Set
      // exactly ONCE, on the first candidate only — a skip-and-retry within the SAME tick (below)
      // must not re-consume the interval a second time.
      await setLastAutoSendAt(channel, now);
    }

    const caption = await generateCaption({ articleId: candidate.id, channel });
    if (!caption.ok) {
      // Only reachable if the article vanished between selectNextArticle and here — generateCaption
      // itself treats "no usable AI provider" as success (a deterministic title-truncation fallback,
      // lib/diffusion/caption.ts), never as this failure branch.
      console.error(`[scheduler] diffusion automatique (${channel}) : légende impossible pour l'article ${candidate.id} : ${caption.message}`);
      return;
    }

    const result = await sendToChannelCore({
      articleId: candidate.id, channel, caption: caption.caption,
      triggeredBy: "scheduled", actorId: null, channelOverride, renderStore, fetchImpl,
    });

    if (result.ok) {
      console.log(`[scheduler] diffusion automatique (${channel}) : article ${candidate.id} envoyé (externalId=${result.externalId})`);
      return;
    }

    console.error(`[scheduler] diffusion automatique (${channel}) : échec pour l'article ${candidate.id} : ${result.message}`);

    if (await hasDistributionRow(candidate.id, channel)) {
      // A "real" attempt reached step 4+ of send-core.ts and left its own trace (a 'failed' row,
      // already audited via article_revisions) — stays retryable per selectNextArticle's own
      // exclusion rules (a 'failed' row never excludes). Do NOT skip past it: unlike the pre-row
      // case below, an operator already has visibility via that row, and skipping ahead of a
      // possibly-transient failure would send candidates out of order for no real gain.
      return;
    }

    // Important 2: sendToChannelCore refused BEFORE writing any distributions row (render failure,
    // R2 unconfigured, no `social_post` template — never "channel disabled", closed off by the
    // settings.enabled check above). No trace exists anywhere except the console.error just above.
    // Alert so an operator actually sees it, then try the next candidate instead of leaving this
    // channel silently wedged on this one article forever.
    await createAlert({
      type: "diffusion_blocked",
      title: `Diffusion bloquée — ${SOCIAL_CHANNELS[channel].label}`,
      detail: `« ${candidate.title} » ne peut pas être diffusé automatiquement sur ${SOCIAL_CHANNELS[channel].label} : ${result.message}`,
      entityId: candidate.id,
    });
    excludeIds.push(candidate.id);
  }
}

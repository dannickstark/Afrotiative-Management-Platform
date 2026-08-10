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
import { and, eq, gt, lt, sql } from "drizzle-orm";
import { db, distributions, alerts } from "@/db";
import { CHANNELS, CHANNEL_LABELS, type Channel } from "@/lib/studio";
import { isDue, selectNextArticle } from "./schedule-core";
import { getChannelSettings, hasAllCredentials, setLastAutoSendAt, type SocialChannelSettings } from "./settings-core";
import { sendToChannelCore } from "./send-core";
import { generateCaption } from "./caption";
import { SOCIAL_CHANNELS, type SocialChannel } from "./channels";
import { createAlert } from "@/lib/alerts/notify";
import { formatDate } from "@/lib/format";
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
// D1 shipped zero real adapters, so 10 minutes was safe by construction back then — StubChannel.send
// does no I/O at all. This cutoff cuts BOTH ways for a real adapter: too short reclaims a genuinely
// in-flight send (a second attempt could double-post before the first's response even lands — see
// facebook.ts's/instagram.ts's own header comments on that exact window); too long leaves a channel
// needlessly wedged after a real crash.
//
// Task 5 (D2+D3), revisited again Task 6 (D7) against the THREE real adapters that now exist, kept
// at 10 (unchanged). LinkedIn (lib/diffusion/linkedin/linkedin.ts) is now the slowest by far, not
// Instagram — see docs/DEPLOYMENT.md §6.5 for the same figures spelled out for an operator: 4
// timeout-bound steps (download the render, initializeUpload, PUT the bytes, POST /rest/posts), each
// individually bounded by LinkedInClient's own DEFAULT_TIMEOUT_MS=20s (rest-client.ts) or, for the
// download, linkedin.ts's own DOWNLOAD_TIMEOUT_MS=20s — a call that legitimately takes just under
// that ceiling still SUCCEEDS, it just hasn't hit the abort yet — plus up to 10 status-poll GETs
// (same 20s bound each) with 9 inter-poll sleeps of pollIntervalMs=3s between them. (4 + 10) × 20s +
// 9 × 3s = 280s + 27s = 307s, ≈5.1 minutes. Instagram's own bounded container poll
// (lib/diffusion/meta/instagram.ts) is next: 12 Graph HTTP round trips (1 create-container + up to
// pollMaxAttempts=10 status polls + 1 media_publish), each bounded the same way, plus 9 inter-poll
// sleeps of 3s — 12 × 20s + 9 × 3s = 240s + 27s = 267s, ≈4.5 minutes. Facebook (facebook.ts) is a
// single Graph call, so its own worst case is a small fraction of either (≈20s). Against LinkedIn's
// ≈5.1-minute theoretical ceiling — now the binding one — the existing 10-minute (600s) default
// keeps a ≈1.95× margin: tighter than the ≈2.2× Instagram alone would give, but still comfortably
// positive, and narrowing the default further buys little (the three adapters' well-documented
// at-least-once/duplicate-post windows above are already the sharper, unclosed risk here — see their
// own header comments — so erring toward NOT reclaiming a send that might still be genuinely in
// flight is the safer direction to round in). Kept at 10, unchanged; see
// tests/diffusion-scheduler.test.ts's "cutoff configurable via DIFFUSION_STALE_PENDING_MINUTES"
// describe block for the env-var override's own coverage.
//
// Issue 7 (D7 final review) — the prose above is the only defence against narrowing this past
// LinkedIn's own worst case; an operator lowering DIFFUSION_STALE_PENDING_MINUTES to "make retries
// snappier" (the reviewer's own example: 5 minutes) would put the reaper INSIDE that ≈5.1-minute
// window and reclaim a send that is still genuinely in flight — the consequence is not a wasted
// retry, it is a DUPLICATED LIVE PUBLIC POST once the original request eventually completes. A floor
// backs the prose with code: STALE_PENDING_FLOOR_MINUTES (6) is the smallest whole number of minutes
// that still fully covers the ≈5.1-minute (307s) LinkedIn ceiling above (ceil(307s / 60) = 6),
// leaving the operator free to shorten the default 10-minute cutoff somewhat without being able to
// cross back into the danger zone the paragraph above spends several sentences explaining.
const STALE_PENDING_FLOOR_MINUTES = 6;

function stalePendingMinutes(): number {
  const raw = process.env.DIFFUSION_STALE_PENDING_MINUTES;
  const n = raw !== undefined ? Number(raw) : NaN;
  const requested = Number.isFinite(n) && n > 0 ? n : 10;
  const floored = Math.max(requested, STALE_PENDING_FLOOR_MINUTES);
  if (floored !== requested) {
    console.warn(
      `[scheduler] DIFFUSION_STALE_PENDING_MINUTES=${requested} est sous le plancher de sécurité ` +
      `de ${STALE_PENDING_FLOOR_MINUTES} min (pire cas LinkedIn ≈5,1 min, voir docs/DEPLOYMENT.md ` +
      `§6.5) — ${STALE_PENDING_FLOOR_MINUTES} min appliquées pour éviter de réclamer un envoi encore ` +
      "légitimement en cours et publier un doublon public.",
    );
  }
  return floored;
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
// Token-expiry alerting (Task 2, D7 spec §4). Both Meta and LinkedIn issue ~60-day credentials with
// no cheap way to read the real expiry back — tracked (social_channel_settings.tokenExpiresAt), not
// discovered. Runs from the OUTER loop below, for every channel with a full credential set,
// auto-publish or not: a token an operator uses by hand expires just the same, and auto-publish is
// OFF by default (spec §5's own baseline), so gating this on autoEnabled — the way tickChannel's
// own `!settings.enabled || !settings.autoEnabled` early return at line ~173 does — would silence
// the alert for exactly the common case, not an edge one.
export const TOKEN_EXPIRY_WARNING_DAYS = 7;

async function warnIfTokenExpiring(channel: Channel, settings: SocialChannelSettings): Promise<void> {
  if (!hasAllCredentials(channel, settings)) return;
  if (!settings.tokenExpiresAt) return;
  const days = (settings.tokenExpiresAt.getTime() - Date.now()) / 86_400_000;
  if (days > TOKEN_EXPIRY_WARNING_DAYS) return;
  if (await hasRecentTokenAlert(channel)) return;
  await createAlert({
    type: "token_expiring",
    title: tokenExpiringAlertTitle(channel),
    detail: `Le jeton d'accès ${CHANNEL_LABELS[channel]} expire le ${formatDate(settings.tokenExpiresAt)}. Générez-en un nouveau et enregistrez-le sur /settings/social/${channel}.`,
    // entityId is deliberately left null, not the channel key. alerts.entity_id (db/schema.ts) is a
    // `uuid` column — it already points at a pipeline_runs.id, a feeds.id or (for diffusion_blocked)
    // an articles.id for every OTHER alert type, and a short channel key like "linkedin" is not a
    // UUID: the INSERT itself would reject it (verified against tests/alerts.test.ts's own "a
    // non-uuid string rejects" case), and createAlert's blanket try/catch (lib/alerts/notify.ts)
    // would then swallow that failure silently — the alert would simply never be created, forever,
    // with nothing but a console.error to notice by. The per-channel identity this feature actually
    // needs — for hasRecentTokenAlert's 24h dedup below, and for this file's own tests — is carried
    // instead by `title`, which is entirely deterministic per channel (CHANNEL_LABELS is a fixed
    // 1:1 map, lib/studio/tokens.ts) via tokenExpiringAlertTitle.
    entityId: null,
  });
}

function tokenExpiringAlertTitle(channel: Channel): string {
  return `Jeton ${CHANNEL_LABELS[channel]} bientôt expiré`;
}

// At most one token_expiring alert per channel per 24h (spec §4): the tick runs every 15 minutes, so
// without this gate a token sitting inside the warning window for a week would raise roughly 672
// rows. The cheapest honest gate: an existing token_expiring alert for this exact channel (matched
// via its deterministic title — see warnIfTokenExpiring's comment on why entityId can't carry this)
// newer than 24h.
async function hasRecentTokenAlert(channel: Channel): Promise<boolean> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const [row] = await db.select({ id: alerts.id }).from(alerts)
    .where(and(
      eq(alerts.type, "token_expiring"),
      eq(alerts.title, tokenExpiringAlertTitle(channel)),
      gt(alerts.createdAt, since),
    ))
    .limit(1);
  return row !== undefined;
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
    // Token-expiry check runs BEFORE tickChannel, in its own try/catch (Task 2, D7 spec §4) — see
    // this file's own comment above warnIfTokenExpiring for why it cannot live inside tickChannel,
    // which returns early at `!settings.enabled || !settings.autoEnabled` (the majority case, since
    // auto-publish is off by default). Separate try/catch from tickChannel's own below: a failure
    // reading/alerting on the token's expiry must never block that SAME channel's send attempt, and
    // vice versa.
    try {
      const settings = await getChannelSettings(channel);
      await warnIfTokenExpiring(channel, settings);
    } catch (e) {
      console.error(`[scheduler] échec de l'alerte d'expiration de jeton (${channel}) : ` + (e as Error).message);
    }

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

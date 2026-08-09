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
import type { SocialChannel } from "./channels";
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
// pipeline_runs has pipeline_steps), and not wired through an env var like RUN_STALE_MINUTES — D1
// has exactly one caller for this and no operator-facing knob for it yet.
const STALE_PENDING_MINUTES = 10;

export async function reclaimStalePendingDistributions(): Promise<void> {
  const staleBefore = new Date(Date.now() - STALE_PENDING_MINUTES * 60_000);
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

async function tickChannel(
  channel: Channel,
  now: Date,
  channelOverride: SocialChannel | undefined,
  renderStore: RenderStore | undefined,
  fetchImpl: typeof fetch | undefined,
): Promise<void> {
  const settings = await getChannelSettings(channel);
  if (!settings.autoEnabled) return;

  const due = isDue({
    now,
    lastAutoSendAt: settings.lastAutoSendAt,
    autoIntervalHours: settings.autoIntervalHours,
    autoWindowStartHour: settings.autoWindowStartHour,
    autoWindowEndHour: settings.autoWindowEndHour,
  });
  if (!due) return; // outside the window or the interval hasn't elapsed — lastAutoSendAt untouched, spec §5

  const candidate = await selectNextArticle({ channel, now, maxBacklogDays: settings.autoMaxBacklogDays });
  if (!candidate) {
    console.log(`[scheduler] diffusion automatique (${channel}) : rien à publier`);
    return;
  }

  // Set BEFORE sending (spec §5's anti-doublon guarantee — see setLastAutoSendAt's own comment in
  // settings-core.ts). From here on, this channel has "used" this tick regardless of what happens
  // next below (caption fallback, send failure, or success) — its next due moment is a full
  // autoIntervalHours away, not simply "whenever this function next happens to run".
  await setLastAutoSendAt(channel, now);

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
  } else {
    console.error(`[scheduler] diffusion automatique (${channel}) : échec pour l'article ${candidate.id} : ${result.message}`);
  }
}

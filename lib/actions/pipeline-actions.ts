"use server";
import { requireUser } from "@/lib/session";
import { requirePermission } from "@/lib/rbac";
import { runParamsSchema, type RunParamsInput } from "@/lib/validation";
import type { RawItem } from "@/lib/rss/parse-feed";
import type { RunDetail, ActiveRun } from "@/lib/queries/runs";

// Drizzle wraps driver errors in DrizzleQueryError, so the pg SQLSTATE lives on `.cause` (not the
// top-level error) — walk the cause chain to find it. Mirrors lib/pipeline/run.ts's helper; used
// to turn the pipeline_runs_one_running unique violation (23505) into a friendly message rather
// than an unhandled throw. (import type above is erased at build time, so it adds no runtime deps.)
function pgErrorCode(e: unknown): string | undefined {
  let cur: unknown = e;
  for (let i = 0; i < 5 && cur != null; i++) {
    const code = (cur as { code?: unknown }).code;
    if (typeof code === "string") return code;
    cur = (cur as { cause?: unknown }).cause;
  }
  return undefined;
}

/**
 * On-demand fetch for the run-detail drawer (SP4 Task 4): the runs list page only loads summary
 * rows, so RunsView calls this per-click rather than front-loading every run's full step trace.
 * Read-only (pipeline:read, not :configure) — unlike startPipelineRun/reprocessRawItem below.
 */
export async function getRunDetailAction(runId: string): Promise<RunDetail | null> {
  const user = await requireUser();
  requirePermission(user.role, "pipeline", "read");

  // Dynamic import (kept AFTER the RBAC check above): mirrors startPipelineRun's/reprocessRawItem's
  // pattern in this file — keeping every value-level import inside pipeline-actions.ts deferred
  // avoids Turbopack ever needing to resolve the pipeline's jsdom-heavy dependency graph while
  // statically analyzing this "use server" module at build time.
  const { getRunDetail } = await import("@/lib/queries/runs");
  return getRunDetail(runId);
}

/**
 * Non-blocking trigger: opens the run (holds the slot, gives us runId synchronously), then kicks
 * executeRun DETACHED and returns immediately. The /runs live panel polls getActiveRun to watch it.
 * Detached promise survives on Railway's long-lived Node process; a mid-run process death is caught
 * by the RUN_STALE_MINUTES reaper. Note: going detached also means this path has no `maxDuration`
 * ceiling (unlike the scheduled route's 300s) — liveness is instead covered by the activity-based
 * stale-run reclaim in lib/pipeline/overlap.ts (reclaimStaleRuns), not by age alone.
 */
export async function startPipelineRun(input?: RunParamsInput): Promise<{ ok: true; runId: string } | { ok: false; message: string }> {
  const user = await requireUser();
  requirePermission(user.role, "pipeline", "configure");

  // Validate overrides if provided; omit → resolve everything from settings defaults.
  let parsed: RunParamsInput | undefined;
  if (input !== undefined) {
    const r = runParamsSchema.safeParse(input);
    if (!r.success) return { ok: false as const, message: "Paramètres d'exécution invalides." };
    parsed = r.data;
  }

  // Dynamic imports kept AFTER the RBAC check (mirrors the rest of this file — see reprocessRawItem).
  const { openRun, executeRun } = await import("@/lib/pipeline/run");
  const { resolveRunParams } = await import("@/lib/pipeline/run-params");
  const { getPipelineSettings } = await import("@/lib/queries/settings");
  const { db, feeds } = await import("@/db");
  const { eq, inArray } = await import("drizzle-orm");

  const settings = await getPipelineSettings();
  const params = resolveRunParams(parsed, {
    defaultMaxItemAgeHours: settings.defaultMaxItemAgeHours,
    maxItemsPerRun: settings.maxItemsPerRun,
  }, new Date());

  const feedsTotal = params.feedIds != null
    ? (await db.select({ id: feeds.id }).from(feeds).where(inArray(feeds.id, params.feedIds))).length
    : (await db.select({ id: feeds.id }).from(feeds).where(eq(feeds.active, true))).length;

  const runId = await openRun({ triggeredBy: "manual", feedsTotal, params });
  if (!runId) return { ok: false as const, message: "Une exécution est déjà en cours." };

  // Detached — do NOT await. executeRun always finalizes in its own finally, so a rejection here
  // is impossible in practice; the catch is belt-and-suspenders against an unhandled rejection.
  void executeRun(runId).catch(() => {});
  return { ok: true as const, runId };
}

/** Read-only fetch of the active run for the live panel poll (pipeline:read). */
export async function getActiveRunAction(): Promise<ActiveRun | null> {
  const user = await requireUser();
  requirePermission(user.role, "pipeline", "read");
  const { getActiveRun } = await import("@/lib/queries/runs");
  return getActiveRun();
}

/**
 * SP5 Task 3 (Stop): sets cancel_requested=true on the given run IF it is currently active
 * (running OR paused — i.e. finished_at IS NULL). executeRun (lib/pipeline/run.ts) is a detached
 * promise, so this is the only way to signal it — it polls cancel_requested at safe boundaries
 * (after phase 1 / before phase 2, and at the top of each story iteration) and, once observed,
 * finalizes the run to the terminal "cancelled" status instead of the computed success/partial/
 * failed tally. No-ops with a friendly French message if the run is already terminal (or doesn't
 * exist) — never throws for that case.
 */
export async function cancelRun(runId: string): Promise<{ ok: true } | { ok: false; message: string }> {
  const user = await requireUser();
  requirePermission(user.role, "pipeline", "configure");

  // Dynamic import (kept AFTER the RBAC check above): mirrors this file's other actions — keeps
  // pipeline-adjacent value-level imports out of this "use server" module's static graph.
  const { db, pipelineRuns } = await import("@/db");
  const { and, eq, isNull } = await import("drizzle-orm");

  // SP5 Task 4 review I4 + C2 recovery — a PAUSED run has NO executeRun in flight to observe a
  // cooperative cancel_requested flag (its detached promise already exited when it parked), so
  // merely flagging it would strand it forever (the reaper skips paused; resumeRun would refuse a
  // cancel-flagged run). So finalize a paused run DIRECTLY here: terminal 'cancelled' + finished_at
  // frees the pipeline_runs_one_running interlock slot immediately, and clearing checkpoint/flags
  // leaves a clean terminal row. This is also the recovery path for an already-stranded paused run
  // (e.g. a legacy empty-checkpoint pause). Status-guarded (WHERE status='paused') so it is atomic
  // against a concurrent resumeRun — at most one of {cancel-finalize, resume-claim} wins.
  const finalizedPaused = await db.update(pipelineRuns)
    .set({ status: "cancelled", finishedAt: new Date(), checkpoint: null, pauseRequested: false, cancelRequested: false })
    .where(and(eq(pipelineRuns.id, runId), eq(pipelineRuns.status, "paused")))
    .returning({ id: pipelineRuns.id });
  if (finalizedPaused.length > 0) {
    const { revalidatePath } = await import("next/cache");
    revalidatePath("/runs");
    return { ok: true as const };
  }

  // A RUNNING run IS being executed by a detached executeRun that polls cancel_requested at safe
  // boundaries (Task 3) — cooperative cancel. Status-guarded to 'running' so the paused branch above
  // owns the paused case exclusively (no double-handling), while finished_at IS NULL keeps this a
  // true no-op on an already-terminal row.
  const flagged = await db.update(pipelineRuns)
    .set({ cancelRequested: true })
    .where(and(eq(pipelineRuns.id, runId), eq(pipelineRuns.status, "running"), isNull(pipelineRuns.finishedAt)))
    .returning({ id: pipelineRuns.id });

  if (flagged.length === 0) return { ok: false as const, message: "L'exécution est déjà terminée." };

  const { revalidatePath } = await import("next/cache");
  revalidatePath("/runs");
  return { ok: true as const };
}

/**
 * SP5 Task 4 (Pause): sets pause_requested=true on the given run IF it is currently ACTIVE and
 * still "running" (a run already paused, or terminal, is a friendly no-op — never a throw).
 * executeRun (lib/pipeline/run.ts) polls this flag at the SAME safe boundaries as
 * cancel_requested — after phase 1 / before phase 2, and at the top of each story iteration — and,
 * once observed (and cancel_requested is NOT also set — Stop always wins), finalizes to the
 * NON-terminal "paused" status with a checkpoint of the remaining stories. finished_at stays NULL:
 * a paused run intentionally still holds the pipeline_runs_one_running slot (db/schema.ts) — only
 * resumeRun() or cancelRun() can free it from here.
 */
export async function pauseRun(runId: string): Promise<{ ok: true } | { ok: false; message: string }> {
  const user = await requireUser();
  requirePermission(user.role, "pipeline", "configure");

  // Dynamic import (kept AFTER the RBAC check above): mirrors this file's other actions.
  const { db, pipelineRuns } = await import("@/db");
  const { and, eq, isNull } = await import("drizzle-orm");

  const updated = await db.update(pipelineRuns)
    .set({ pauseRequested: true })
    .where(and(eq(pipelineRuns.id, runId), eq(pipelineRuns.status, "running"), isNull(pipelineRuns.finishedAt)))
    .returning({ id: pipelineRuns.id });

  if (updated.length === 0) {
    return { ok: false as const, message: "Cette exécution ne peut pas être mise en pause (elle est déjà en pause ou terminée)." };
  }

  const { revalidatePath } = await import("next/cache");
  revalidatePath("/runs");
  return { ok: true as const };
}

/**
 * SP5 Task 4 (Resume): ONLY proceeds if the run is currently "paused" AND its checkpoint holds at
 * least one remaining story — otherwise a friendly French no-op (never a throw). Two writes make up
 * the resume, in this exact ORDER — SP5 Task 5 revises the original Task 4 design (which refreshed
 * `started_at` on the flip) to fix a duration-display bug: refreshing `started_at` made the panel's
 * `elapsed = now - startedAt` and the run-detail's `finishedAt - startedAt` read as time-SINCE-RESUME
 * rather than the run's true total wall-clock (understating it by the paused interval). The fix:
 *   1. Insert the "Reprise de l'exécution" `pipeline_steps` row FIRST, WHILE THE RUN IS STILL
 *      "paused" — a pure observability insert, safe to do before the status flip.
 *   2. THEN the atomic, status-guarded flip: `UPDATE … SET status='running', pause_requested=false,
 *      checkpoint=null WHERE id=? AND status='paused' RETURNING` — deliberately WITHOUT touching
 *      `started_at`. Leaving it at the run's original open time means elapsed/duration everywhere
 *      reads as the TRUE total wall-clock (paused interval included), not merely time-since-resume.
 * Three invariants ride on this ordering:
 *   - Reaper-safe (review C1, revised): because a fresh pipeline_steps row already exists at the
 *     INSTANT status flips to "running" (inserted a moment earlier, in step 1), reclaimStaleRuns()'s
 *     activity predicate (`no step since staleBefore`) is already false the moment the row becomes
 *     visible as "running" — so the run is never reaped, even though `started_at` is old (age alone
 *     is no longer a safe signal now that started_at stops being refreshed on resume). executeRun's
 *     own resume branch (lib/pipeline/run.ts) no longer inserts this step itself — one insert, here,
 *     not two.
 *   - Atomicity vs. concurrent resumes (I3): two racing resumeRun calls both pass the SELECT gate,
 *     but only the FIRST update matches a `paused` row; the loser sees 0 rows and no-ops instead of
 *     firing a second executeRun (which would duplicate this run's articles).
 *   - Clearing pause_requested BEFORE executeRun runs prevents its first cooperative-flag boundary
 *     check from re-observing a stale flag and immediately re-pausing without processing anything.
 * Only if a row was actually claimed does it fire executeRun DETACHED (mirrors startPipelineRun's
 * non-blocking pattern) and return immediately — the /runs live panel polls getActiveRun to watch.
 */
export async function resumeRun(runId: string): Promise<{ ok: true } | { ok: false; message: string }> {
  const user = await requireUser();
  requirePermission(user.role, "pipeline", "configure");

  // Dynamic import (kept AFTER the RBAC check above): mirrors startPipelineRun's pattern — keeps
  // executeRun's jsdom-heavy dependency graph out of this "use server" module's static analysis.
  const { db, pipelineRuns, pipelineSteps } = await import("@/db");
  const { and, eq } = await import("drizzle-orm");
  const { executeRun } = await import("@/lib/pipeline/run");

  const [run] = await db.select({ status: pipelineRuns.status, checkpoint: pipelineRuns.checkpoint })
    .from(pipelineRuns).where(eq(pipelineRuns.id, runId));

  if (!run || run.status !== "paused") {
    return { ok: false as const, message: "Cette exécution n'est pas en pause." };
  }
  const stories = run.checkpoint?.stories;
  if (!stories || stories.length === 0) {
    return { ok: false as const, message: "Aucun point de reprise disponible pour cette exécution." };
  }

  // SP5 Task 5 — step FIRST, while the run is still "paused" (see the doc comment above for why
  // this order — not the atomic flip below — is what keeps the resumed run reaper-safe).
  await db.insert(pipelineSteps).values({ runId, name: "Reprise de l'exécution", status: "success", durationMs: null });

  // Atomic, status-guarded claim — deliberately does NOT refresh started_at (see doc comment above).
  // Also resets phase→'processing_items' in the SAME statement: on pause, executeRun's finalize path
  // left phase='finalizing' (lib/pipeline/run.ts). If we flip status→running while phase is still the
  // stale 'finalizing', a live-panel poll landing in the window BEFORE the detached executeRun does
  // its own setProgress(phase:'processing_items') would see status=running + phase=finalizing →
  // deriveHeader's finalizing branch → a "flash" of 100%/"Finalisation" on a run that just resumed
  // and has real work left. Setting phase here closes that window atomically with the status flip.
  const claimed = await db.update(pipelineRuns)
    .set({ status: "running", pauseRequested: false, checkpoint: null, phase: "processing_items" })
    .where(and(eq(pipelineRuns.id, runId), eq(pipelineRuns.status, "paused")))
    .returning({ id: pipelineRuns.id });
  if (claimed.length === 0) {
    // Lost the race to a concurrent resume/cancel that already moved this row off 'paused'.
    return { ok: false as const, message: "Cette exécution n'est pas en pause." };
  }

  // Detached — do NOT await. executeRun always finalizes in its own finally, so a rejection here
  // is impossible in practice; the catch is belt-and-suspenders against an unhandled rejection.
  void executeRun(runId, { resumeStories: stories }).catch(() => {});

  const { revalidatePath } = await import("next/cache");
  revalidatePath("/runs");
  return { ok: true as const };
}

/**
 * Retries one stored raw_items row through the stage chain WITHOUT dedup: unlike the normal
 * ingestion path (isSeen/recordRawItem in lib/pipeline/dedup.ts), this operates directly on the
 * already-recorded row, so a previously-failed or previously-published item can be re-run on
 * demand. Human-review gate still applies — stageItem only ever produces a "pending" article.
 */
export async function reprocessRawItem(
  rawItemId: string
): Promise<{ ok: boolean; message: string; articleId?: string | null }> {
  const user = await requireUser();
  requirePermission(user.role, "pipeline", "configure");

  // Dynamic import (kept AFTER the RBAC check above): see startPipelineRun's comment above —
  // stageItem transitively pulls in the jsdom-heavy extraction chain, which breaks `bun run build`
  // under Turbopack if statically imported at the top of this "use server" module.
  const { db, rawItems, feeds, wpCategories, pipelineRuns, pipelineSteps } = await import("@/db");
  const { eq } = await import("drizzle-orm");
  const { hasRunningRun } = await import("@/lib/pipeline/overlap");
  const { stageItem } = await import("@/lib/pipeline/stages");

  if (await hasRunningRun()) return { ok: false as const, message: "Une exécution est déjà en cours." };

  const [ri] = await db.select().from(rawItems).where(eq(rawItems.id, rawItemId));
  if (!ri) return { ok: false as const, message: "Élément introuvable." };
  const [feed] = await db.select().from(feeds).where(eq(feeds.id, ri.feedId));
  const cats = (await db.select({ name: wpCategories.name }).from(wpCategories)).map((c) => c.name);

  // Open the "reprocess" run row. Even with the hasRunningRun() check above, two admin-triggered
  // reprocess/startPipelineRun calls can slip past it in the same instant; the
  // pipeline_runs_one_running partial unique index then rejects the losing insert (SQLSTATE
  // 23505). Return the friendly message rather than throwing, matching runPipeline()'s handling
  // of the same collision.
  let run: { id: string };
  try {
    [run] = await db.insert(pipelineRuns)
      .values({ triggeredBy: "reprocess", status: "running", feedsRead: 0, newItems: 1, published: 0 })
      .returning({ id: pipelineRuns.id });
  } catch (e) {
    if (pgErrorCode(e) === "23505") return { ok: false as const, message: "Une exécution est déjà en cours." };
    throw e;
  }

  // From here on the run row is "running", occupying the single slot the pipeline_runs_one_running
  // partial unique index allows — a stuck row would block every future run (scheduled AND
  // reprocess) until the RUN_STALE_MINUTES reaper reclaims it. Mirror runPipeline()'s guarantee
  // (lib/pipeline/run.ts) that the row is ALWAYS finalized, even if something in here throws.
  let articleId: string | null = null;
  try {
    // Built from the stored row rather than a fresh RSS parse — this IS the dedup bypass: we
    // never call isSeen()/recordRawItem(), so a raw_items row that already exists (by
    // construction, since we just selected it by id) is staged anyway.
    const item: RawItem = {
      guid: ri.guid, url: ri.url, title: ri.rawTitle ?? "", contentSnippet: ri.rawBody ?? "",
      isoDate: null, contentHash: ri.contentHash,
    };
    const staged = await stageItem(item, feed?.name ?? "Source", cats);
    articleId = staged.articleId;

    // Persist steps best-effort: observability only — a step-insert failure must NEVER block the
    // run's finalization or the returned envelope (the article may already be staged). Same
    // isolated swallow-catch as lib/pipeline/run.ts's step insert.
    if (staged.steps.length) {
      try {
        await db.insert(pipelineSteps).values(staged.steps.map((s) => ({
          runId: run.id, rawItemId, name: s.name, status: s.status, durationMs: s.durationMs,
          errorMessage: s.errorMessage ?? null, errorTechnical: s.errorTechnical ?? null,
        })));
      } catch { /* observability only — never block finalization/return */ }
    }
  } finally {
    await db.update(pipelineRuns)
      .set({ status: articleId ? "success" : "failed", finishedAt: new Date(), newItems: 1, published: 0 })
      .where(eq(pipelineRuns.id, run.id));
  }

  const { revalidatePath } = await import("next/cache");
  revalidatePath("/runs");
  revalidatePath("/queue");
  revalidatePath("/dashboard");

  return articleId
    ? { ok: true as const, message: "Élément retraité — article déposé en revue.", articleId }
    : { ok: false as const, message: "Le retraitement a échoué (voir la trace de l'exécution)." };
}

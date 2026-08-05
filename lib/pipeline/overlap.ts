import { db, pipelineRuns, pipelineSteps } from "@/db";
import { and, eq, isNull, lt, notExists, sql } from "drizzle-orm";
import { getPipelineConfig } from "@/lib/config/pipeline-config";

// Overlap guard: callers (manual-trigger action / scheduled endpoint) MUST check this
// BEFORE calling runPipeline(), since runPipeline's very first act is to insert a new
// "running" pipeline_runs row — by the time it has run, a hasRunningRun() call would
// (correctly) see that row too.

// Stale-run reclaim: runPipeline's try/finally always finalizes its row to a terminal status on
// a JS exception, but a hard process kill (the route's maxDuration=300 timeout, a deploy, OOM)
// skips `finally` entirely, leaving the row "running" with finished_at still null — forever.
// After that, hasRunningRun() would ALWAYS return true and the pipeline_runs_one_running partial
// unique index would block every future run, halting ingestion with no recovery path. So before
// answering, reclaim any "running" row whose started_at is older than RUN_STALE_MINUTES (default
// 15 — safely above the route's 5-minute cap, so a genuinely in-flight run is never reclaimed) by
// finalizing it to "failed". That frees the partial unique index immediately, so a fresh run can
// proceed right after.
//
// Age alone is no longer sufficient: startPipelineRun (lib/actions/pipeline-actions.ts) fires
// executeRun DETACHED (`void executeRun(runId).catch(() => {})`), so a manual run has NO
// maxDuration ceiling — a legitimately long run (large MAX_ITEMS_PER_RUN, slow providers) can run
// well past RUN_STALE_MINUTES while still alive. Reaping by age alone would falsely mark it
// "failed" mid-flight and free the pipeline_runs_one_running slot, letting a second run start
// concurrently. executeRun inserts a pipeline_steps row every few seconds while it's alive, so
// recent step activity is the real liveness signal: only reclaim a row that is BOTH past the age
// cutoff AND has produced no pipeline_steps activity since that same cutoff.
export async function reclaimStaleRuns(): Promise<void> {
  const cfg = getPipelineConfig();
  const staleBefore = new Date(Date.now() - cfg.runStaleMinutes * 60_000);
  await db.update(pipelineRuns)
    .set({ status: "failed", finishedAt: new Date() })
    .where(and(
      eq(pipelineRuns.status, "running"),
      isNull(pipelineRuns.finishedAt),
      lt(pipelineRuns.startedAt, staleBefore),
      notExists(
        db.select({ one: sql`1` }).from(pipelineSteps).where(and(
          eq(pipelineSteps.runId, pipelineRuns.id),
          sql`${pipelineSteps.at} >= ${staleBefore}`,
        )),
      ),
    ));
}

export async function hasRunningRun(): Promise<boolean> {
  await reclaimStaleRuns();
  const rows = await db.select({ id: pipelineRuns.id }).from(pipelineRuns).where(eq(pipelineRuns.status, "running")).limit(1);
  return rows.length > 0;
}

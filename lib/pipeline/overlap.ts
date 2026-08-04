import { db, pipelineRuns } from "@/db";
import { eq } from "drizzle-orm";

// Overlap guard: callers (manual-trigger action / scheduled endpoint) MUST check this
// BEFORE calling runPipeline(), since runPipeline's very first act is to insert a new
// "running" pipeline_runs row — by the time it has run, a hasRunningRun() call would
// (correctly) see that row too.
export async function hasRunningRun(): Promise<boolean> {
  const rows = await db.select({ id: pipelineRuns.id }).from(pipelineRuns).where(eq(pipelineRuns.status, "running")).limit(1);
  return rows.length > 0;
}

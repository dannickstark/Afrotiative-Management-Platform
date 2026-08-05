import { db, pipelineRuns, pipelineSteps } from "@/db";
import { desc, sql } from "drizzle-orm";
import { RunsView } from "@/components/pipeline/runs-view";
import { requireUser } from "@/lib/session";
import { requirePermission } from "@/lib/rbac";
import { getActiveRun, getRunTrends } from "@/lib/queries/runs";

export default async function RunsPage() {
  const user = await requireUser();
  requirePermission(user.role, "pipeline", "read");

  const rows = await db.select({
    id: pipelineRuns.id,
    triggeredBy: pipelineRuns.triggeredBy,
    status: pipelineRuns.status,
    feedsRead: pipelineRuns.feedsRead,
    newItems: pipelineRuns.newItems,
    startedAt: pipelineRuns.startedAt,
    finishedAt: pipelineRuns.finishedAt, // SP7: Duration column (runs-view.tsx)
    // NOTE: correlate against the literal "pipeline_runs.id" text, not an interpolated
    // ${pipelineRuns.id} column reference — drizzle only qualifies interpolated columns with
    // their table name when the outer query has a join. This plain `.from(pipelineRuns)` query
    // has none, so ${pipelineRuns.id} renders as bare "id", which inside this subquery resolves
    // to pipeline_steps' OWN "id" column (both tables have one) instead of the outer row,
    // silently making the correlation always false. Verified via .toSQL() during review.
    failedSteps: sql<number>`(select count(*) from ${pipelineSteps} s where s.run_id = pipeline_runs.id and s.status = 'failed')`,
  }).from(pipelineRuns)
    .orderBy(desc(pipelineRuns.startedAt))
    .limit(50); // SP7: was 20 — a usable history view needs more than one page's worth of runs

  const runs = rows.map((r) => ({ ...r, failedSteps: Number(r.failedSteps) }));
  const [activeRun, trends] = await Promise.all([getActiveRun(), getRunTrends()]);

  return <RunsView runs={runs} initialActive={activeRun} trends={trends} />;
}

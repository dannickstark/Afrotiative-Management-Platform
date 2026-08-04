import { db, pipelineRuns, pipelineSteps } from "@/db";
import { desc, sql } from "drizzle-orm";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { RunNow } from "@/components/pipeline/run-now";
import { formatDate, pipelineStatusLabel, type PipelineStatus } from "@/lib/format";

const TRIGGER_LABEL: Record<string, string> = { manual: "Manuel", scheduled: "Programmé" };

const STATUS_STYLE: Record<PipelineStatus, string> = {
  running: "text-[var(--status-in-review)]",
  success: "text-[var(--status-approved)]",
  partial: "text-[var(--status-pending)]",
  failed: "text-[var(--status-error)]",
};

export default async function RunsPage() {
  const rows = await db.select({
    id: pipelineRuns.id,
    triggeredBy: pipelineRuns.triggeredBy,
    status: pipelineRuns.status,
    feedsRead: pipelineRuns.feedsRead,
    newItems: pipelineRuns.newItems,
    published: pipelineRuns.published,
    startedAt: pipelineRuns.startedAt,
    // NOTE: correlate against the literal "pipeline_runs.id" text, not an interpolated
    // ${pipelineRuns.id} column reference — drizzle only qualifies interpolated columns with
    // their table name when the outer query has a join. This plain `.from(pipelineRuns)` query
    // has none, so ${pipelineRuns.id} renders as bare "id", which inside this subquery resolves
    // to pipeline_steps' OWN "id" column (both tables have one) instead of the outer row,
    // silently making the correlation always false. Verified via .toSQL() during review.
    failedSteps: sql<number>`(select count(*) from ${pipelineSteps} s where s.run_id = pipeline_runs.id and s.status = 'failed')`,
  }).from(pipelineRuns)
    .orderBy(desc(pipelineRuns.startedAt))
    .limit(20);

  const runs = rows.map((r) => ({ ...r, failedSteps: Number(r.failedSteps) }));

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Exécutions du pipeline</h1>
        <RunNow />
      </div>

      <Card>
        <CardHeader><CardTitle className="text-base">Dernières exécutions</CardTitle></CardHeader>
        <CardContent>
          {runs.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted-foreground">Aucune exécution pour l&apos;instant.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Horodatage</TableHead>
                  <TableHead>Déclencheur</TableHead>
                  <TableHead className="text-right">Flux lus</TableHead>
                  <TableHead className="text-right">Nouveaux</TableHead>
                  <TableHead className="text-right">Publiés</TableHead>
                  <TableHead>Statut</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {runs.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell>{formatDate(r.startedAt)}</TableCell>
                    <TableCell>{TRIGGER_LABEL[r.triggeredBy] ?? r.triggeredBy}</TableCell>
                    <TableCell className="text-right">{r.feedsRead}</TableCell>
                    <TableCell className="text-right">{r.newItems}</TableCell>
                    <TableCell className="text-right">{r.published}</TableCell>
                    <TableCell>
                      <span className={STATUS_STYLE[r.status]}>{pipelineStatusLabel(r.status)}</span>
                      {r.failedSteps > 0 && (
                        <span className="ml-2 text-xs text-[var(--status-error)]">
                          ({r.failedSteps} étape{r.failedSteps > 1 ? "s" : ""} en échec)
                        </span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

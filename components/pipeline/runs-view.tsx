"use client";
import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { RunNow } from "@/components/pipeline/run-now";
import { RunDetailSheet } from "@/components/pipeline/run-detail-sheet";
import { formatDate, pipelineStatusLabel, type PipelineStatus } from "@/lib/format";
import { getRunDetailAction } from "@/lib/actions/pipeline-actions";
import type { RunDetail } from "@/lib/queries/runs";

const TRIGGER_LABEL: Record<string, string> = { manual: "Manuel", scheduled: "Programmé" };

const STATUS_STYLE: Record<PipelineStatus, string> = {
  running: "text-[var(--status-in-review)]",
  success: "text-[var(--status-approved)]",
  partial: "text-[var(--status-pending)]",
  failed: "text-[var(--status-error)]",
};

export type RunRow = {
  id: string;
  startedAt: Date | string;
  triggeredBy: string;
  feedsRead: number;
  newItems: number;
  status: PipelineStatus;
  failedSteps: number;
};

export function RunsView({ runs }: { runs: RunRow[] }) {
  const router = useRouter();
  const [openRunId, setOpenRunId] = useState<string | null>(null);
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [isPending, startTransition] = useTransition();

  const hasRunning = runs.some((r) => r.status === "running");

  // Auto-refresh while a run is in flight so the list (and thus the auto-refresh condition
  // itself) picks up the eventual success/failed/partial transition without a manual reload.
  // router.refresh() re-runs the RSC page query, which produces a fresh `runs` prop — no interval
  // is scheduled once nothing is running, so this settles on its own once the run finishes.
  useEffect(() => {
    if (!hasRunning) return;
    const t = setInterval(() => router.refresh(), 4000);
    return () => clearInterval(t);
  }, [hasRunning, router]);

  function handleRowClick(id: string) {
    setOpenRunId(id);
    // Clear any previously-fetched run's detail BEFORE the new fetch resolves, so the sheet
    // renders a clean skeleton (loading=true, run=null) instead of the previous row's summary
    // while the new one is in flight — carried forward from the Task 3 review note.
    setDetail(null);
    startTransition(async () => {
      const d = await getRunDetailAction(id);
      setDetail(d);
    });
  }

  function closeDrawer() {
    setOpenRunId(null);
    setDetail(null);
  }

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
                  <TableHead>Statut</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {runs.map((r) => (
                  <TableRow
                    key={r.id}
                    onClick={() => handleRowClick(r.id)}
                    className="cursor-pointer hover:bg-muted/50"
                  >
                    <TableCell>{formatDate(r.startedAt)}</TableCell>
                    <TableCell>{TRIGGER_LABEL[r.triggeredBy] ?? r.triggeredBy}</TableCell>
                    <TableCell className="text-right">{r.feedsRead}</TableCell>
                    <TableCell className="text-right">{r.newItems}</TableCell>
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

      <RunDetailSheet
        open={openRunId !== null}
        run={detail}
        loading={isPending}
        onOpenChange={(o) => !o && closeDrawer()}
      />
    </div>
  );
}

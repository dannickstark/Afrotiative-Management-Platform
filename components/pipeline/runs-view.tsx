"use client";
import { useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { LiveRunPanel } from "@/components/pipeline/live-run-panel";
import { RunDetailSheet } from "@/components/pipeline/run-detail-sheet";
import { formatDate, pipelineStatusLabel, type PipelineStatus } from "@/lib/format";
import { getRunDetailAction } from "@/lib/actions/pipeline-actions";
import type { RunDetail, ActiveRun } from "@/lib/queries/runs";

const TRIGGER_LABEL: Record<string, string> = { manual: "Manuel", scheduled: "Programmé" };

const STATUS_STYLE: Record<PipelineStatus, string> = {
  running: "text-[var(--status-in-review)]",
  success: "text-[var(--status-approved)]",
  partial: "text-[var(--status-pending)]",
  failed: "text-[var(--status-error)]",
  // SP5: cancelled (Stop) / paused (Pause) — button wiring lives in live-run-panel.tsx (Task 5).
  cancelled: "text-[var(--status-rejected)]",
  paused: "text-[var(--status-draft)]",
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

export function RunsView({ runs, initialActive }: { runs: RunRow[]; initialActive: ActiveRun | null }) {
  const [openRunId, setOpenRunId] = useState<string | null>(null);
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [isPending, startTransition] = useTransition();
  // Tracks the run whose detail we currently want displayed, so a late/out-of-order
  // getRunDetailAction resolution (open A → close → open B, A resolves after B) can be dropped
  // rather than clobbering B's detail. Set to null on close so a resolution after close can't
  // repopulate a dismissed drawer.
  const latestReq = useRef<string | null>(null);

  function handleRowClick(id: string) {
    latestReq.current = id;
    setOpenRunId(id);
    // Clear any previously-fetched run's detail BEFORE the new fetch resolves, so the sheet
    // renders a clean skeleton (loading=true, run=null) instead of the previous row's summary
    // while the new one is in flight — carried forward from the Task 3 review note.
    setDetail(null);
    startTransition(async () => {
      try {
        const d = await getRunDetailAction(id);
        // Ignore a stale resolution: only apply if this is still the run the user wants shown.
        if (latestReq.current === id) setDetail(d);
      } catch {
        if (latestReq.current === id) {
          toast.error("Impossible de charger le détail de l'exécution.");
          closeDrawer();
        }
      }
    });
  }

  function closeDrawer() {
    latestReq.current = null;
    setOpenRunId(null);
    setDetail(null);
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Exécutions du pipeline</h1>
      </div>

      <LiveRunPanel initialActive={initialActive} lastRun={runs[0] ?? null} />

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

"use client";
import { useMemo, useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { LiveRunPanel } from "@/components/pipeline/live-run-panel";
import { RunDetailSheet } from "@/components/pipeline/run-detail-sheet";
import { RunTrends } from "@/components/pipeline/run-trends";
import { PageHeader } from "@/components/shell/page-header";
import {
  formatDate, formatRunDuration, pipelineStatusLabel, PIPELINE_STATUS_LABEL, type PipelineStatus,
} from "@/lib/format";
import { getRunDetailAction } from "@/lib/actions/pipeline-actions";
import { filterRuns } from "@/lib/queries/runs-filter";
import type { RunDetail, ActiveRun, RunTrendsSummary, TrendDay } from "@/lib/queries/runs";

// SP7: "reprocess" (a single failed item relaunched from the run-detail drawer, see
// lib/actions/pipeline-actions.ts's reprocessRawItem) previously fell through to the bare DB value
// here — added so the trigger column/filter both read a proper French label for it too.
const TRIGGER_LABEL: Record<string, string> = { manual: "Manuel", scheduled: "Programmé", reprocess: "Retraitement" };
const TRIGGER_OPTIONS = ["manual", "scheduled", "reprocess"] as const;
const STATUS_OPTIONS: PipelineStatus[] = ["success", "partial", "failed", "cancelled", "running", "paused"];

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
  finishedAt: Date | string | null;
  triggeredBy: string;
  feedsRead: number;
  newItems: number;
  status: PipelineStatus;
  failedSteps: number;
};

export function RunsView({
  runs, initialActive, trends,
}: {
  runs: RunRow[];
  initialActive: ActiveRun | null;
  trends: { perDay: TrendDay[]; summary: RunTrendsSummary };
}) {
  const [openRunId, setOpenRunId] = useState<string | null>(null);
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [isPending, startTransition] = useTransition();
  const [statusFilter, setStatusFilter] = useState("all");
  const [triggerFilter, setTriggerFilter] = useState("all");
  const filteredRuns = useMemo(
    () => filterRuns(runs, { status: statusFilter, trigger: triggerFilter }),
    [runs, statusFilter, triggerFilter],
  );
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
    <div className="space-y-6">
      <PageHeader title="Exécutions du pipeline" />

      <LiveRunPanel initialActive={initialActive} lastRun={runs[0] ?? null} />

      <RunTrends perDay={trends.perDay} summary={trends.summary} />

      <Card>
        <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <CardTitle className="text-base">Dernières exécutions</CardTitle>
          <div className="flex flex-wrap items-center gap-2">
            <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v ?? "all")}>
              <SelectTrigger className="w-40" size="sm">
                <SelectValue placeholder="Statut">
                  {(v: string) => (v && v !== "all" ? pipelineStatusLabel(v as PipelineStatus) : "Tous les statuts")}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Tous les statuts</SelectItem>
                {STATUS_OPTIONS.map((s) => (
                  <SelectItem key={s} value={s}>{PIPELINE_STATUS_LABEL[s]}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={triggerFilter} onValueChange={(v) => setTriggerFilter(v ?? "all")}>
              <SelectTrigger className="w-44" size="sm">
                <SelectValue placeholder="Déclencheur">
                  {(v: string) => (v && v !== "all" ? (TRIGGER_LABEL[v] ?? v) : "Tous les déclencheurs")}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Tous les déclencheurs</SelectItem>
                {TRIGGER_OPTIONS.map((t) => (
                  <SelectItem key={t} value={t}>{TRIGGER_LABEL[t]}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardHeader>
        <CardContent>
          {runs.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted-foreground">Aucune exécution pour l&apos;instant.</p>
          ) : filteredRuns.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted-foreground">Aucune exécution ne correspond à ces filtres.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Horodatage</TableHead>
                  <TableHead>Déclencheur</TableHead>
                  <TableHead className="text-right">Flux lus</TableHead>
                  <TableHead className="text-right">Nouveaux</TableHead>
                  <TableHead>Durée</TableHead>
                  <TableHead>Statut</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredRuns.map((r) => (
                  <TableRow
                    key={r.id}
                    onClick={() => handleRowClick(r.id)}
                    className="cursor-pointer hover:bg-muted/50"
                  >
                    <TableCell>{formatDate(r.startedAt)}</TableCell>
                    <TableCell>{TRIGGER_LABEL[r.triggeredBy] ?? r.triggeredBy}</TableCell>
                    <TableCell className="text-right">{r.feedsRead}</TableCell>
                    <TableCell className="text-right">{r.newItems}</TableCell>
                    <TableCell>{formatRunDuration(r.startedAt, r.finishedAt, r.status)}</TableCell>
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

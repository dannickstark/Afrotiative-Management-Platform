"use client";
import { useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import type { ColumnFiltersState } from "@tanstack/react-table";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DataTable } from "@/components/ui/data-table";
import { DataTableToolbar } from "@/components/ui/data-table-toolbar";
import { LiveRunPanel } from "@/components/pipeline/live-run-panel";
import { RunDetailSheet } from "@/components/pipeline/run-detail-sheet";
import { RunTrends } from "@/components/pipeline/run-trends";
import { PageHeader } from "@/components/shell/page-header";
import { EmptyState } from "@/components/shell/empty-state";
import { pipelineStatusLabel, PIPELINE_STATUS_LABEL, type PipelineStatus } from "@/lib/format";
import { getRunDetailAction } from "@/lib/actions/pipeline-actions";
import type { RunDetail, ActiveRun, RunTrendsSummary, TrendDay } from "@/lib/queries/runs";
import { runsColumns, TRIGGER_LABEL, TRIGGER_OPTIONS, STATUS_OPTIONS } from "@/components/pipeline/runs-columns";

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
  // B4: status/trigger facet filters are now TanStack column filters (matched by runs-columns.tsx's
  // `equalsFilter`) instead of the old useState+filterRuns useMemo pair — DataTable (client mode,
  // components/ui/data-table.tsx) runs getFilteredRowModel()/getSortedRowModel() over `runs`
  // directly. A column only carries an entry here while its Select is off "Tous les …".
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([]);
  const [globalFilter, setGlobalFilter] = useState("");
  const statusFilter = (columnFilters.find((f) => f.id === "status")?.value as string | undefined) ?? "all";
  const triggerFilter = (columnFilters.find((f) => f.id === "trigger")?.value as string | undefined) ?? "all";
  function setFacetFilter(id: "status" | "trigger", value: string) {
    setColumnFilters((prev) => {
      const rest = prev.filter((f) => f.id !== id);
      return value === "all" ? rest : [...rest, { id, value }];
    });
  }
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
        <CardHeader>
          <CardTitle className="text-base">Dernières exécutions</CardTitle>
        </CardHeader>
        <CardContent>
          {runs.length === 0 ? (
            <EmptyState
              title="Aucune exécution pour l'instant"
              hint="Les exécutions du pipeline apparaîtront ici une fois lancées."
            />
          ) : (
            <DataTable
              columns={runsColumns}
              data={runs}
              onRowClick={(r) => handleRowClick(r.id)}
              globalFilter={globalFilter}
              onGlobalFilterChange={setGlobalFilter}
              columnFilters={columnFilters}
              onColumnFiltersChange={setColumnFilters}
              emptyMessage="Aucune exécution ne correspond à ces filtres. Essayez d'élargir vos filtres de statut ou de déclencheur."
              toolbar={
                <DataTableToolbar
                  globalValue={globalFilter}
                  onGlobalChange={setGlobalFilter}
                  searchPlaceholder="Rechercher une exécution…"
                >
                  <Select value={statusFilter} onValueChange={(v) => setFacetFilter("status", v ?? "all")}>
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
                  <Select value={triggerFilter} onValueChange={(v) => setFacetFilter("trigger", v ?? "all")}>
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
                </DataTableToolbar>
              }
            />
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

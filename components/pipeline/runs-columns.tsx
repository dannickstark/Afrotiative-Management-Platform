"use client";
import type { ColumnDef, FilterFn } from "@tanstack/react-table";
import { DataTableColumnHeader } from "@/components/ui/data-table-column-header";
import {
  formatDate, formatRunDuration, pipelineStatusLabel, type PipelineStatus,
} from "@/lib/format";
import type { RunRow } from "./runs-view";

// B4: French labels for the `triggered_by` DB values — lifted verbatim from the old hand-rolled
// runs-view.tsx table. Exported (not local) so the toolbar's trigger facet Select (runs-view.tsx)
// renders the identical label as this column's cell, instead of drifting into two copies.
// SP7 note carried forward: "reprocess" (a single failed item relaunched from the run-detail
// drawer, see lib/actions/pipeline-actions.ts's reprocessRawItem) needs a proper French label too.
export const TRIGGER_LABEL: Record<string, string> = { manual: "Manuel", scheduled: "Programmé", reprocess: "Retraitement" };
export const TRIGGER_OPTIONS = ["manual", "scheduled", "reprocess"] as const;
export const STATUS_OPTIONS: PipelineStatus[] = ["success", "partial", "failed", "cancelled", "running", "paused"];

export const STATUS_STYLE: Record<PipelineStatus, string> = {
  running: "text-[var(--status-in-review)]",
  success: "text-[var(--status-approved)]",
  partial: "text-[var(--status-pending)]",
  failed: "text-[var(--status-error)]",
  // SP5: cancelled (Stop) / paused (Pause) — button wiring lives in live-run-panel.tsx (Task 5).
  cancelled: "text-[var(--status-rejected)]",
  paused: "text-[var(--status-draft)]",
};

// Pure sort key for the Duration column: TanStack sorts numerically off this while the cell still
// DISPLAYS formatRunDuration's formatted string (unchanged from the old table). An unfinished run
// (still running/paused, finishedAt === null) has no real duration yet — sort it to
// Number.POSITIVE_INFINITY so in-flight runs consistently group at the "longest" end regardless of
// sort direction, rather than comparing as 0/NaN against finished runs' real millisecond durations.
// Exported + unit-tested (tests/runs-columns.test.ts) per this task's TDD note: this is the one bit
// of non-trivial logic introduced by the column (formatRunDuration/formatDate/pipelineStatusLabel
// already exist and are reused as-is).
export function runDurationMs(startedAt: Date | string, finishedAt: Date | string | null): number {
  if (!finishedAt) return Number.POSITIVE_INFINITY;
  return Math.max(0, new Date(finishedAt).getTime() - new Date(startedAt).getTime());
}

// Exact-match facet filter shared by the trigger/status columns. The toolbar's Selects only ever
// push a `{id, value}` entry into `columnFilters` while NOT on "Tous les …" (runs-view.tsx's
// setColumnFilter), so this never needs to special-case an "all" sentinel itself.
const equalsFilter: FilterFn<RunRow> = (row, columnId, filterValue) => row.getValue(columnId) === filterValue;

export const runsColumns: ColumnDef<RunRow>[] = [
  {
    accessorKey: "startedAt", id: "startedAt",
    header: ({ column }) => <DataTableColumnHeader column={column} title="Horodatage" />,
    cell: ({ getValue }) => formatDate(getValue() as Date | string),
  },
  {
    accessorKey: "triggeredBy", id: "trigger",
    header: ({ column }) => <DataTableColumnHeader column={column} title="Déclencheur" />,
    cell: ({ getValue }) => {
      const v = getValue() as string;
      return TRIGGER_LABEL[v] ?? v;
    },
    filterFn: equalsFilter,
  },
  {
    accessorKey: "feedsRead", id: "feedsRead",
    header: ({ column }) => <DataTableColumnHeader column={column} title="Flux lus" />,
    cell: ({ getValue }) => <span className="block text-right">{getValue() as number}</span>,
  },
  {
    accessorKey: "newItems", id: "newItems",
    header: ({ column }) => <DataTableColumnHeader column={column} title="Nouveaux" />,
    cell: ({ getValue }) => <span className="block text-right">{getValue() as number}</span>,
  },
  {
    id: "duration",
    accessorFn: (row) => runDurationMs(row.startedAt, row.finishedAt),
    header: ({ column }) => <DataTableColumnHeader column={column} title="Durée" />,
    cell: ({ row }) => formatRunDuration(row.original.startedAt, row.original.finishedAt, row.original.status),
  },
  {
    accessorKey: "status", id: "status",
    header: ({ column }) => <DataTableColumnHeader column={column} title="Statut" />,
    cell: ({ row }) => {
      const r = row.original;
      return (
        <>
          <span className={STATUS_STYLE[r.status]}>{pipelineStatusLabel(r.status)}</span>
          {r.failedSteps > 0 && (
            <span className="ml-2 text-xs text-[var(--status-error)]">
              ({r.failedSteps} étape{r.failedSteps > 1 ? "s" : ""} en échec)
            </span>
          )}
        </>
      );
    },
    filterFn: equalsFilter,
  },
];

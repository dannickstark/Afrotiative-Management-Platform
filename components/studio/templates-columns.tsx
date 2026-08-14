"use client";
import Link from "next/link";
import type { ColumnDef } from "@tanstack/react-table";
import { DataTableColumnHeader } from "@/components/ui/data-table-column-header";
import {
  CONTEXT_LABEL, StateBadge, TemplateRowMenu, dateFormatter, formatLabel,
} from "@/components/studio/templates-shared";
import { CHANNEL_LABELS, type Channel } from "@/lib/studio/tokens";
import type { TemplateRow } from "@/lib/queries/studio";

// B8: moved verbatim from the old hand-rolled per-context list-view row in templates-table.tsx —
// scope displayed: channel, category, both, or "Défaut" if neither, exactly as before. A channel
// unknown to CHANNEL_LABELS (e.g. a synthetic "test-*" value injected by a test suite) renders
// as-is: render_templates.channel is free text in the DB (db/schema.ts), not an enum — hence the
// cast (not a guarantee) on the lookup below. Exported + unit-tested (tests/templates-columns.test.ts)
// per this task's TDD note — the one non-trivial cell in this file; the others either pass an
// accessor straight through or reuse existing, already-tested helpers from templates-shared.tsx.
export function scopeLabel(row: Pick<TemplateRow, "channel" | "categoryName">): string {
  const channel = row.channel ? (CHANNEL_LABELS[row.channel as Channel] ?? row.channel) : null;
  const parts = [channel, row.categoryName].filter((v): v is string => Boolean(v));
  return parts.length > 0 ? parts.join(" · ") : "Défaut";
}

// Pure sort key for the "Modifié" column: TanStack sorts numerically off this while the cell still
// DISPLAYS templates-shared.tsx's existing dateFormatter, unchanged from the old table.
// TemplateRow.updatedAt (lib/queries/studio.ts) is never null — kept for consistency with
// feedLastFetchSortValue/runDurationMs (the equivalent date/duration sort keys in the feeds/runs
// conversions) rather than relying on TanStack's own type-sniffed default sortingFn.
export function templateUpdatedAtSortValue(d: Date | string): number {
  return new Date(d).getTime();
}

// Factory (not a static array like the old runsColumns) because the actions column needs the three
// row-menu callbacks plus `isPending`, all owned by TemplatesTable's own state/transition — same
// reasoning as feeds-columns.tsx's feedsColumns(onEdit).
export function templatesColumns({
  isPending, onDuplicate, onArchiveToggle, onRequestRename,
}: {
  isPending: boolean;
  onDuplicate: (row: TemplateRow) => void;
  onArchiveToggle: (row: TemplateRow) => void;
  onRequestRename: (row: TemplateRow) => void;
}): ColumnDef<TemplateRow>[] {
  return [
    {
      accessorKey: "name", id: "name",
      header: ({ column }) => <DataTableColumnHeader column={column} title="Nom" />,
      cell: ({ row }) => (
        <Link href={`/studio/${row.original.id}`} className="font-medium hover:underline">
          {row.original.name}
        </Link>
      ),
    },
    {
      accessorKey: "context", id: "context", enableGlobalFilter: false,
      header: ({ column }) => <DataTableColumnHeader column={column} title="Contexte" />,
      cell: ({ getValue }) => CONTEXT_LABEL[getValue() as TemplateRow["context"]],
    },
    {
      id: "scope", enableSorting: false, enableGlobalFilter: false,
      accessorFn: (row) => scopeLabel(row),
      header: ({ column }) => <DataTableColumnHeader column={column} title="Portée" />,
      cell: ({ getValue }) => <span className="text-muted-foreground">{getValue() as string}</span>,
    },
    {
      id: "format", enableSorting: false, enableGlobalFilter: false,
      accessorFn: (row) => formatLabel(row),
      header: ({ column }) => <DataTableColumnHeader column={column} title="Format" />,
      cell: ({ getValue }) => <span className="text-muted-foreground">{getValue() as string}</span>,
    },
    {
      id: "state", enableSorting: false, enableGlobalFilter: false,
      header: ({ column }) => <DataTableColumnHeader column={column} title="État" />,
      cell: ({ row }) => <StateBadge row={row.original} />,
    },
    {
      id: "updatedAt", enableGlobalFilter: false,
      accessorFn: (row) => templateUpdatedAtSortValue(row.updatedAt),
      header: ({ column }) => (
        <div className="text-right"><DataTableColumnHeader column={column} title="Modifié" /></div>
      ),
      cell: ({ row }) => (
        <span className="block text-right text-muted-foreground">{dateFormatter.format(row.original.updatedAt)}</span>
      ),
    },
    {
      id: "actions", enableSorting: false, enableGlobalFilter: false,
      header: ({ column }) => (
        <div className="text-right"><DataTableColumnHeader column={column} title="Actions" /></div>
      ),
      cell: ({ row }) => (
        <div className="flex justify-end">
          <TemplateRowMenu
            row={row.original} isPending={isPending}
            onDuplicate={onDuplicate} onArchiveToggle={onArchiveToggle} onRequestRename={onRequestRename}
          />
        </div>
      ),
    },
  ];
}

"use client";
import type { ReactNode } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { DataTableColumnHeader } from "@/components/ui/data-table-column-header";
import type { Taxonomy } from "@/lib/queries/settings";

// Common shape shared with wpTags rows (only these fields are rendered). Narrowed rather than
// aliased to Taxonomy["categories"][number] directly: the studio's `color` column (db/schema.ts)
// lives only on wp_categories, not wp_tags, so the full categories row type is no longer
// structurally assignable from tags data. Moved verbatim from taxonomy-tables.tsx (B7) — this
// column factory is now the shared owner of the row shape, so both taxonomy-tables.tsx's two
// TaxonomyCard instances and this file's ColumnDef[] read the same type.
export type Row = Pick<Taxonomy["categories"][number], "id" | "wpId" | "name" | "articleCount">;

// Widened for categories ONLY — adds back the one field categories need that tags don't have.
// Deliberately NOT folded into the shared `Row` above: doing so would re-broaden it to a shape tags
// data can no longer structurally satisfy, reintroducing the exact divergence `Row` was narrowed to
// fix in V1. taxonomyColumns stays generic over `Row` so the tags call site is unaffected.
export type CategoryRow = Row & { color: string | null };

// Pure sort key for the "ID WordPress" column: TanStack sorts numerically off this while the cell
// still DISPLAYS the raw wpId (or "—" when absent), unchanged from the old hand-rolled table.
// wp_categories.wp_id / wp_tags.wp_id are nullable integer columns (db/schema.ts) — a row with no
// wpId yet sorts to Number.NEGATIVE_INFINITY, consistently grouping at the "lowest" end regardless
// of sort direction, mirroring feeds-columns.tsx's feedLastFetchSortValue for the same reason.
// Exported + unit-tested (tests/taxonomy-columns.test.ts) per this task's TDD note.
export function taxonomyWpIdSortValue(wpId: number | null): number {
  return wpId === null ? Number.NEGATIVE_INFINITY : wpId;
}

// ONE factory reused for BOTH the "Catégories" and "Tags" tables (taxonomy-tables.tsx) — the shared
// Nom/ID WordPress/Articles columns are identical for both taxonomies; `extraColumn` is the single,
// minimal parametrization point for categories' "Couleur" column, which tags don't have (mirrors
// TaxonomyCard's existing `extraColumn` prop, just moved down into the column definitions
// themselves).
export function taxonomyColumns<R extends Row>(
  extraColumn?: { id: string; header: string; render: (row: R) => ReactNode },
): ColumnDef<R>[] {
  const columns: ColumnDef<R>[] = [
    {
      accessorKey: "name", id: "name",
      header: ({ column }) => <DataTableColumnHeader column={column} title="Nom" />,
      cell: ({ getValue }) => <span className="font-medium">{getValue() as string}</span>,
    },
    {
      id: "wpId",
      accessorFn: (row) => taxonomyWpIdSortValue(row.wpId),
      header: ({ column }) => <DataTableColumnHeader column={column} title="ID WordPress" />,
      cell: ({ row }) => <span className="text-muted-foreground">{row.original.wpId ?? "—"}</span>,
      enableGlobalFilter: false,
    },
  ];

  if (extraColumn) {
    columns.push({
      id: extraColumn.id, enableSorting: false, enableGlobalFilter: false,
      header: ({ column }) => <DataTableColumnHeader column={column} title={extraColumn.header} />,
      cell: ({ row }) => extraColumn.render(row.original),
    });
  }

  columns.push({
    accessorKey: "articleCount", id: "articleCount", enableGlobalFilter: false,
    header: ({ column }) => (
      <div className="text-right"><DataTableColumnHeader column={column} title="Articles" /></div>
    ),
    cell: ({ getValue }) => <span className="block text-right">{getValue() as number}</span>,
  });

  return columns;
}

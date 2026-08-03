"use client";
import type { ColumnDef } from "@tanstack/react-table";
import { ImageOff } from "lucide-react";
import type { QueueRow } from "@/lib/queries/queue";
import { StatusBadge } from "@/components/status-badge";
import { ConfidenceBadge } from "./confidence-badge";
import { RowActions } from "./row-actions";
import { relativeDate, type ArticleStatus } from "@/lib/format";

// Bucketed "source count" filter used by queue-filters.tsx: "single" (1 or
// fewer sources — needs more scrutiny) vs "multiple" (2+ corroborating sources).
export type SourceBucket = "single" | "multiple";

export const columns: ColumnDef<QueueRow>[] = [
  { accessorKey: "title", header: "Titre", cell: ({ row }) => (
      <div className="flex items-center gap-2 max-w-[380px]">
        {row.original.low && <ConfidenceBadge />}
        <span className="truncate font-medium">{row.original.title}</span>
      </div>) },
  { id: "image", header: "Image", enableSorting: false, enableGlobalFilter: false, cell: ({ row }) => {
      const url = row.original.imageUrl;
      return url ? (
        // eslint-disable-next-line @next/next/no-img-element -- external, per-article seed URLs; no next.config remote pattern configured.
        <img src={url} alt="" className="h-10 w-16 rounded-md object-cover" />
      ) : (
        <div className="flex h-10 w-16 items-center justify-center rounded-md border border-dashed bg-muted/50">
          <ImageOff className="size-4 text-muted-foreground" />
        </div>
      );
    } },
  { accessorKey: "categoryName", header: "Catégorie", filterFn: "equalsString",
    cell: ({ getValue }) => (getValue() as string) ?? "—" },
  { accessorKey: "sourceCount", header: "Sources",
    filterFn: (row, columnId, filterValue: SourceBucket | undefined) => {
      if (!filterValue) return true;
      const count = row.getValue<number>(columnId);
      return filterValue === "single" ? count <= 1 : count > 1;
    } },
  { accessorKey: "generatedAt", header: "Généré", cell: ({ getValue }) => relativeDate(getValue() as Date) },
  { accessorKey: "status", header: "Statut", filterFn: "equalsString",
    cell: ({ getValue }) => <StatusBadge status={getValue() as ArticleStatus} /> },
  { id: "actions", enableSorting: false, enableGlobalFilter: false, cell: ({ row }) => <RowActions row={row.original} /> },
];

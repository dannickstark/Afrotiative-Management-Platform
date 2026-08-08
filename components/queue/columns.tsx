"use client";
import type { ColumnDef } from "@tanstack/react-table";
import { ImageOff } from "lucide-react";
import type { QueueRow } from "@/lib/queries/queue";
import { StatusBadge } from "@/components/status-badge";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { ConfidenceBadge } from "./confidence-badge";
import { RowActions } from "./row-actions";
import { relativeDate, type ArticleStatus } from "@/lib/format";
import { MISSING_LABEL } from "@/lib/pipeline/completeness";

export const columns: ColumnDef<QueueRow>[] = [
  { id: "select", enableSorting: false,
    header: ({ table }) => (
      <Checkbox
        checked={table.getIsAllPageRowsSelected()}
        indeterminate={table.getIsSomePageRowsSelected() && !table.getIsAllPageRowsSelected()}
        onCheckedChange={(v) => table.toggleAllPageRowsSelected(Boolean(v))}
        aria-label="Tout sélectionner"
      />
    ),
    cell: ({ row }) => (
      <Checkbox
        checked={row.getIsSelected()}
        onCheckedChange={(v) => row.toggleSelected(Boolean(v))}
        aria-label="Sélectionner cet article"
      />
    ) },
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
  { accessorKey: "categoryName", header: "Catégorie",
    cell: ({ getValue }) => (getValue() as string) ?? "—" },
  { accessorKey: "sourceCount", header: "Sources" },
  // Read-only quality signal from lib/pipeline/score.ts. Null until SP4 Task 6 wires scoring
  // into stageItem — show nothing rather than a placeholder for un-scored (pre-Task-6) articles.
  { accessorKey: "score", header: "Score", cell: ({ getValue }) => {
      const score = getValue() as number | null;
      return score === null ? null : <Badge variant="outline">Score {score}</Badge>;
    } },
  { accessorKey: "generatedAt", header: "Généré", cell: ({ getValue }) => relativeDate(getValue() as Date) },
  { accessorKey: "status", header: "Statut",
    cell: ({ getValue }) => <StatusBadge status={getValue() as ArticleStatus} /> },
  { id: "missing", header: "Complétude", enableSorting: false, cell: ({ row }) => {
      const missing = row.original.missingFields;
      if (missing.length === 0) return <span className="text-muted-foreground">—</span>;
      return (
        <Badge variant="outline" className="border-amber-500/50 text-amber-700 dark:text-amber-400"
          title={missing.map((m) => MISSING_LABEL[m]).join(", ")}>
          {missing.length} manque{missing.length > 1 ? "s" : ""}
        </Badge>
      );
    } },
  { id: "actions", enableSorting: false, enableGlobalFilter: false, cell: ({ row }) => <RowActions row={row.original} /> },
];

"use client";
import type { ColumnDef } from "@tanstack/react-table";
import { ImageOff } from "lucide-react";
import type { QueueRow } from "@/lib/queries/queue";
import { StatusBadge } from "@/components/status-badge";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { DataTableColumnHeader } from "@/components/ui/data-table-column-header";
import { ConfidenceBadge } from "./confidence-badge";
import { RowActions } from "./row-actions";
import { FixPopover } from "./fix-popover";
import { relativeDate, type ArticleStatus } from "@/lib/format";

// Fabrique (et non un tableau statique) : la colonne « Complétude » rend désormais <FixPopover>,
// qui a besoin de la liste des catégories pour son sélecteur — thread depuis QueueView →
// QueueTable → buildColumns.
export function buildColumns(categories: { id: string; name: string }[]): ColumnDef<QueueRow>[] {
  return [
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
    { accessorKey: "title", header: ({ column }) => <DataTableColumnHeader column={column} title="Titre" />,
      cell: ({ row }) => (
        <div className="flex items-center gap-2 max-w-[380px]">
          {row.original.low && <ConfidenceBadge />}
          <span className="truncate font-medium">{row.original.title}</span>
        </div>) },
    { id: "image", header: "Image", enableSorting: false, enableGlobalFilter: false, cell: ({ row }) => {
        const url = row.original.imageUrl;
        return (
          <div className="flex items-center gap-2">
            {url ? (
              // eslint-disable-next-line @next/next/no-img-element -- external, per-article seed URLs; no next.config remote pattern configured.
              <img src={url} alt="" className="h-10 w-16 rounded-md object-cover" />
            ) : (
              <div className="flex h-10 w-16 items-center justify-center rounded-md border border-dashed bg-muted/50">
                <ImageOff className="size-4 text-muted-foreground" />
              </div>
            )}
            {row.original.pendingImageCount > 0 && (
              <Badge variant="secondary" title="Une régénération a trouvé des images candidates en attente de votre choix">
                {row.original.pendingImageCount} à choisir
              </Badge>
            )}
          </div>
        );
      } },
    // `id` explicite : le nom de colonne dans l'URL (?sort=category|date|source, cf. QueueSortCol
    // dans lib/queries/queue-sort.ts) ne correspond pas toujours à l'accessorKey des données.
    { accessorKey: "categoryName", id: "category",
      header: ({ column }) => <DataTableColumnHeader column={column} title="Catégorie" />,
      cell: ({ getValue }) => (getValue() as string) ?? "—" },
    { accessorKey: "sourceCount", id: "source",
      header: ({ column }) => <DataTableColumnHeader column={column} title="Sources" /> },
    // Read-only quality signal from lib/pipeline/score.ts. Null until SP4 Task 6 wires scoring
    // into stageItem — show nothing rather than a placeholder for un-scored (pre-Task-6) articles.
    { accessorKey: "score", header: ({ column }) => <DataTableColumnHeader column={column} title="Score" />,
      cell: ({ getValue }) => {
        const score = getValue() as number | null;
        return score === null ? null : <Badge variant="outline">Score {score}</Badge>;
      } },
    { accessorKey: "generatedAt", id: "date",
      header: ({ column }) => <DataTableColumnHeader column={column} title="Généré" />,
      cell: ({ getValue }) => relativeDate(getValue() as Date) },
    { accessorKey: "status", header: ({ column }) => <DataTableColumnHeader column={column} title="Statut" />,
      cell: ({ getValue }) => <StatusBadge status={getValue() as ArticleStatus} /> },
    // Rend désormais un correctif interactif (FixPopover), pas seulement un badge inerte : cliquer
    // le décompte ouvre le formulaire de correction ciblée sur les champs réellement manquants.
    { id: "missing", header: "Complétude", enableSorting: false,
      cell: ({ row }) => <FixPopover row={row.original} categories={categories} /> },
    { id: "actions", enableSorting: false, enableGlobalFilter: false, cell: ({ row }) => <RowActions row={row.original} /> },
  ];
}

"use client";
import Link from "next/link";
import type { ColumnDef } from "@tanstack/react-table";
import { ExternalLink } from "lucide-react";
import type { PublishedRow } from "@/lib/queries/published";
import { Badge } from "@/components/ui/badge";
import { DataTableColumnHeader } from "@/components/ui/data-table-column-header";
import { formatDate } from "@/lib/format";

// `id` explicit on every sortable column: the URL column name (?sort=title|category|publishedAt|
// author, cf. PublishedSortCol in lib/queries/published-sort.ts) must match exactly, and doesn't
// always equal the data's accessorKey (categoryName → "category", aiAuthor → "author"). Mirrors
// components/queue/columns.tsx.
export const publishedColumns: ColumnDef<PublishedRow>[] = [
  { accessorKey: "title", id: "title",
    header: ({ column }) => <DataTableColumnHeader column={column} title="Article" />,
    cell: ({ row }) => (
      <Link href={`/article/${row.original.id}`} className="flex items-center gap-3 hover:underline">
        {row.original.imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- external, per-article seed URLs; no next.config remote pattern configured.
          <img src={row.original.imageUrl} alt="" className="size-10 shrink-0 rounded object-cover" />
        ) : (
          <div className="size-10 shrink-0 rounded bg-muted" />
        )}
        <span className="line-clamp-2 font-medium">{row.original.title}</span>
      </Link>
    ) },
  { accessorKey: "categoryName", id: "category",
    header: ({ column }) => <DataTableColumnHeader column={column} title="Catégorie" />,
    cell: ({ getValue }) => (getValue() as string | null) ?? "—" },
  { accessorKey: "publishedAt", id: "publishedAt",
    header: ({ column }) => <DataTableColumnHeader column={column} title="Publié le" />,
    cell: ({ getValue }) => <span className="whitespace-nowrap">{formatDate(getValue() as Date)}</span> },
  { accessorKey: "aiAuthor", id: "author",
    header: ({ column }) => <DataTableColumnHeader column={column} title="Auteur" />,
    cell: ({ getValue }) => <Badge variant="outline">{(getValue() as boolean) ? "IA" : "Humain"}</Badge> },
  { id: "wp", enableSorting: false, header: () => <span className="block text-right">WordPress</span>,
    cell: ({ row }) => (
      <div className="text-right">
        {row.original.wpUrl ? (
          <a href={row.original.wpUrl} target="_blank" rel="noopener noreferrer"
             className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground">
            Voir <ExternalLink className="size-3.5" />
          </a>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </div>
    ) },
];

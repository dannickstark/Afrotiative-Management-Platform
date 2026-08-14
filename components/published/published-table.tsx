"use client";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import type { SortingState, OnChangeFn } from "@tanstack/react-table";
import { DataTable } from "@/components/ui/data-table";
import { publishedColumns } from "./columns";
import type { PublishedRow, PublishedSortCol } from "@/lib/queries/published";

export function PublishedTable({
  rows, filtered, sort,
}: {
  rows: PublishedRow[];
  filtered: boolean;
  // Server-resolved sort (lib/queries/published.ts::resolvePublishedSort) — always defined, even
  // without `?sort` in the URL (falls back to the previous default). Reflected as-is in the
  // header indicator: the order shown in "Publié le" on first load IS the actual sort.
  sort: { column: PublishedSortCol; direction: "asc" | "desc" };
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const sorting: SortingState = [{ id: sort.column, desc: sort.direction === "desc" }];

  // manualSorting: DataTableColumnHeader already computes the next state (asc → desc → no sort,
  // via nextSortDir) through column.toggleSorting()/clearSorting() — this handler only translates
  // the resulting state into `?sort=`/`?dir=` on the URL, which re-triggers getPublishedArticles
  // server-side. Every OTHER param (search, category, dates, author, page) is preserved as-is.
  const onSortingChange: OnChangeFn<SortingState> = (updater) => {
    const next = typeof updater === "function" ? updater(sorting) : updater;
    const p = new URLSearchParams(searchParams.toString());
    const active = next[0];
    if (!active) {
      p.delete("sort");
      p.delete("dir");
    } else {
      p.set("sort", active.id);
      p.set("dir", active.desc ? "desc" : "asc");
    }
    router.push(`${pathname}?${p.toString()}`);
  };

  return (
    <DataTable
      columns={publishedColumns}
      data={rows}
      manualSorting
      sorting={sorting}
      onSortingChange={onSortingChange}
      emptyMessage={filtered ? "Aucun résultat pour ces filtres." : "Aucun article publié pour l'instant."}
    />
  );
}

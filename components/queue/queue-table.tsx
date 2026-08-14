"use client";
import { useEffect, useState } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import {
  flexRender, getCoreRowModel, useReactTable, type RowSelectionState,
  type SortingState, type OnChangeFn,
} from "@tanstack/react-table";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { buildColumns } from "./columns";
import { BulkActionBar } from "./bulk-action-bar";
import type { QueueRow, QueueSortCol } from "@/lib/queries/queue";

function ariaSort(state: false | "asc" | "desc"): "ascending" | "descending" | "none" {
  return state === "asc" ? "ascending" : state === "desc" ? "descending" : "none";
}

export function QueueTable({
  rows, categories, sort,
}: {
  rows: QueueRow[];
  categories: { id: string; name: string }[];
  // Tri résolu côté serveur (lib/queries/queue.ts::resolveQueueSort) — toujours défini, même
  // sans `?sort` dans l'URL (repli sur le tri par défaut). Reflété tel quel dans l'indicateur
  // d'en-tête : l'ordre affiché dans la colonne « Généré » au premier chargement EST le tri réel.
  sort: { column: QueueSortCol; direction: "asc" | "desc" };
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
  const cols = buildColumns(categories);

  const sorting: SortingState = [{ id: sort.column, desc: sort.direction === "desc" }];

  // manualSorting : DataTableColumnHeader calcule déjà le prochain état (asc → desc → aucun tri,
  // via nextSortDir) à travers column.toggleSorting()/clearSorting() — ce handler ne fait que
  // traduire l'état résultant en `?sort=`/`?dir=` sur l'URL, qui redéclenche getQueue côté
  // serveur. Tous les AUTRES paramètres (statut, recherche, catégorie, source, page) sont
  // préservés tels quels.
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

  const table = useReactTable({
    data: rows,
    columns: cols,
    state: { rowSelection, sorting },
    manualSorting: true,
    onSortingChange,
    onRowSelectionChange: setRowSelection,
    getRowId: (row) => row.id, // l'identifiant d'article EST la clé de sélection
    getCoreRowModel: getCoreRowModel(),
  });
  const model = table.getRowModel().rows;

  // Toute nouvelle page de données (changement de filtre, de tri ou de page) vide la sélection :
  // agir en lot sur des lignes qu'on ne voit plus serait dangereux.
  useEffect(() => { setRowSelection({}); }, [rows]);

  const selectedIds = Object.keys(rowSelection).filter((id) => rowSelection[id]);
  const selectedRows = rows.filter((r) => selectedIds.includes(r.id));

  return (
    <>
      <div className="overflow-x-auto rounded-lg border">
        <Table>
          <TableHeader>
            {table.getHeaderGroups().map((hg) => (
              <TableRow key={hg.id}>
                {hg.headers.map((h) => (
                  <TableHead
                    key={h.id}
                    aria-sort={h.column.getCanSort() ? ariaSort(h.column.getIsSorted()) : undefined}
                  >
                    {h.isPlaceholder ? null : flexRender(h.column.columnDef.header, h.getContext())}
                  </TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {model.length ? (
              model.map((row) => (
                <TableRow key={row.id}>
                  {row.getVisibleCells().map((cell) => (
                    <TableCell key={cell.id}>
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell colSpan={cols.length} className="h-24 text-center text-muted-foreground">
                  Aucun article ne correspond à ces filtres.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
      <BulkActionBar rows={selectedRows} onDone={() => setRowSelection({})} />
    </>
  );
}

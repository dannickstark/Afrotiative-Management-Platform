"use client";
import { useEffect, useState } from "react";
import { flexRender, getCoreRowModel, useReactTable, type RowSelectionState } from "@tanstack/react-table";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { columns } from "./columns";
import { BulkActionBar } from "./bulk-action-bar";
import type { QueueRow } from "@/lib/queries/queue";

export function QueueTable({ rows }: { rows: QueueRow[] }) {
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});

  const table = useReactTable({
    data: rows,
    columns,
    state: { rowSelection },
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
      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            {table.getHeaderGroups().map((hg) => (
              <TableRow key={hg.id}>
                {hg.headers.map((h) => (
                  <TableHead key={h.id}>
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
                <TableCell colSpan={columns.length} className="h-24 text-center text-muted-foreground">
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

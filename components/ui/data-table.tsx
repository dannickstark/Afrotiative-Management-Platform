"use client";
import { useState } from "react";
import {
  flexRender, getCoreRowModel, getSortedRowModel, getFilteredRowModel,
  useReactTable, type ColumnDef, type SortingState, type ColumnFiltersState,
  type OnChangeFn,
} from "@tanstack/react-table";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";

export type DataTableProps<T> = {
  columns: ColumnDef<T, any>[];
  data: T[];
  manualSorting?: boolean;
  sorting?: SortingState;
  onSortingChange?: OnChangeFn<SortingState>;
  globalFilter?: string;
  onGlobalFilterChange?: OnChangeFn<string>;
  columnFilters?: ColumnFiltersState;
  onColumnFiltersChange?: OnChangeFn<ColumnFiltersState>;
  onRowClick?: (row: T) => void;
  toolbar?: React.ReactNode;
  emptyMessage?: string;
};

function ariaSort(state: false | "asc" | "desc"): "ascending" | "descending" | "none" {
  return state === "asc" ? "ascending" : state === "desc" ? "descending" : "none";
}

export function DataTable<T>(p: DataTableProps<T>) {
  const [s, setS] = useState<SortingState>([]);
  const [cf, setCf] = useState<ColumnFiltersState>([]);
  const [gf, setGf] = useState("");
  const sorting = p.sorting ?? s;
  const columnFilters = p.columnFilters ?? cf;
  const globalFilter = p.globalFilter ?? gf;

  const table = useReactTable({
    data: p.data,
    columns: p.columns,
    state: { sorting, columnFilters, globalFilter },
    onSortingChange: p.onSortingChange ?? setS,
    onColumnFiltersChange: p.onColumnFiltersChange ?? setCf,
    onGlobalFilterChange: p.onGlobalFilterChange ?? setGf,
    getCoreRowModel: getCoreRowModel(),
    ...(p.manualSorting ? { manualSorting: true } : { getSortedRowModel: getSortedRowModel() }),
    getFilteredRowModel: getFilteredRowModel(),
  });

  const rows = table.getRowModel().rows;

  return (
    <>
      {p.toolbar}
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
            {rows.length ? (
              rows.map((row) => (
                <TableRow
                  key={row.id}
                  onClick={p.onRowClick ? () => p.onRowClick!(row.original) : undefined}
                  className={cn(p.onRowClick && "cursor-pointer")}
                >
                  {row.getVisibleCells().map((cell) => (
                    <TableCell key={cell.id}>
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell colSpan={p.columns.length} className="h-24 text-center text-muted-foreground">
                  {p.emptyMessage ?? "Aucun résultat."}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </>
  );
}

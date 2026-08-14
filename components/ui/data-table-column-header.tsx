"use client";
import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";
import type { Column } from "@tanstack/react-table";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { nextSortDir } from "@/components/ui/data-table-sort";

export { nextSortDir };

export function DataTableColumnHeader<TData, TValue>({
  column, title, className,
}: {
  column: Column<TData, TValue>;
  title: string;
  className?: string;
}) {
  if (!column.getCanSort()) {
    return <span className={className}>{title}</span>;
  }

  const sorted = column.getIsSorted();
  const Icon = sorted === "asc" ? ArrowUp : sorted === "desc" ? ArrowDown : ArrowUpDown;

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className={cn("-ml-2.5 h-7 gap-1 px-2.5 data-[state=open]:bg-muted", className)}
      onClick={() => {
        const d = nextSortDir(column.getIsSorted());
        if (d === false) column.clearSorting();
        else column.toggleSorting(d === "desc");
      }}
    >
      <span>{title}</span>
      <Icon className="size-3.5 text-muted-foreground" />
    </Button>
  );
}

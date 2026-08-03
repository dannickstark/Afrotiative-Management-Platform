"use client";
import { useMemo } from "react";
import type { Table } from "@tanstack/react-table";
import { Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { STATUS_LABEL, type ArticleStatus } from "@/lib/format";
import type { QueueRow } from "@/lib/queries/queue";
import type { SourceBucket } from "./columns";

const STATUS_OPTIONS: ArticleStatus[] = ["draft", "pending", "in_review", "approved", "published", "rejected"];
const SOURCE_LABEL: Record<"all" | SourceBucket, string> = {
  all: "Toutes les sources", single: "Source unique", multiple: "Sources multiples",
};

export function QueueFilters({ table, data }: { table: Table<QueueRow>; data: QueueRow[] }) {
  const categories = useMemo(
    () => Array.from(new Set(data.map((r) => r.categoryName).filter((c): c is string => Boolean(c)))).sort((a, b) => a.localeCompare(b)),
    [data],
  );

  const statusValue = (table.getColumn("status")?.getFilterValue() as string) ?? "all";
  const categoryValue = (table.getColumn("categoryName")?.getFilterValue() as string) ?? "all";
  const sourceValue = ((table.getColumn("sourceCount")?.getFilterValue() as SourceBucket | undefined) ?? "all") as "all" | SourceBucket;

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="relative w-full max-w-xs">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          placeholder="Rechercher un titre…"
          value={(table.getState().globalFilter as string) ?? ""}
          onChange={(e) => table.setGlobalFilter(e.target.value)}
          className="pl-8"
        />
      </div>

      <Select
        value={statusValue}
        onValueChange={(v) => table.getColumn("status")?.setFilterValue(v === "all" ? undefined : v)}
      >
        <SelectTrigger className="w-40">
          <SelectValue placeholder="Statut">
            {(v: string) => (v && v !== "all" ? STATUS_LABEL[v as ArticleStatus] : "Tous les statuts")}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">Tous les statuts</SelectItem>
          {STATUS_OPTIONS.map((s) => (
            <SelectItem key={s} value={s}>{STATUS_LABEL[s]}</SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select
        value={categoryValue}
        onValueChange={(v) => table.getColumn("categoryName")?.setFilterValue(v === "all" ? undefined : v)}
      >
        <SelectTrigger className="w-48">
          <SelectValue placeholder="Catégorie">
            {(v: string) => (v && v !== "all" ? v : "Toutes les catégories")}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">Toutes les catégories</SelectItem>
          {categories.map((c) => (
            <SelectItem key={c} value={c}>{c}</SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select
        value={sourceValue}
        onValueChange={(v) => table.getColumn("sourceCount")?.setFilterValue(v === "all" ? undefined : v)}
      >
        <SelectTrigger className="w-44">
          <SelectValue placeholder="Sources">{(v: "all" | SourceBucket) => SOURCE_LABEL[v] ?? SOURCE_LABEL.all}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">Toutes les sources</SelectItem>
          <SelectItem value="single">Source unique</SelectItem>
          <SelectItem value="multiple">Sources multiples</SelectItem>
        </SelectContent>
      </Select>
    </div>
  );
}

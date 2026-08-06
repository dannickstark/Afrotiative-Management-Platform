"use client";
import { useEffect, useState } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { PublishedFilters } from "@/lib/queries/published";

function ymd(d: Date | undefined): string {
  return d ? d.toISOString().slice(0, 10) : "";
}

export function PublishedFilterBar({
  filters, categories,
}: {
  filters: PublishedFilters;
  categories: { id: string; name: string }[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // Any filter change resets pagination to page 1.
  function setParams(patch: Record<string, string | undefined>) {
    const p = new URLSearchParams(searchParams.toString());
    for (const [k, v] of Object.entries(patch)) { if (v) p.set(k, v); else p.delete(k); }
    p.delete("page");
    router.push(`${pathname}?${p.toString()}`);
  }

  // Debounced title search (kept local so typing doesn't push on every keystroke).
  const [q, setQ] = useState(filters.search ?? "");
  useEffect(() => {
    const t = setTimeout(() => {
      if ((filters.search ?? "") !== q) setParams({ q: q || undefined });
    }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  return (
    <div className="flex flex-wrap items-end gap-2">
      <div className="relative w-full max-w-xs">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input placeholder="Rechercher un titre…" value={q} onChange={(e) => setQ(e.target.value)} className="pl-8" />
      </div>

      <Select value={filters.categoryId ?? "all"} onValueChange={(v) => setParams({ cat: v && v !== "all" ? v : undefined })}>
        <SelectTrigger className="w-52">
          <SelectValue placeholder="Catégorie">
            {(v: string) => (v && v !== "all" ? (categories.find((c) => c.id === v)?.name ?? "Catégorie") : "Toutes les catégories")}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">Toutes les catégories</SelectItem>
          {categories.map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
        </SelectContent>
      </Select>

      <div className="flex items-end gap-1.5">
        <div className="space-y-1">
          <Label htmlFor="pub-from" className="text-xs text-muted-foreground">Du</Label>
          <Input id="pub-from" type="date" value={ymd(filters.from)} onChange={(e) => setParams({ from: e.target.value || undefined })} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="pub-to" className="text-xs text-muted-foreground">Au</Label>
          <Input id="pub-to" type="date" value={ymd(filters.to)} onChange={(e) => setParams({ to: e.target.value || undefined })} />
        </div>
      </div>

      <Select value={filters.author ?? "all"} onValueChange={(v) => setParams({ author: v && v !== "all" ? v : undefined })}>
        <SelectTrigger className="w-36">
          <SelectValue placeholder="Auteur">
            {(v: string) => (v === "ai" ? "IA" : v === "human" ? "Humain" : "Tous les auteurs")}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">Tous les auteurs</SelectItem>
          <SelectItem value="ai">IA</SelectItem>
          <SelectItem value="human">Humain</SelectItem>
        </SelectContent>
      </Select>
    </div>
  );
}

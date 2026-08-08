"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { usePersistedFilters, QUEUE_FILTERS_KEY } from "@/hooks/use-persisted-filters";
import { STATUS_LABEL, type ArticleStatus } from "@/lib/format";
import type { QueueFilters as Filters } from "@/lib/queries/queue";

const STATUS_OPTIONS: ArticleStatus[] = [
  "pending", "in_review", "draft", "approved", "published", "rejected",
];
const SOURCE_LABEL: Record<string, string> = {
  all: "Toutes les sources", single: "Source unique", multiple: "Sources multiples",
};
const SORT_LABEL: Record<string, string> = {
  oldest: "Plus anciens d'abord", newest: "Plus récents d'abord", score: "Meilleur score",
};

export function QueueFilters({
  filters, categories,
}: {
  filters: Filters;
  categories: { id: string; name: string }[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  usePersistedFilters(QUEUE_FILTERS_KEY);

  // Maintenu à jour à chaque rendu pour qu'une poussée différée (la recherche debouncée
  // ci-dessous) fusionne sur l'URL la plus récente et non sur un instantané périmé.
  const spRef = useRef(searchParams);
  spRef.current = searchParams;

  // `status` est TOUJOURS écrit, même à sa valeur par défaut. C'est ce qui distingue « l'
  // utilisateur a remis les filtres à zéro » (URL non vide → on mémorise) de « arrivée nue sur
  // /queue depuis la barre latérale » (URL vide → on restaure). Sans cela, vider les filtres
  // rappellerait aussitôt les anciens.
  function setParams(patch: Record<string, string | undefined>) {
    const p = new URLSearchParams(spRef.current.toString());
    for (const [k, v] of Object.entries(patch)) { if (v) p.set(k, v); else p.delete(k); }
    if (!p.has("status")) p.set("status", filters.status);
    p.delete("page"); // tout changement de filtre revient en page 1
    router.push(`${pathname}?${p.toString()}`);
  }

  const [q, setQ] = useState(filters.search ?? "");
  useEffect(() => {
    const t = setTimeout(() => {
      if ((filters.search ?? "") !== q) setParams({ q: q || undefined });
    }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);
  useEffect(() => { setQ(filters.search ?? ""); }, [filters.search]);

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="relative w-full max-w-xs">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          placeholder="Rechercher un titre…" aria-label="Rechercher un titre"
          value={q} onChange={(e) => setQ(e.target.value)} className="pl-8"
        />
      </div>

      <Select value={filters.status} onValueChange={(v) => v && setParams({ status: v })}>
        <SelectTrigger className="w-44">
          <SelectValue placeholder="Statut">
            {(v: string) => (v === "all" ? "Tous les statuts" : STATUS_LABEL[v as ArticleStatus])}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          {STATUS_OPTIONS.map((s) => (
            <SelectItem key={s} value={s}>{STATUS_LABEL[s]}</SelectItem>
          ))}
          <SelectItem value="all">Tous les statuts</SelectItem>
        </SelectContent>
      </Select>

      <Select
        value={filters.categoryId ?? "all"}
        onValueChange={(v) => setParams({ cat: v && v !== "all" ? v : undefined })}
      >
        <SelectTrigger className="w-52">
          <SelectValue placeholder="Catégorie">
            {(v: string) => (v !== "all" ? (categories.find((c) => c.id === v)?.name ?? "Catégorie") : "Toutes les catégories")}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">Toutes les catégories</SelectItem>
          {categories.map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
        </SelectContent>
      </Select>

      <Select
        value={filters.source ?? "all"}
        onValueChange={(v) => setParams({ src: v && v !== "all" ? v : undefined })}
      >
        <SelectTrigger className="w-44">
          <SelectValue placeholder="Sources">{(v: string) => SOURCE_LABEL[v] ?? SOURCE_LABEL.all}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">Toutes les sources</SelectItem>
          <SelectItem value="single">Source unique</SelectItem>
          <SelectItem value="multiple">Sources multiples</SelectItem>
        </SelectContent>
      </Select>

      <Select value={filters.sort} onValueChange={(v) => v && setParams({ sort: v })}>
        <SelectTrigger className="w-52">
          <SelectValue placeholder="Tri">{(v: string) => SORT_LABEL[v] ?? SORT_LABEL.oldest}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="oldest">Plus anciens d&apos;abord</SelectItem>
          <SelectItem value="newest">Plus récents d&apos;abord</SelectItem>
          <SelectItem value="score">Meilleur score</SelectItem>
        </SelectContent>
      </Select>
    </div>
  );
}

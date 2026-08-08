# `/queue` — refonte des actions, filtres persistés, périmètre « en attente » Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Faire de `/queue` un poste de travail : périmètre « en attente » par défaut appliqué en SQL, filtres pilotés par l'URL et mémorisés dans le navigateur, sélection multiple avec actions en lot à rapport d'échec précis, aperçu en panneau latéral, et correction en ligne de ce qui bloque la publication.

**Architecture:** Les filtres passent côté serveur en paramètres d'URL, sur le modèle exact de `/published` (`lib/queries/published.ts`). TanStack React Table reste pour les colonnes, le rendu et la sélection de lignes, mais perd le filtrage, le tri et la pagination. Un hook générique mémorise la chaîne de paramètres dans `localStorage` et la restaure sur une visite nue.

**Tech Stack:** Next.js 16 (App Router, RSC + Server Actions), React 19, TanStack React Table 8, shadcn/ui sur **Base UI**, Drizzle ORM + Postgres/Neon, Bun pour les tests.

**Spec:** `docs/superpowers/specs/2026-08-08-afrotiative-queue-overhaul-design.md`

**Prérequis :** le sous-projet D (`docs/superpowers/plans/2026-08-08-afrotiative-pipeline-completeness.md`) doit être **terminé et fusionné**. Ce plan consomme `MissingField`, `MISSING_LABEL`, `BLOCKING_FIELDS`, `blockingGapsForArticle`, `checkCompleteness` et la colonne `articles.missing_fields`.

## Global Constraints

- **Base UI, pas Radix.** Aucun `asChild` : la composition passe par `render={<Element />}` (voir `components/confirm-dialog.tsx:8-13`).
- Toute chaîne visible par l'utilisateur est en **français**.
- Les tests tournent avec `bun test`, sans réseau ni clé d'API. Les fonctions pures sont testées directement ; les actions serveur le sont contre la vraie base Neon de dev, comme `tests/queue-actions.test.ts` aujourd'hui.
- **Une seule définition de « bloquant »** : `BLOCKING_FIELDS` / `blockingGapsForArticle` de `lib/pipeline/completeness.ts`. Ne jamais réécrire ces règles ici.
- RBAC : `article:publish` pour approuver, `article:reject` pour rejeter, `article:edit` pour corriger. Les gardes passent par `requirePermission`, jamais par un test de rôle en dur.
- Toute mutation d'article écrit une ligne `article_revisions`.
- Le fichier `AGENTS.md` est réécrit par `next dev` ; s'il apparaît modifié, le committer avec le travail.

**Simplification par rapport à la spec :** la spec prévoyait un `getQueueFacets()` dédié pour alimenter le sélecteur de catégories. Ce plan réutilise `getTaxonomy()` de `lib/queries/settings.ts`, exactement comme `app/(app)/published/page.tsx` — même liste, une requête de moins, un module de moins.

---

### Task 1 : Couche de requête pilotée par l'URL

**Files:**
- Modify: `lib/queries/queue.ts` (réécriture)
- Test: `tests/queue-queries.test.ts` (créer)

**Interfaces:**
- Consumes: `sortMissingFields`, `MissingField` (sous-projet D)
- Produces:
  - `QUEUE_PAGE_SIZE = 25`
  - `type QueueStatusFilter = ArticleStatus | "all"`
  - `type QueueSort = "oldest" | "newest" | "score"`
  - `type QueueFilters = { status: QueueStatusFilter; search?: string; categoryId?: string; source?: "single" | "multiple"; sort: QueueSort; page: number; pageSize: number }`
  - `type QueueRow` (existant + `missingFields`, `excerpt`)
  - `type QueuePage = { rows: QueueRow[]; total: number; page: number; pageCount: number }`
  - `parseQueueSearchParams(sp): QueueFilters`
  - `getQueue(f: QueueFilters): Promise<QueuePage>`
  - `getQueuePreview(id: string): Promise<QueuePreview | null>`

- [ ] **Step 1 : Écrire le test qui échoue**

Créer `tests/queue-queries.test.ts` :

```ts
import { describe, it, expect } from "bun:test";
import { parseQueueSearchParams, QUEUE_PAGE_SIZE } from "@/lib/queries/queue";

describe("parseQueueSearchParams", () => {
  it("sans paramètre, le périmètre est « en attente »", () => {
    const f = parseQueueSearchParams({});
    expect(f.status).toBe("pending");
    expect(f.page).toBe(1);
    expect(f.pageSize).toBe(QUEUE_PAGE_SIZE);
    expect(f.sort).toBe("oldest");
    expect(f.search).toBeUndefined();
    expect(f.categoryId).toBeUndefined();
    expect(f.source).toBeUndefined();
  });

  it("status=all lève le filtre de statut", () => {
    expect(parseQueueSearchParams({ status: "all" }).status).toBe("all");
  });

  it("accepte chaque statut connu", () => {
    for (const s of ["draft", "pending", "in_review", "approved", "published", "rejected"]) {
      expect(parseQueueSearchParams({ status: s }).status).toBe(s);
    }
  });

  it("un statut inconnu retombe sur « en attente »", () => {
    expect(parseQueueSearchParams({ status: "zzz" }).status).toBe("pending");
  });

  it("ignore les chaînes vides", () => {
    const f = parseQueueSearchParams({ q: "   ", cat: "", src: "" });
    expect(f.search).toBeUndefined();
    expect(f.categoryId).toBeUndefined();
    expect(f.source).toBeUndefined();
  });

  it("ne retient que les valeurs de source connues", () => {
    expect(parseQueueSearchParams({ src: "single" }).source).toBe("single");
    expect(parseQueueSearchParams({ src: "multiple" }).source).toBe("multiple");
    expect(parseQueueSearchParams({ src: "beaucoup" }).source).toBeUndefined();
  });

  it("ne retient que les tris connus", () => {
    expect(parseQueueSearchParams({ sort: "newest" }).sort).toBe("newest");
    expect(parseQueueSearchParams({ sort: "score" }).sort).toBe("score");
    expect(parseQueueSearchParams({ sort: "n'importe quoi" }).sort).toBe("oldest");
  });

  it("borne la page à 1 minimum", () => {
    expect(parseQueueSearchParams({ page: "0" }).page).toBe(1);
    expect(parseQueueSearchParams({ page: "-4" }).page).toBe(1);
    expect(parseQueueSearchParams({ page: "abc" }).page).toBe(1);
    expect(parseQueueSearchParams({ page: "3" }).page).toBe(3);
  });

  it("prend la première valeur d'un paramètre répété", () => {
    expect(parseQueueSearchParams({ q: ["alpha", "beta"] }).search).toBe("alpha");
  });
});
```

- [ ] **Step 2 : Lancer le test pour vérifier qu'il échoue**

Run: `bun test tests/queue-queries.test.ts`
Expected: FAIL — `parseQueueSearchParams` et `QUEUE_PAGE_SIZE` ne sont pas exportés.

- [ ] **Step 3 : Réécrire `lib/queries/queue.ts`**

```ts
import { db, articles, articleSources, wpCategories } from "@/db";
import { and, asc, desc, eq, ilike, sql } from "drizzle-orm";
import { sortMissingFields, type MissingField } from "@/lib/pipeline/completeness";
import type { ArticleStatus } from "@/lib/format";

export const QUEUE_PAGE_SIZE = 25;

const STATUSES: ArticleStatus[] = [
  "draft", "pending", "in_review", "approved", "published", "rejected",
];

export type QueueStatusFilter = ArticleStatus | "all";
export type QueueSort = "oldest" | "newest" | "score";
export type SourceBucket = "single" | "multiple";

export type QueueFilters = {
  status: QueueStatusFilter;
  search?: string;
  categoryId?: string;
  source?: SourceBucket;
  sort: QueueSort;
  page: number;
  pageSize: number;
};

export type QueueRow = {
  id: string; title: string; excerpt: string | null;
  categoryName: string | null; sourceCount: number;
  imageUrl: string | null; generatedAt: Date | null; status: string;
  low: boolean; score: number | null;
  missingFields: MissingField[];
};

export type QueuePage = { rows: QueueRow[]; total: number; page: number; pageCount: number };

// Métacaractères LIKE échappés pour qu'un % ou _ tapé par l'utilisateur soit cherché
// littéralement (ESCAPE par défaut = antislash). Identique à lib/queries/published.ts.
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * PUR — paramètres d'URL bruts → filtres typés. Aucune I/O, donc directement testable.
 * Le défaut porte tout le sens de ce sous-projet : SANS paramètre, la file est « en attente ».
 * Les autres statuts restent atteignables via ?status=…, et ?status=all lève le filtre.
 * Calque de parsePublishedSearchParams.
 */
export function parseQueueSearchParams(
  sp: Record<string, string | string[] | undefined>,
): QueueFilters {
  const str = (v: string | string[] | undefined): string | undefined => {
    const s = Array.isArray(v) ? v[0] : v;
    return s && s.trim() ? s.trim() : undefined;
  };

  const statusRaw = str(sp.status);
  const status: QueueStatusFilter =
    statusRaw === "all" ? "all"
      : STATUSES.includes(statusRaw as ArticleStatus) ? (statusRaw as ArticleStatus)
        : "pending";

  const srcRaw = str(sp.src);
  const source = srcRaw === "single" || srcRaw === "multiple" ? srcRaw : undefined;

  const sortRaw = str(sp.sort);
  const sort: QueueSort =
    sortRaw === "newest" || sortRaw === "score" ? sortRaw : "oldest";

  const pageRaw = Number(str(sp.page));
  const page = Number.isFinite(pageRaw) && pageRaw >= 1 ? Math.floor(pageRaw) : 1;

  return {
    status, search: str(sp.q), categoryId: str(sp.cat), source, sort,
    page, pageSize: QUEUE_PAGE_SIZE,
  };
}

// Sous-requête corrélée réutilisée par le SELECT et par le filtre « sources » — une seule
// définition pour que les deux ne puissent pas compter différemment.
const SOURCE_COUNT = sql<number>`(select count(*) from ${articleSources} s where s.article_id = ${articles.id})`;

export async function getQueue(f: QueueFilters): Promise<QueuePage> {
  const conds = [];
  if (f.status !== "all") conds.push(eq(articles.status, f.status));
  if (f.search) conds.push(ilike(articles.title, `%${escapeLike(f.search)}%`));
  if (f.categoryId) conds.push(eq(articles.categoryId, f.categoryId));
  if (f.source === "single") conds.push(sql`${SOURCE_COUNT} <= 1`);
  if (f.source === "multiple") conds.push(sql`${SOURCE_COUNT} > 1`);
  const where = conds.length ? and(...conds) : undefined;

  const total = await db.$count(articles, where);
  const pageCount = Math.max(1, Math.ceil(total / f.pageSize));
  // Borne la page dans l'intervalle valide : un ?page= trop grand renvoie la dernière page
  // plutôt qu'un tableau vide.
  const page = Math.min(Math.max(1, f.page), pageCount);

  const orderBy =
    f.sort === "newest" ? desc(articles.generatedAt)
      : f.sort === "score" ? desc(articles.score)
        : asc(articles.generatedAt);

  const rows = await db.select({
    id: articles.id, title: articles.title, excerpt: articles.excerpt,
    categoryName: wpCategories.name, imageUrl: articles.featuredImageUrl,
    generatedAt: articles.generatedAt, status: articles.status,
    confidenceFlags: articles.confidenceFlags, score: articles.score,
    missingFields: articles.missingFields, sourceCount: SOURCE_COUNT,
  }).from(articles)
    .leftJoin(wpCategories, eq(articles.categoryId, wpCategories.id))
    .where(where)
    .orderBy(orderBy)
    .limit(f.pageSize)
    .offset((page - 1) * f.pageSize);

  return {
    rows: rows.map((r) => ({
      id: r.id, title: r.title, excerpt: r.excerpt, categoryName: r.categoryName,
      sourceCount: Number(r.sourceCount), imageUrl: r.imageUrl,
      generatedAt: r.generatedAt, status: r.status, score: r.score,
      low: Boolean(
        r.confidenceFlags?.categoryUncertain ||
        r.confidenceFlags?.imageMissing ||
        r.confidenceFlags?.clusterUncertain,
      ),
      // Normalisé à la lecture : couvre aussi les lignes écrites avant le sous-projet D.
      missingFields: sortMissingFields((r.missingFields ?? []) as MissingField[]),
    })),
    total, page, pageCount,
  };
}

export type QueuePreview = {
  id: string; title: string; excerpt: string | null; bodyHtml: string;
  imageUrl: string | null; imageCredit: string | null; imageSourceUrl: string | null;
  categoryName: string | null; status: string; score: number | null;
  missingFields: MissingField[];
  sources: { mediaName: string; url: string }[];
};

// Charge le corps d'UN article — délibérément séparé de getQueue, qui ne doit jamais tirer
// N corps d'articles pour n'en afficher aucun.
export async function getQueuePreview(id: string): Promise<QueuePreview | null> {
  const [row] = await db.select({
    id: articles.id, title: articles.title, excerpt: articles.excerpt,
    bodyHtml: articles.bodyHtml, imageUrl: articles.featuredImageUrl,
    imageCredit: articles.imageCredit, imageSourceUrl: articles.imageSourceUrl,
    categoryName: wpCategories.name, status: articles.status, score: articles.score,
    missingFields: articles.missingFields,
  }).from(articles)
    .leftJoin(wpCategories, eq(articles.categoryId, wpCategories.id))
    .where(eq(articles.id, id))
    .limit(1);

  if (!row) return null;

  const sources = await db.select({
    mediaName: articleSources.mediaName, url: articleSources.url,
  }).from(articleSources).where(eq(articleSources.articleId, id));

  return {
    ...row,
    missingFields: sortMissingFields((row.missingFields ?? []) as MissingField[]),
    sources,
  };
}
```

- [ ] **Step 4 : Lancer le test pour vérifier qu'il passe**

Run: `bun test tests/queue-queries.test.ts`
Expected: PASS — 10 tests.

- [ ] **Step 5 : Vérifier ce que la réécriture casse**

Run: `bun run typecheck`
Expected: erreurs attendues dans `app/(app)/queue/page.tsx` (appelle `getQueue()` sans argument)
et dans `components/queue/queue-table.tsx` / `queue-filters.tsx` / `columns.tsx`. Elles sont
réparées en Task 2 — **ne pas les corriger ici**, noter simplement qu'elles sont attendues.

- [ ] **Step 6 : Commit**

```bash
git add lib/queries/queue.ts tests/queue-queries.test.ts
git commit -m "feat(queue): server-side URL filters — pending by default, paginated"
```

---

### Task 2 : Page, vue, barre de filtres, pagination

**Files:**
- Modify: `app/(app)/queue/page.tsx`
- Create: `components/queue/queue-view.tsx`
- Create: `components/queue/queue-pagination.tsx`
- Modify: `components/queue/queue-filters.tsx` (réécriture)
- Modify: `components/queue/queue-table.tsx`
- Modify: `components/queue/columns.tsx`

**Interfaces:**
- Consumes: `QueueFilters`, `QueuePage`, `parseQueueSearchParams`, `getQueue` (Task 1) ; `MISSING_LABEL` (sous-projet D)
- Produces: `QueueView({ page, filters, categories })`, `QueuePagination({ page, pageCount })`

- [ ] **Step 1 : Réécrire la page**

`app/(app)/queue/page.tsx` — calque exact de `app/(app)/published/page.tsx` :

```tsx
import { requireUser } from "@/lib/session";
import { getQueue, parseQueueSearchParams } from "@/lib/queries/queue";
import { getTaxonomy } from "@/lib/queries/settings";
import { QueueView } from "@/components/queue/queue-view";

export default async function QueuePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireUser();
  const filters = parseQueueSearchParams(await searchParams);
  const [page, { categories }] = await Promise.all([getQueue(filters), getTaxonomy()]);
  return (
    <QueueView
      page={page}
      filters={filters}
      categories={categories.map((c) => ({ id: c.id, name: c.name }))}
    />
  );
}
```

- [ ] **Step 2 : Créer `components/queue/queue-view.tsx`**

```tsx
import { QueueFilters } from "./queue-filters";
import { QueueTable } from "./queue-table";
import { QueuePagination } from "./queue-pagination";
import type { QueueFilters as Filters, QueuePage } from "@/lib/queries/queue";

export function QueueView({
  page, filters, categories,
}: {
  page: QueuePage;
  filters: Filters;
  categories: { id: string; name: string }[];
}) {
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">File de revue</h1>
        <span className="text-sm text-muted-foreground">
          {page.total} article{page.total > 1 ? "s" : ""}
        </span>
      </div>
      <QueueFilters filters={filters} categories={categories} />
      <QueueTable rows={page.rows} />
      {page.pageCount > 1 && <QueuePagination page={page.page} pageCount={page.pageCount} />}
    </div>
  );
}
```

- [ ] **Step 3 : Créer `components/queue/queue-pagination.tsx`**

Copie de `components/published/published-pagination.tsx` avec le nom `QueuePagination` — même
corps, aucune adaptation nécessaire (il ne lit que `page`/`pageCount` et l'URL courante).

- [ ] **Step 4 : Réécrire `components/queue/queue-filters.tsx`**

```tsx
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

      <Select value={filters.status} onValueChange={(v) => setParams({ status: v })}>
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
        onValueChange={(v) => setParams({ cat: v !== "all" ? v : undefined })}
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
        onValueChange={(v) => setParams({ src: v !== "all" ? v : undefined })}
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

      <Select value={filters.sort} onValueChange={(v) => setParams({ sort: v })}>
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
```

⚠️ `usePersistedFilters` / `QUEUE_FILTERS_KEY` n'existent qu'en **Task 3**. Pour que cette task
compile seule, créer d'abord le fichier `hooks/use-persisted-filters.ts` avec un corps minimal
(`export const QUEUE_FILTERS_KEY = "afrotiative.queue.filters.v1"; export function usePersistedFilters(_key: string) {}`)
— Task 3 le remplit et le teste.

- [ ] **Step 5 : Alléger `components/queue/queue-table.tsx`**

Le tableau ne filtre, ne trie et ne pagine plus (le serveur s'en charge). Il conserve TanStack
pour les colonnes et le rendu :

```tsx
"use client";
import { flexRender, getCoreRowModel, useReactTable } from "@tanstack/react-table";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { columns } from "./columns";
import type { QueueRow } from "@/lib/queries/queue";

export function QueueTable({ rows }: { rows: QueueRow[] }) {
  const table = useReactTable({ data: rows, columns, getCoreRowModel: getCoreRowModel() });
  const model = table.getRowModel().rows;

  return (
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
  );
}
```

- [ ] **Step 6 : Ajouter le badge de manques dans `columns.tsx`**

Retirer les `filterFn` devenus inutiles (`categoryName`, `status`, `sourceCount`) et insérer,
avant la colonne `actions` :

```tsx
  { id: "missing", header: "Complétude", enableSorting: false, cell: ({ row }) => {
      const missing = row.original.missingFields;
      if (missing.length === 0) return <span className="text-muted-foreground">—</span>;
      return (
        <Badge variant="outline" className="border-amber-500/50 text-amber-700 dark:text-amber-400"
          title={missing.map((m) => MISSING_LABEL[m]).join(", ")}>
          {missing.length} manque{missing.length > 1 ? "s" : ""}
        </Badge>
      );
    } },
```

avec `import { MISSING_LABEL } from "@/lib/pipeline/completeness";`.

- [ ] **Step 7 : Vérifier**

Run: `bun run typecheck && bun test`
Expected: aucune erreur ; suite verte.

- [ ] **Step 8 : Vérification visuelle**

Run: `bun run dev` → `http://localhost:3000/queue`
Expected: seuls les articles « En attente » s'affichent ; changer un filtre modifie l'URL ;
`?status=all` fait réapparaître les autres statuts ; la pagination apparaît au-delà de 25 lignes.

- [ ] **Step 9 : Commit**

```bash
git add "app/(app)/queue/page.tsx" components/queue hooks/use-persisted-filters.ts
git commit -m "feat(queue): URL-driven view, filters, pagination + completeness badge"
```

---

### Task 3 : Mémorisation des filtres dans le navigateur

**Files:**
- Modify: `hooks/use-persisted-filters.ts` (créé vide en Task 2)
- Test: `tests/use-persisted-filters.test.ts` (créer)

**Interfaces:**
- Produces:
  - `QUEUE_FILTERS_KEY = "afrotiative.queue.filters.v1"`
  - `readStored(key, storage): string | null`
  - `writeStored(key, value, storage): void`
  - `shouldRestore(currentSearch, stored): boolean`
  - `usePersistedFilters(key: string): void`

- [ ] **Step 1 : Écrire le test qui échoue**

Créer `tests/use-persisted-filters.test.ts` :

```ts
import { describe, it, expect } from "bun:test";
import {
  readStored, writeStored, shouldRestore, QUEUE_FILTERS_KEY,
} from "@/hooks/use-persisted-filters";

// Faux localStorage — le hook lui-même n'est pas monté ici (pas de DOM dans bun test) ; ce sont
// ses trois décisions pures qui portent toute la logique et qui sont testées.
function fakeStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => { map.set(k, v); },
    dump: () => Object.fromEntries(map),
  };
}

const throwingStorage = {
  getItem: () => { throw new Error("SecurityError"); },
  setItem: () => { throw new Error("QuotaExceededError"); },
};

describe("shouldRestore", () => {
  it("restaure sur une URL nue avec une valeur mémorisée", () => {
    expect(shouldRestore("", "status=approved&cat=abc")).toBe(true);
  });

  it("ne restaure pas quand l'URL porte déjà des paramètres", () => {
    expect(shouldRestore("status=pending", "status=approved")).toBe(false);
  });

  it("ne restaure pas sans valeur mémorisée", () => {
    expect(shouldRestore("", null)).toBe(false);
    expect(shouldRestore("", "")).toBe(false);
  });
});

describe("readStored / writeStored", () => {
  it("relit ce qui a été écrit", () => {
    const s = fakeStorage();
    writeStored(QUEUE_FILTERS_KEY, "status=approved", s);
    expect(readStored(QUEUE_FILTERS_KEY, s)).toBe("status=approved");
  });

  it("une valeur absente ou vide se lit comme null", () => {
    expect(readStored(QUEUE_FILTERS_KEY, fakeStorage())).toBeNull();
    expect(readStored(QUEUE_FILTERS_KEY, fakeStorage({ [QUEUE_FILTERS_KEY]: "" }))).toBeNull();
  });

  it("tolère un stockage indisponible (navigation privée, quota)", () => {
    expect(readStored(QUEUE_FILTERS_KEY, throwingStorage)).toBeNull();
    expect(() => writeStored(QUEUE_FILTERS_KEY, "status=all", throwingStorage)).not.toThrow();
  });

  it("tolère l'absence totale de stockage (rendu serveur)", () => {
    expect(readStored(QUEUE_FILTERS_KEY, null)).toBeNull();
    expect(() => writeStored(QUEUE_FILTERS_KEY, "status=all", null)).not.toThrow();
  });
});
```

- [ ] **Step 2 : Lancer le test pour vérifier qu'il échoue**

Run: `bun test tests/use-persisted-filters.test.ts`
Expected: FAIL — `readStored`, `writeStored`, `shouldRestore` ne sont pas exportés.

- [ ] **Step 3 : Écrire `hooks/use-persisted-filters.ts`**

```ts
"use client";
import { useEffect, useRef } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

// Le suffixe de version permet d'invalider proprement le contenu mémorisé si la forme des
// filtres change un jour — un ancien « status=… » incompatible serait alors simplement ignoré.
export const QUEUE_FILTERS_KEY = "afrotiative.queue.filters.v1";

type ReadableStorage = Pick<Storage, "getItem">;
type WritableStorage = Pick<Storage, "setItem">;

// Toute lecture est enveloppée : localStorage lève en navigation privée sur certains
// navigateurs, et un échec doit dégrader vers « pas de restauration », jamais casser la page.
export function readStored(key: string, storage: ReadableStorage | null): string | null {
  if (!storage) return null;
  try {
    const v = storage.getItem(key);
    return v && v.length > 0 ? v : null;
  } catch {
    return null;
  }
}

export function writeStored(key: string, value: string, storage: WritableStorage | null): void {
  if (!storage) return;
  try {
    storage.setItem(key, value);
  } catch {
    // Quota dépassé ou stockage refusé — la mémorisation est un confort, jamais une exigence.
  }
}

// On ne restaure que sur une arrivée NUE : une URL déjà porteuse de paramètres (partagée, mise
// en favori, ou produite en vidant les filtres) l'emporte toujours sur la mémoire.
export function shouldRestore(currentSearch: string, stored: string | null): boolean {
  return currentSearch.length === 0 && stored !== null && stored.length > 0;
}

/**
 * Miroir bidirectionnel entre les paramètres d'URL et localStorage.
 *
 * Le garde `restoredRef` limite la restauration à UNE fois par montage : sans lui, un
 * utilisateur qui remettrait volontairement l'URL à nu se verrait réimposer ses anciens filtres
 * en boucle. Combiné au fait que la barre de filtres écrit toujours `status`, l'action « vider
 * les filtres » produit une URL non vide et écrase donc bien la mémoire.
 */
export function usePersistedFilters(key: string): void {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const search = searchParams.toString();
  const restoredRef = useRef(false);

  useEffect(() => {
    const storage = typeof window === "undefined" ? null : window.localStorage;

    if (!restoredRef.current) {
      restoredRef.current = true;
      const stored = readStored(key, storage);
      if (shouldRestore(search, stored)) {
        // replace et non push : restaurer une préférence ne doit pas créer une entrée
        // d'historique dont le « Précédent » ramènerait sur la même page.
        router.replace(`${pathname}?${stored}`);
        return;
      }
    }

    if (search.length > 0) writeStored(key, search, storage);
  }, [key, search, pathname, router]);
}
```

- [ ] **Step 4 : Lancer le test pour vérifier qu'il passe**

Run: `bun test tests/use-persisted-filters.test.ts`
Expected: PASS — 8 tests.

- [ ] **Step 5 : Vérification manuelle du comportement**

Run: `bun run dev`
1. Sur `/queue`, régler Statut = « Approuvé » et une catégorie.
2. Cliquer « Tableau de bord » dans la barre latérale, puis « File de revue ».
   Expected: les filtres sont restaurés, l'URL porte `?status=approved&cat=…`.
3. Ouvrir directement `http://localhost:3000/queue?status=rejected`.
   Expected: statut « Rejeté » — l'URL l'emporte sur la mémoire.
4. Remettre Statut = « En attente » puis revenir via la barre latérale.
   Expected: « En attente » — la mémoire a bien été écrasée.

- [ ] **Step 6 : Commit**

```bash
git add hooks/use-persisted-filters.ts tests/use-persisted-filters.test.ts
git commit -m "feat(queue): persist filters in localStorage, restore on bare navigation"
```

---

### Task 4 : Sélection multiple et actions en lot

**Files:**
- Create: `components/ui/checkbox.tsx` (via CLI)
- Create: `components/queue/bulk-action-bar.tsx`
- Modify: `components/queue/queue-table.tsx`, `components/queue/columns.tsx`
- Modify: `lib/actions/queue-actions.ts`
- Modify: `lib/validation.ts`
- Test: `tests/queue-actions.test.ts` (étendre)

**Interfaces:**
- Consumes: `blockingGapsForArticle`, `MISSING_LABEL` (sous-projet D)
- Produces:
  - `type BulkResult = { ok: string[]; failed: { id: string; title: string; message: string }[] }`
  - `bulkApprove(ids: string[]): Promise<BulkResult>`
  - `bulkReject(input: { ids: string[]; reason: string }): Promise<BulkResult>`
  - `bulkIdsSchema`, `bulkRejectSchema` dans `lib/validation.ts`

- [ ] **Step 1 : Installer la primitive**

```bash
npx shadcn@latest add checkbox
```

Run: `git status --short`
Expected: un seul fichier ajouté, `components/ui/checkbox.tsx`.

- [ ] **Step 2 : Écrire les tests qui échouent**

Ajouter à `tests/queue-actions.test.ts` (suivre le style d'amorçage de données déjà présent dans
ce fichier pour créer les articles de test) :

```ts
describe("bulkApprove", () => {
  it("écarte AVANT tout appel réseau un article aux informations manquantes", async () => {
    // Article sans catégorie ni image → deux manques bloquants.
    const id = await seedArticle({ status: "pending", categoryId: null, featuredImageUrl: null });
    const res = await bulkApprove([id]);
    expect(res.ok).toEqual([]);
    expect(res.failed).toHaveLength(1);
    expect(res.failed[0].message).toContain("Informations manquantes");
    expect(res.failed[0].message).toContain("Catégorie");
    expect(res.failed[0].message).toContain("Image à la une");
  });

  it("rapporte un succès partiel : les identifiants réussis et les échecs détaillés", async () => {
    const bad = await seedArticle({ status: "pending", categoryId: null, featuredImageUrl: null });
    const alsoBad = await seedArticle({ status: "pending", categoryId: null, featuredImageUrl: null });
    const res = await bulkApprove([bad, alsoBad]);
    expect(res.ok).toEqual([]);
    expect(res.failed.map((f) => f.id).sort()).toEqual([bad, alsoBad].sort());
    // Chaque échec porte le titre de son article, pas seulement son identifiant.
    for (const f of res.failed) expect(f.title.length).toBeGreaterThan(0);
  });

  it("refuse un identifiant qui n'est pas un UUID", async () => {
    await expect(bulkApprove(["pas-un-uuid"])).rejects.toThrow();
  });

  it("refuse une liste vide", async () => {
    await expect(bulkApprove([])).rejects.toThrow();
  });
});

describe("bulkReject", () => {
  it("exige un motif d'au moins 3 caractères", async () => {
    const id = await seedArticle({ status: "pending" });
    await expect(bulkReject({ ids: [id], reason: "ok" })).rejects.toThrow();
  });

  it("rejette chaque article et consigne une révision par article", async () => {
    const a = await seedArticle({ status: "pending" });
    const b = await seedArticle({ status: "pending" });
    const res = await bulkReject({ ids: [a, b], reason: "Hors ligne éditoriale" });
    expect(res.ok.sort()).toEqual([a, b].sort());
    expect(res.failed).toEqual([]);
    for (const id of [a, b]) {
      const [row] = await db.select({ status: articles.status }).from(articles).where(eq(articles.id, id));
      expect(row.status).toBe("rejected");
      const revs = await db.select().from(articleRevisions).where(eq(articleRevisions.articleId, id));
      expect(revs.some((r) => r.action === "rejeté")).toBe(true);
    }
  });
});
```

Si `tests/queue-actions.test.ts` n'a pas encore d'assistant `seedArticle`, l'écrire en tête du
fichier : insertion directe d'une ligne `articles` (statut, titre faker, `generatedAt: new Date()`)
retournant son `id`, et nettoyage en `afterAll`.

- [ ] **Step 3 : Lancer les tests pour vérifier qu'ils échouent**

Run: `bun test tests/queue-actions.test.ts`
Expected: FAIL — `bulkApprove` / `bulkReject` ne sont pas exportés.

- [ ] **Step 4 : Ajouter les schémas de validation**

Dans `lib/validation.ts` :

```ts
// Plafond volontaire : les actions en lot publient séquentiellement sur WordPress, une sélection
// démesurée tiendrait la Server Action ouverte trop longtemps. 100 couvre largement une page de
// file (25 lignes) et plusieurs pages sélectionnées à la suite.
export const bulkIdsSchema = z.array(z.string().uuid()).min(1, "Sélectionnez au moins un article").max(100);

export const bulkRejectSchema = z.object({
  ids: bulkIdsSchema,
  reason: z.string().min(3, "Motif requis"),
});
```

- [ ] **Step 5 : Implémenter les actions**

Dans `lib/actions/queue-actions.ts` :

```ts
export type BulkResult = {
  ok: string[];
  failed: { id: string; title: string; message: string }[];
};

// Charge, pour chaque identifiant, tout ce qu'il faut pour décider SANS appel réseau : titre
// (pour un rapport d'échec lisible) et colonnes de complétude.
async function loadBulkCandidates(ids: string[]) {
  return db.select({
    id: articles.id, title: articles.title,
    categoryId: articles.categoryId, categoryName: wpCategories.name,
    featuredImageUrl: articles.featuredImageUrl, imageCredit: articles.imageCredit,
    imageSourceUrl: articles.imageSourceUrl,
    sourceCount: sql<number>`(select count(*) from ${articleSources} s where s.article_id = ${articles.id})`,
  }).from(articles)
    .leftJoin(wpCategories, eq(articles.categoryId, wpCategories.id))
    .where(inArray(articles.id, ids));
}

/**
 * Approuve ET PUBLIE sur WordPress une sélection d'articles — même sémantique que quickApprove,
 * appliquée en série. Séquentiel à dessein : chaque publication est un aller-retour réseau vers
 * WordPress ; en parallèle on s'exposerait au throttling et le rapport d'échec deviendrait
 * illisible.
 *
 * Ne lève pas sur un échec unitaire : le retour partiel EST le résultat attendu. Une publication
 * en lot échoue rarement en bloc, et l'appelant doit pouvoir dire lesquels sont passés.
 */
export async function bulkApprove(ids: string[]): Promise<BulkResult> {
  const user = await requireUser();
  requirePermission(user.role, "article", "publish");
  const parsed = bulkIdsSchema.parse(ids);

  const rows = await loadBulkCandidates(parsed);
  const result: BulkResult = { ok: [], failed: [] };

  for (const row of rows) {
    // Pré-filtrage : inutile d'aller jusqu'à WordPress pour en revenir refusé. Mêmes règles que
    // publishArticle, puisque c'est le même module qui les porte.
    const gaps = blockingGapsForArticle({
      categoryId: row.categoryId, categoryName: row.categoryName,
      featuredImageUrl: row.featuredImageUrl, imageCredit: row.imageCredit,
      imageSourceUrl: row.imageSourceUrl, sourceCount: Number(row.sourceCount),
    });
    if (gaps.length > 0) {
      result.failed.push({
        id: row.id, title: row.title,
        message: `Informations manquantes : ${gaps.map((g) => MISSING_LABEL[g]).join(", ")}.`,
      });
      continue;
    }

    const res = await publishArticle(row.id, user.id);
    if (res.ok) result.ok.push(row.id);
    else result.failed.push({ id: row.id, title: row.title, message: res.message });
  }

  revalidatePath("/queue"); revalidatePath("/dashboard");
  return result;
}

export async function bulkReject(input: { ids: string[]; reason: string }): Promise<BulkResult> {
  const user = await requireUser();
  requirePermission(user.role, "article", "reject");
  const { ids, reason } = bulkRejectSchema.parse(input);

  const rows = await db.select({ id: articles.id, title: articles.title })
    .from(articles).where(inArray(articles.id, ids));
  const result: BulkResult = { ok: [], failed: [] };

  for (const row of rows) {
    try {
      await db.update(articles)
        .set({ status: "rejected", rejectReason: reason, updatedAt: new Date() })
        .where(eq(articles.id, row.id));
      await db.insert(articleRevisions)
        .values({ articleId: row.id, actorId: user.id, action: "rejeté", detail: reason });
      result.ok.push(row.id);
    } catch (e) {
      result.failed.push({
        id: row.id, title: row.title,
        message: e instanceof Error ? e.message : "Échec du rejet.",
      });
    }
  }

  revalidatePath("/queue"); revalidatePath("/dashboard");
  return result;
}
```

Imports à ajouter : `inArray`, `sql` depuis `drizzle-orm` ; `articleSources`, `wpCategories`
depuis `@/db` ; `blockingGapsForArticle`, `MISSING_LABEL` depuis `@/lib/pipeline/completeness` ;
`bulkIdsSchema`, `bulkRejectSchema` depuis `@/lib/validation`.

- [ ] **Step 6 : Lancer les tests pour vérifier qu'ils passent**

Run: `bun test tests/queue-actions.test.ts`
Expected: PASS.

- [ ] **Step 7 : Colonne de sélection**

Dans `components/queue/columns.tsx`, insérer en **première** position :

```tsx
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
```

Vérifier le nom de la prop « indéterminé » du Checkbox Base UI généré :

Run: `grep -n "indeterminate\|Props" components/ui/checkbox.tsx`
Expected: si la prop n'existe pas, retirer simplement cette ligne — l'état visuel intermédiaire
est un confort, pas une exigence.

- [ ] **Step 8 : Câbler la sélection dans `queue-table.tsx`**

```tsx
"use client";
import { useEffect, useState } from "react";
import { flexRender, getCoreRowModel, useReactTable, type RowSelectionState } from "@tanstack/react-table";
// … imports existants …
import { BulkActionBar } from "./bulk-action-bar";

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

  // Toute nouvelle page de données (changement de filtre, de tri ou de page) vide la sélection :
  // agir en lot sur des lignes qu'on ne voit plus serait dangereux.
  useEffect(() => { setRowSelection({}); }, [rows]);

  const selectedIds = Object.keys(rowSelection).filter((id) => rowSelection[id]);
  const selectedRows = rows.filter((r) => selectedIds.includes(r.id));

  return (
    <>
      {/* … le tableau, inchangé par rapport à la Task 2 … */}
      <BulkActionBar rows={selectedRows} onDone={() => setRowSelection({})} />
    </>
  );
}
```

- [ ] **Step 9 : Créer `components/queue/bulk-action-bar.tsx`**

```tsx
"use client";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { RoleGate } from "@/components/role-gate";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { bulkApprove, bulkReject, type BulkResult } from "@/lib/actions/queue-actions";
import type { QueueRow } from "@/lib/queries/queue";

export function BulkActionBar({ rows, onDone }: { rows: QueueRow[]; onDone: () => void }) {
  const [isPending, startTransition] = useTransition();
  const [failures, setFailures] = useState<BulkResult["failed"]>([]);

  if (rows.length === 0) return null;
  const ids = rows.map((r) => r.id);
  const n = rows.length;

  function report(res: BulkResult, verb: string) {
    setFailures(res.failed);
    if (res.failed.length === 0) {
      toast.success(`${res.ok.length} article${res.ok.length > 1 ? "s" : ""} ${verb}.`);
      onDone();
    } else {
      // Succès partiel : le compte des deux côtés, et le détail reste affiché sous la barre.
      toast.warning(`${res.ok.length} ${verb}, ${res.failed.length} en échec.`);
    }
  }

  function run(fn: () => Promise<BulkResult>, verb: string) {
    startTransition(async () => {
      try {
        report(await fn(), verb);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Action impossible.");
      }
    });
  }

  return (
    <div className="sticky bottom-4 z-20 mx-auto w-fit rounded-lg border bg-background/95 px-4 py-2 shadow-lg backdrop-blur">
      <div className="flex items-center gap-3">
        <span className="text-sm font-medium">
          {n} sélectionné{n > 1 ? "s" : ""}
        </span>

        <RoleGate allow={["admin", "editor"]}>
          <ConfirmDialog
            trigger={<Button size="sm" disabled={isPending}>Approuver et publier</Button>}
            title={`Publier ${n} article${n > 1 ? "s" : ""} ?`}
            /* La phrase dit explicitement ce que fait l'action : approuver PUBLIE
               immédiatement sur WordPress — c'est déjà la sémantique de l'action unitaire. */
            description={`Ces ${n} article${n > 1 ? "s seront publiés" : " sera publié"} immédiatement sur WordPress. Les articles aux informations manquantes seront écartés et listés.`}
            confirmLabel="Approuver et publier"
            onConfirm={() => run(() => bulkApprove(ids), "publié(s)")}
          />

          <ConfirmDialog
            trigger={
              <Button size="sm" variant="ghost" disabled={isPending}
                className="text-destructive hover:bg-destructive/10 hover:text-destructive">
                Rejeter
              </Button>
            }
            title={`Rejeter ${n} article${n > 1 ? "s" : ""} ?`}
            description="Ces articles seront marqués comme rejetés et retirés de la file de publication."
            confirmLabel="Rejeter"
            destructive
            withReason
            onConfirm={(reason) => run(() => bulkReject({ ids, reason: reason ?? "" }), "rejeté(s)")}
          />
        </RoleGate>

        <Button size="sm" variant="ghost" onClick={() => { setFailures([]); onDone(); }}>
          Effacer la sélection
        </Button>
      </div>

      {failures.length > 0 && (
        <ul className="mt-2 max-h-40 space-y-1 overflow-auto border-t pt-2 text-xs">
          {failures.map((f) => (
            <li key={f.id}>
              <span className="font-medium">{f.title}</span>{" — "}
              <span className="text-destructive">{f.message}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
```

- [ ] **Step 10 : Vérifier**

Run: `bun run typecheck && bun test`
Expected: aucune erreur ; suite verte.

- [ ] **Step 11 : Vérification visuelle**

Run: `bun run dev` → `/queue` en admin.
Expected: cocher des lignes fait apparaître la barre ; « Approuver et publier » annonce la
publication immédiate ; un article incomplet apparaît dans la liste d'échecs avec ses manques
nommés ; changer de filtre vide la sélection.

- [ ] **Step 12 : Commit**

```bash
git add components/ui/checkbox.tsx components/queue lib/actions/queue-actions.ts lib/validation.ts tests/queue-actions.test.ts
git commit -m "feat(queue): bulk select + bulk approve/reject with partial-failure reporting"
```

---

### Task 5 : Aperçu en panneau latéral

**Files:**
- Create: `components/queue/preview-sheet.tsx`
- Create: `lib/actions/queue-preview-action.ts`
- Modify: `components/queue/row-actions.tsx`

**Interfaces:**
- Consumes: `getQueuePreview`, `QueuePreview` (Task 1) ; `MISSING_LABEL` (sous-projet D)
- Produces: `PreviewSheet({ row })` ; `loadPreview(id): Promise<QueuePreview | null>`

- [ ] **Step 1 : Action serveur de chargement**

Créer `lib/actions/queue-preview-action.ts` :

```ts
"use server";
import { requireUser } from "@/lib/session";
import { getQueuePreview, type QueuePreview } from "@/lib/queries/queue";

// Le panneau est ouvert à la demande depuis un composant client ; le corps de l'article n'est
// donc chargé que pour l'article réellement consulté, jamais pour les 25 lignes de la page.
export async function loadPreview(id: string): Promise<QueuePreview | null> {
  await requireUser();
  return getQueuePreview(id);
}
```

- [ ] **Step 2 : Créer `components/queue/preview-sheet.tsx`**

```tsx
"use client";
import { useState, useTransition } from "react";
import Link from "next/link";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Button, buttonVariants } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { StatusBadge } from "@/components/status-badge";
import { loadPreview } from "@/lib/actions/queue-preview-action";
import { MISSING_LABEL } from "@/lib/pipeline/completeness";
import type { QueuePreview, QueueRow } from "@/lib/queries/queue";
import type { ArticleStatus } from "@/lib/format";
import { cn } from "@/lib/utils";

export function PreviewSheet({ row }: { row: QueueRow }) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<QueuePreview | null>(null);
  const [isLoading, startLoading] = useTransition();

  function handleOpenChange(next: boolean) {
    setOpen(next);
    // Rechargé à chaque ouverture plutôt que mis en cache : entre deux ouvertures, une
    // correction en ligne a pu changer l'article.
    if (next) startLoading(async () => setData(await loadPreview(row.id)));
    else setData(null);
  }

  return (
    <Sheet open={open} onOpenChange={handleOpenChange}>
      <SheetTrigger render={<Button variant="ghost" size="sm">Aperçu</Button>} />
      <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
        <SheetHeader>
          <SheetTitle className="pr-8 text-left">{row.title}</SheetTitle>
        </SheetHeader>

        {isLoading && <p className="text-sm text-muted-foreground">Chargement…</p>}

        {data && (
          <div className="space-y-4 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge status={data.status as ArticleStatus} />
              {data.categoryName && <Badge variant="outline">{data.categoryName}</Badge>}
              {data.score !== null && <Badge variant="outline">Score {data.score}</Badge>}
            </div>

            {data.missingFields.length > 0 && (
              <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3">
                <p className="font-medium">Informations manquantes</p>
                <ul className="mt-1 list-inside list-disc text-muted-foreground">
                  {data.missingFields.map((m) => <li key={m}>{MISSING_LABEL[m]}</li>)}
                </ul>
              </div>
            )}

            {data.imageUrl && (
              // eslint-disable-next-line @next/next/no-img-element -- URL externes par article ; aucun remotePattern configuré.
              <img src={data.imageUrl} alt="" className="w-full rounded-md object-cover" />
            )}
            {data.imageCredit && (
              <p className="text-xs text-muted-foreground">Crédit : {data.imageCredit}</p>
            )}

            {data.excerpt && <p className="text-muted-foreground">{data.excerpt}</p>}

            {/* Le corps est déjà assaini en base (sanitizeArticleHtml à la génération et à
                chaque enregistrement humain) — aucun second assainissement ici. */}
            <div
              className="prose prose-sm dark:prose-invert max-w-none"
              dangerouslySetInnerHTML={{ __html: data.bodyHtml }}
            />

            {data.sources.length > 0 && (
              <div>
                <p className="font-medium">Sources</p>
                <ul className="mt-1 list-inside list-disc">
                  {data.sources.map((s) => (
                    <li key={s.url}>
                      <a href={s.url} target="_blank" rel="noopener noreferrer" className="underline">
                        {s.mediaName}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <Link
              href={`/article/${row.id}`}
              className={cn(buttonVariants({ variant: "outline", size: "sm" }))}
            >
              Ouvrir dans l&apos;éditeur
            </Link>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
```

- [ ] **Step 3 : Ajouter le déclencheur dans `row-actions.tsx`**

Insérer `<PreviewSheet row={row} />` avant le lien « Ouvrir ». Le reste du composant est
inchangé.

- [ ] **Step 4 : Vérifier**

Run: `bun run typecheck && bun test`
Expected: aucune erreur ; suite verte.

- [ ] **Step 5 : Vérification visuelle**

Run: `bun run dev` → `/queue`, cliquer « Aperçu ».
Expected: le panneau s'ouvre avec image, chapô, corps, sources ; un article incomplet affiche
l'encadré ambre listant ses manques.

- [ ] **Step 6 : Commit**

```bash
git add components/queue/preview-sheet.tsx lib/actions/queue-preview-action.ts components/queue/row-actions.tsx
git commit -m "feat(queue): preview sheet — body, sources, missing info, without leaving the queue"
```

---

### Task 6 : Correction en ligne

**Files:**
- Create: `components/queue/fix-popover.tsx`
- Modify: `lib/actions/article-actions.ts`
- Modify: `lib/validation.ts`
- Modify: `components/queue/columns.tsx`
- Test: `tests/article-actions.test.ts` (étendre)

**Interfaces:**
- Consumes: `checkCompleteness`, `MISSING_LABEL`, `MissingField` (sous-projet D) ; `isSafePublicHttpUrl`
- Produces: `fixArticleFields(input): Promise<{ ok: boolean; message: string; missingFields: MissingField[] }>` ; `fixFieldsSchema`

- [ ] **Step 1 : Écrire les tests qui échouent**

Ajouter à `tests/article-actions.test.ts` :

```ts
describe("fixArticleFields", () => {
  it("écrit les champs et recalcule les informations manquantes", async () => {
    const id = await seedArticle({ status: "pending", categoryId: null, featuredImageUrl: null });
    const res = await fixArticleFields({
      id,
      categoryId: existingCategoryId,
      featuredImageUrl: "https://www.agenceecofin.com/img/p.jpg",
      imageCredit: "Ecofin",
      imageSourceUrl: "https://www.agenceecofin.com/a/1",
    });
    expect(res.ok).toBe(true);
    expect(res.missingFields).not.toContain("categoryId");
    expect(res.missingFields).not.toContain("featuredImageUrl");
    expect(res.missingFields).not.toContain("imageCredit");

    const [row] = await db.select({ missingFields: articles.missingFields, imageCredit: articles.imageCredit })
      .from(articles).where(eq(articles.id, id));
    expect(row.imageCredit).toBe("Ecofin");
    expect(row.missingFields).toEqual(res.missingFields);
  });

  it("consigne une révision « informations complétées »", async () => {
    const id = await seedArticle({ status: "pending" });
    await fixArticleFields({ id, imageCredit: "Ecofin" });
    const revs = await db.select().from(articleRevisions).where(eq(articleRevisions.articleId, id));
    expect(revs.some((r) => r.action === "informations complétées")).toBe(true);
  });

  it("refuse une URL d'image non sûre", async () => {
    const id = await seedArticle({ status: "pending" });
    await expect(
      fixArticleFields({ id, featuredImageUrl: "http://localhost/secret.png" }),
    ).rejects.toThrow();
  });

  it("refuse une URL syntaxiquement invalide", async () => {
    const id = await seedArticle({ status: "pending" });
    await expect(fixArticleFields({ id, featuredImageUrl: "pas une url" })).rejects.toThrow();
  });

  it("n'écrase pas un champ non fourni", async () => {
    const id = await seedArticle({ status: "pending", imageCredit: "Crédit initial" });
    await fixArticleFields({ id, imageSourceUrl: "https://ex.com/a" });
    const [row] = await db.select({ imageCredit: articles.imageCredit })
      .from(articles).where(eq(articles.id, id));
    expect(row.imageCredit).toBe("Crédit initial");
  });
});
```

- [ ] **Step 2 : Lancer les tests pour vérifier qu'ils échouent**

Run: `bun test tests/article-actions.test.ts`
Expected: FAIL — `fixArticleFields` n'est pas exporté.

- [ ] **Step 3 : Ajouter le schéma**

Dans `lib/validation.ts` :

```ts
// Chaque champ est optionnel : la correction est PARTIELLE par nature — on ne renseigne que ce
// qui manque. Un champ absent de l'entrée n'est pas touché en base (voir fixArticleFields).
// Le garde-fou SSRF est appliqué ici, au plus près de la saisie, avec le même prédicat que la
// publication : inutile d'accepter une URL que WordPress refusera ensuite de télécharger.
export const fixFieldsSchema = z.object({
  id: z.string().uuid(),
  categoryId: z.string().uuid().optional(),
  featuredImageUrl: z.string().url("URL d'image invalide")
    .refine(isSafePublicHttpUrl, "URL d'image non autorisée").optional(),
  imageCredit: z.string().trim().min(1, "Crédit vide").optional(),
  imageSourceUrl: z.string().url("URL source invalide")
    .refine(isSafePublicHttpUrl, "URL source non autorisée").optional(),
});
export type FixFieldsInput = z.infer<typeof fixFieldsSchema>;
```

avec `import { isSafePublicHttpUrl } from "@/lib/url-guard";` en tête de `lib/validation.ts`.

- [ ] **Step 4 : Implémenter l'action**

Dans `lib/actions/article-actions.ts` :

```ts
/**
 * Correction ciblée des informations manquantes, depuis /queue (fix-popover) ou ailleurs.
 * Écrit UNIQUEMENT les champs fournis, puis RECALCULE articles.missing_fields avec le même
 * module que le pipeline — c'est ce qui garantit que le badge de la file, l'encadré de l'aperçu
 * et le refus de publication racontent tous la même chose.
 */
export async function fixArticleFields(
  input: FixFieldsInput,
): Promise<{ ok: boolean; message: string; missingFields: MissingField[] }> {
  const user = await requireUser();
  requirePermission(user.role, "article", "edit");
  const data = fixFieldsSchema.parse(input);

  const { articleSources, wpCategories, articleTags } = await import("@/db");
  const { checkCompleteness, sortMissingFields } = await import("@/lib/pipeline/completeness");

  // Seuls les champs réellement fournis entrent dans le SET — un champ absent garde sa valeur.
  const patch: Record<string, unknown> = { updatedAt: new Date() };
  if (data.categoryId !== undefined) patch.categoryId = data.categoryId;
  if (data.featuredImageUrl !== undefined) patch.featuredImageUrl = data.featuredImageUrl;
  if (data.imageCredit !== undefined) patch.imageCredit = data.imageCredit;
  if (data.imageSourceUrl !== undefined) patch.imageSourceUrl = data.imageSourceUrl;
  await db.update(articles).set(patch).where(eq(articles.id, data.id));

  // Relecture APRÈS écriture : le recalcul doit porter sur l'état réel de la ligne, jamais sur
  // une reconstitution en mémoire de ce qu'on croit avoir écrit.
  const [row] = await db.select({
    category: wpCategories.name, bodyHtml: articles.bodyHtml, excerpt: articles.excerpt,
    featuredImageUrl: articles.featuredImageUrl, imageCredit: articles.imageCredit,
    imageSourceUrl: articles.imageSourceUrl, confidenceFlags: articles.confidenceFlags,
  }).from(articles)
    .leftJoin(wpCategories, eq(articles.categoryId, wpCategories.id))
    .where(eq(articles.id, data.id)).limit(1);
  if (!row) return { ok: false, message: "Article introuvable.", missingFields: [] };

  const [sources, tags, allCategories] = await Promise.all([
    db.select({ mediaName: articleSources.mediaName, url: articleSources.url })
      .from(articleSources).where(eq(articleSources.articleId, data.id)),
    db.select({ tagName: articleTags.tagName }).from(articleTags).where(eq(articleTags.articleId, data.id)),
    db.select({ name: wpCategories.name }).from(wpCategories),
  ]);

  const categoryNames = allCategories.map((c) => c.name);
  const missingFields = sortMissingFields(checkCompleteness(
    {
      // Une catégorie non résolue donne category: "" — absente de categoryNames, donc
      // correctement signalée comme manquante.
      category: row.category ?? "",
      bodyHtml: row.bodyHtml, excerpt: row.excerpt ?? "",
      tags: tags.map((t) => t.tagName),
      featuredImageUrl: row.featuredImageUrl, imageCredit: row.imageCredit,
      imageSourceUrl: row.imageSourceUrl,
      // Le doute initial de l'IA sur la catégorie est levé dès qu'un humain en choisit une.
      confidence: data.categoryId !== undefined
        ? { ...row.confidenceFlags, categoryUncertain: false }
        : (row.confidenceFlags ?? {}),
    },
    sources, categoryNames,
  ));

  await db.update(articles).set({ missingFields }).where(eq(articles.id, data.id));
  await db.insert(articleRevisions).values({
    articleId: data.id, actorId: user.id, action: "informations complétées",
    detail: Object.keys(patch).filter((k) => k !== "updatedAt").join(", "),
  });

  revalidatePath("/queue");
  revalidatePath(`/article/${data.id}`);
  return { ok: true, message: "Informations enregistrées.", missingFields };
}
```

- [ ] **Step 5 : Lancer les tests pour vérifier qu'ils passent**

Run: `bun test tests/article-actions.test.ts`
Expected: PASS.

- [ ] **Step 6 : Créer `components/queue/fix-popover.tsx`**

```tsx
"use client";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { RoleGate } from "@/components/role-gate";
import { fixArticleFields } from "@/lib/actions/article-actions";
import { MISSING_LABEL, type MissingField } from "@/lib/pipeline/completeness";
import type { QueueRow } from "@/lib/queries/queue";

export function FixPopover({
  row, categories,
}: {
  row: QueueRow;
  categories: { id: string; name: string }[];
}) {
  const [open, setOpen] = useState(false);
  const [categoryId, setCategoryId] = useState<string>("");
  const [imageUrl, setImageUrl] = useState("");
  const [credit, setCredit] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");
  const [isSaving, startSaving] = useTransition();

  const missing = row.missingFields;
  if (missing.length === 0) return <span className="text-muted-foreground">—</span>;

  // On ne montre QUE les champs réellement manquants : un formulaire complet obligerait à
  // relire des valeurs déjà correctes pour corriger un seul trou.
  const needs = (k: MissingField) => missing.includes(k);

  function handleSave() {
    startSaving(async () => {
      try {
        const res = await fixArticleFields({
          id: row.id,
          ...(categoryId ? { categoryId } : {}),
          ...(imageUrl.trim() ? { featuredImageUrl: imageUrl.trim() } : {}),
          ...(credit.trim() ? { imageCredit: credit.trim() } : {}),
          ...(sourceUrl.trim() ? { imageSourceUrl: sourceUrl.trim() } : {}),
        });
        if (res.missingFields.length === 0) toast.success("Article complet.");
        else toast.success(`Enregistré — reste ${res.missingFields.length} manque(s).`);
        setOpen(false);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Échec de l'enregistrement.");
      }
    });
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Badge variant="outline"
            className="cursor-pointer border-amber-500/50 text-amber-700 dark:text-amber-400"
            title={missing.map((m) => MISSING_LABEL[m]).join(", ")}>
            {missing.length} manque{missing.length > 1 ? "s" : ""}
          </Badge>
        }
      />
      <PopoverContent className="w-80 space-y-3">
        <p className="text-sm font-medium">Compléter cet article</p>

        <RoleGate allow={["admin", "editor"]}>
          {needs("categoryId") && (
            <div className="space-y-1.5">
              <Label>Catégorie</Label>
              <Select value={categoryId} onValueChange={setCategoryId}>
                <SelectTrigger>
                  <SelectValue placeholder="Choisir…">
                    {(v: string) => categories.find((c) => c.id === v)?.name ?? "Choisir…"}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {categories.map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          )}

          {needs("featuredImageUrl") && (
            <div className="space-y-1.5">
              <Label htmlFor={`img-${row.id}`}>URL de l&apos;image</Label>
              <Input id={`img-${row.id}`} value={imageUrl} placeholder="https://…"
                onChange={(e) => setImageUrl(e.target.value)} />
            </div>
          )}

          {needs("imageCredit") && (
            <div className="space-y-1.5">
              <Label htmlFor={`credit-${row.id}`}>Crédit image</Label>
              <Input id={`credit-${row.id}`} value={credit} placeholder="Ecofin"
                onChange={(e) => setCredit(e.target.value)} />
            </div>
          )}

          {needs("imageSourceUrl") && (
            <div className="space-y-1.5">
              <Label htmlFor={`src-${row.id}`}>Source de l&apos;image</Label>
              <Input id={`src-${row.id}`} value={sourceUrl} placeholder="https://…"
                onChange={(e) => setSourceUrl(e.target.value)} />
            </div>
          )}

          {/* « Sources » n'est pas corrigeable ici : un article sans source ne peut pas en
              recevoir une à la main depuis la file — c'est un cas de rejet. */}
          {missing.includes("sources") && (
            <p className="text-xs text-destructive">
              Aucune source : cet article ne peut pas être publié.
            </p>
          )}

          <Button size="sm" className="w-full" disabled={isSaving} onClick={handleSave}>
            {isSaving ? "Enregistrement…" : "Enregistrer"}
          </Button>
        </RoleGate>
      </PopoverContent>
    </Popover>
  );
}
```

- [ ] **Step 7 : Brancher le popover sur la colonne « Complétude »**

La colonne de la Task 2 rend un badge inerte ; elle rend désormais `<FixPopover>`. Les colonnes
ayant besoin de la liste des catégories, transformer `columns` en fabrique :

```tsx
export function buildColumns(categories: { id: string; name: string }[]): ColumnDef<QueueRow>[] { … }
```

et faire remonter `categories` depuis `QueueView` → `QueueTable` → `buildColumns`. Remplacer
`columns.length` par `cols.length` dans le `colSpan` de l'état vide.

- [ ] **Step 8 : Vérifier**

Run: `bun run typecheck && bun test`
Expected: aucune erreur ; suite verte.

- [ ] **Step 9 : Vérification visuelle du parcours complet**

Run: `bun run dev`
1. Sur `/queue`, repérer un article marqué « 2 manques ».
2. Cliquer le badge, choisir une catégorie et saisir un crédit, enregistrer.
3. Expected: le badge disparaît ou décompte ; sélectionner l'article et « Approuver et publier »
   ne le rejette plus pour informations manquantes.

- [ ] **Step 10 : Commit**

```bash
git add components/queue lib/actions/article-actions.ts lib/validation.ts tests/article-actions.test.ts
git commit -m "feat(queue): inline fix popover — complete an article without leaving the queue"
```

---

## Vérification finale du sous-projet

- [ ] `bun run typecheck` — aucune erreur
- [ ] `bun test` — suite complète verte
- [ ] `bun run build` — build de production réussi
- [ ] Parcours aux trois rôles : un journaliste ne voit ni les actions en lot, ni le formulaire
      de correction (seulement « Aperçu » et « Ouvrir »)
- [ ] Les filtres survivent à un aller-retour par la barre latérale, et une URL partagée
      l'emporte sur la mémoire

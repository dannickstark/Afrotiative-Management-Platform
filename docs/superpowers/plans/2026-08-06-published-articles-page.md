# Published Articles Page (`/published`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the `/published` stub with a real, server-side, filtered + paginated list of currently-published articles.

**Architecture:** A server component reads filters/pagination from URL search params, runs one paginated Drizzle query (`getPublishedArticles`), and renders a server table + client filter/pagination controls that drive the URL. The WordPress "view live" URL is reconstructed server-side onto each row.

**Tech Stack:** Next.js 16 (App Router, Turbopack), Drizzle ORM + Postgres (Neon), shadcn/ui, `bun test`.

## Global Constraints

- **French UI copy** for every user-facing string (labels, headers, empty states).
- **Server-side, URL-driven** — filters/pagination live in the URL search params; never load the full set and filter client-side (the list is unbounded).
- **Client-bundle safety** — `wpUrl` is computed **server-side** onto each `PublishedRow`. Client components (`"use client"`) import only React/`next/navigation`, UI primitives, and **types** (`import type`) — never a value import of `@/db` or a server query module.
- **Access** — authenticated read-only; **no role/permission gate** (the nav entry has no `roles`, and `lib/rbac.ts` has no `article:read`). The `(app)` layout already calls `requireUser()`; the page also calls it (explicit, harmless).
- **Next 16** — `searchParams` is a `Promise`; `await` it before reading. Consult `node_modules/next/dist/docs/` for App Router conventions before writing page code.
- **No migration** — all data already exists (`articles.status='published'`, `publishedAt`, `featuredImageUrl`, `aiAuthor`; `distributions.externalId`).
- **Tests** run against the real Neon dev DB (`test-setup.ts`); pure helpers are tested with no DB.
- **Filter → categoryId** — the category filter is by `articles.categoryId` (the `wpCategories.id` uuid), not by name.

---

### Task 1: Pure `wpPostUrl` helper

**Files:**
- Create: `lib/wp/post-url.ts`
- Test: `tests/published.test.ts`

**Interfaces:**
- Produces: `wpPostUrl(baseUrl: string | null | undefined, postId: string | null): string | null` — the live WP permalink `<base>/?p=<id>`, or `null` if either is missing.

- [ ] **Step 1: Write the failing test**

Create `tests/published.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import { wpPostUrl } from "@/lib/wp/post-url";

describe("wpPostUrl", () => {
  it("builds the ?p= permalink and strips a trailing slash on the base", () => {
    expect(wpPostUrl("https://wp.example.com", "123")).toBe("https://wp.example.com/?p=123");
    expect(wpPostUrl("https://wp.example.com/", "123")).toBe("https://wp.example.com/?p=123");
  });
  it("encodes the post id", () => {
    expect(wpPostUrl("https://wp.example.com", "a b")).toBe("https://wp.example.com/?p=a%20b");
  });
  it("returns null when base or id is missing", () => {
    expect(wpPostUrl(null, "123")).toBeNull();
    expect(wpPostUrl(undefined, "123")).toBeNull();
    expect(wpPostUrl("https://wp.example.com", null)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/published.test.ts`
Expected: FAIL — cannot resolve `@/lib/wp/post-url`.

- [ ] **Step 3: Write the implementation**

Create `lib/wp/post-url.ts`:

```ts
// The live WordPress URL is not stored (only distributions.externalId = the post id), so reconstruct
// the ?p=<id> permalink — it resolves on any WP regardless of pretty-permalink settings. Pure and
// DB-free so both server queries and (if ever needed) client components can import it safely.
export function wpPostUrl(baseUrl: string | null | undefined, postId: string | null): string | null {
  if (!baseUrl || !postId) return null;
  return `${baseUrl.replace(/\/$/, "")}/?p=${encodeURIComponent(postId)}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/published.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/wp/post-url.ts tests/published.test.ts
git commit -m "feat(wp): pure wpPostUrl helper (reconstruct ?p= permalink)"
```

---

### Task 2: Types + `parsePublishedSearchParams` (pure)

**Files:**
- Create: `lib/queries/published.ts` (pure part only — no `@/db` import yet)
- Test: `tests/published.test.ts` (append)

**Interfaces:**
- Produces:
  - `PublishedFilters`, `PublishedRow`, `PublishedPage` types (below)
  - `PUBLISHED_PAGE_SIZE = 25`
  - `parsePublishedSearchParams(sp: Record<string, string | string[] | undefined>): PublishedFilters`

- [ ] **Step 1: Write the failing test**

Append to `tests/published.test.ts`:

```ts
import { parsePublishedSearchParams, PUBLISHED_PAGE_SIZE } from "@/lib/queries/published";

describe("parsePublishedSearchParams", () => {
  it("defaults empty params to page 1, default page size, no filters", () => {
    expect(parsePublishedSearchParams({})).toEqual({
      search: undefined, categoryId: undefined, from: undefined, to: undefined,
      author: undefined, page: 1, pageSize: PUBLISHED_PAGE_SIZE,
    });
  });
  it("reads and trims q/cat, parses valid dates, and accepts the author enum", () => {
    const f = parsePublishedSearchParams({ q: "  brvm ", cat: "cat-1", from: "2026-08-01", to: "2026-08-06", author: "ai", page: "3" });
    expect(f.search).toBe("brvm");
    expect(f.categoryId).toBe("cat-1");
    expect(f.from).toEqual(new Date("2026-08-01"));
    expect(f.to).toEqual(new Date("2026-08-06"));
    expect(f.author).toBe("ai");
    expect(f.page).toBe(3);
  });
  it("drops invalid dates, unknown author, and clamps page to >= 1", () => {
    const f = parsePublishedSearchParams({ from: "not-a-date", author: "robot", page: "0" });
    expect(f.from).toBeUndefined();
    expect(f.author).toBeUndefined();
    expect(f.page).toBe(1);
    expect(parsePublishedSearchParams({ page: "-4" }).page).toBe(1);
    expect(parsePublishedSearchParams({ page: "abc" }).page).toBe(1);
  });
  it("takes the first value of an array param", () => {
    expect(parsePublishedSearchParams({ q: ["first", "second"] }).search).toBe("first");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/published.test.ts`
Expected: FAIL — cannot resolve `parsePublishedSearchParams`/`PUBLISHED_PAGE_SIZE`.

- [ ] **Step 3: Write the pure module**

Create `lib/queries/published.ts` (types + parser only — the DB query is added in Task 3):

```ts
export type PublishedFilters = {
  search?: string; categoryId?: string; from?: Date; to?: Date;
  author?: "ai" | "human"; page: number; pageSize: number;
};
export type PublishedRow = {
  id: string; title: string; categoryName: string | null;
  publishedAt: Date; imageUrl: string | null; aiAuthor: boolean;
  wpUrl: string | null; // live WP link, computed server-side (see getPublishedArticles)
};
export type PublishedPage = { rows: PublishedRow[]; total: number; page: number; pageCount: number };

export const PUBLISHED_PAGE_SIZE = 25;

// Pure: map raw URL search params → typed filters (no DB/DOM). Invalid dates / unknown author /
// blank strings are dropped; page clamps to >= 1; pageSize is fixed. Mirrors filterRuns/resolveRunParams.
export function parsePublishedSearchParams(
  sp: Record<string, string | string[] | undefined>,
): PublishedFilters {
  const str = (v: string | string[] | undefined): string | undefined => {
    const s = Array.isArray(v) ? v[0] : v;
    return s && s.trim() ? s.trim() : undefined;
  };
  const date = (v: string | string[] | undefined): Date | undefined => {
    const s = str(v);
    if (!s) return undefined;
    const t = Date.parse(s);
    return Number.isNaN(t) ? undefined : new Date(t);
  };
  const pageRaw = Number(str(sp.page));
  const page = Number.isFinite(pageRaw) && pageRaw >= 1 ? Math.floor(pageRaw) : 1;
  const authorRaw = str(sp.author);
  const author = authorRaw === "ai" || authorRaw === "human" ? authorRaw : undefined;
  return {
    search: str(sp.q), categoryId: str(sp.cat), from: date(sp.from), to: date(sp.to),
    author, page, pageSize: PUBLISHED_PAGE_SIZE,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/published.test.ts`
Expected: PASS (wpPostUrl + parse tests).

- [ ] **Step 5: Commit**

```bash
git add lib/queries/published.ts tests/published.test.ts
git commit -m "feat(published): PublishedFilters/Row/Page types + pure parsePublishedSearchParams"
```

---

### Task 3: `getPublishedArticles` DB query

**Files:**
- Modify: `lib/queries/published.ts` (add the query + its imports)
- Test: `tests/published-queries.test.ts`

**Interfaces:**
- Consumes: `wpPostUrl` (Task 1), the types + `PublishedFilters` (Task 2), `getWpConfig` (`lib/wp/config.ts`).
- Produces: `getPublishedArticles(f: PublishedFilters): Promise<PublishedPage>` — only `status='published'`, newest first, filtered + paginated, `wpUrl` built server-side.

- [ ] **Step 1: Write the failing test**

Create `tests/published-queries.test.ts` (seeds its own fixtures; FK-safe cleanup; sets WP env so `wpUrl` builds):

```ts
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { db, articles, wpCategories, distributions } from "@/db";
import { eq, inArray } from "drizzle-orm";
import { getPublishedArticles, PUBLISHED_PAGE_SIZE } from "@/lib/queries/published";

const envSnap: Record<string, string | undefined> = {};
const WP_ENV = { WP_BASE_URL: "https://wp.example.com", WP_USER: "u", WP_APP_PASSWORD: "p" };
const catIds: string[] = [];
const articleIds: string[] = [];

async function mkArticle(o: { title: string; catIdx: 0 | 1; ai: boolean; publishedAt: Date | null; status?: string; wpId?: string }) {
  const [a] = await db.insert(articles).values({
    title: o.title, bodyHtml: "<p>x</p>", status: (o.status ?? "published") as never,
    categoryId: catIds[o.catIdx], aiAuthor: o.ai, publishedAt: o.publishedAt,
  }).returning({ id: articles.id });
  articleIds.push(a.id);
  if (o.wpId) await db.insert(distributions).values({ articleId: a.id, channel: "wordpress", status: "sent", externalId: o.wpId, at: new Date() });
  return a.id;
}

describe("getPublishedArticles", () => {
  let recentId = "";
  beforeAll(async () => {
    for (const k of Object.keys(WP_ENV)) { envSnap[k] = process.env[k]; process.env[k] = (WP_ENV as Record<string,string>)[k]; }
    for (const name of ["PubTest Économie", "PubTest Sport"]) {
      const [c] = await db.insert(wpCategories).values({ name, slug: name.toLowerCase().replace(/\W+/g, "-") }).returning({ id: wpCategories.id });
      catIds.push(c.id);
    }
    // 3 published (distinct dates/cats/authors), 1 approved-never-published, 1 published-then-unpublished (approved + a wp dist).
    recentId = await mkArticle({ title: "PubTest BRVM record", catIdx: 0, ai: true, publishedAt: new Date("2026-08-06T10:00:00Z"), wpId: "501" });
    await mkArticle({ title: "PubTest Ancienne dépêche", catIdx: 1, ai: false, publishedAt: new Date("2026-08-01T10:00:00Z"), wpId: "502" });
    await mkArticle({ title: "PubTest Milieu", catIdx: 0, ai: true, publishedAt: new Date("2026-08-04T10:00:00Z"), wpId: "503" });
    await mkArticle({ title: "PubTest Brouillon", catIdx: 0, ai: true, publishedAt: null, status: "approved" });
    await mkArticle({ title: "PubTest Dépubliée", catIdx: 0, ai: true, publishedAt: null, status: "approved", wpId: "599" });
  });
  afterAll(async () => {
    if (articleIds.length) await db.delete(articles).where(inArray(articles.id, articleIds)); // cascades distributions
    if (catIds.length) await db.delete(wpCategories).where(inArray(wpCategories.id, catIds));
    for (const k of Object.keys(WP_ENV)) { if (envSnap[k] === undefined) delete process.env[k]; else process.env[k] = envSnap[k]; }
  });

  const base = { search: undefined, categoryId: undefined, from: undefined, to: undefined, author: undefined, page: 1, pageSize: 50 } as const;
  const mine = (p: Awaited<ReturnType<typeof getPublishedArticles>>) => p.rows.filter((r) => r.title.startsWith("PubTest"));

  it("returns only status='published', newest first, with wpUrl from the WP distribution", async () => {
    const p = await getPublishedArticles({ ...base });
    const rows = mine(p);
    expect(rows.map((r) => r.title)).toEqual(["PubTest BRVM record", "PubTest Milieu", "PubTest Ancienne dépêche"]);
    expect(rows.find((r) => r.id === recentId)!.wpUrl).toBe("https://wp.example.com/?p=501");
    // excluded: the approved-never-published and the unpublished one
    expect(rows.some((r) => r.title === "PubTest Brouillon" || r.title === "PubTest Dépubliée")).toBe(false);
  });
  it("filters by category, author, title search, and an inclusive end-of-day date range", async () => {
    expect(mine(await getPublishedArticles({ ...base, categoryId: catIds[1] })).map((r) => r.title)).toEqual(["PubTest Ancienne dépêche"]);
    expect(mine(await getPublishedArticles({ ...base, author: "human" })).map((r) => r.title)).toEqual(["PubTest Ancienne dépêche"]);
    expect(mine(await getPublishedArticles({ ...base, search: "record" })).map((r) => r.title)).toEqual(["PubTest BRVM record"]);
    // to = 2026-08-04 must INCLUDE an article published that day (end-of-day bound)
    const ranged = mine(await getPublishedArticles({ ...base, from: new Date("2026-08-02"), to: new Date("2026-08-04") }));
    expect(ranged.map((r) => r.title)).toEqual(["PubTest Milieu"]);
  });
  it("paginates: total counts all matches, rows are the page slice", async () => {
    const p1 = await getPublishedArticles({ ...base, pageSize: 2, page: 1 });
    expect(p1.total).toBeGreaterThanOrEqual(3);
    expect(p1.pageCount).toBeGreaterThanOrEqual(2);
    expect(PUBLISHED_PAGE_SIZE).toBe(25);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/published-queries.test.ts`
Expected: FAIL — `getPublishedArticles` is not exported.

- [ ] **Step 3: Add the query to `lib/queries/published.ts`**

Add the imports at the top and the function at the bottom:

```ts
import { db, articles, wpCategories, distributions } from "@/db";
import { and, eq, ilike, gte, lt, desc } from "drizzle-orm";
import { getWpConfig } from "@/lib/wp/config";
import { wpPostUrl } from "@/lib/wp/post-url";
```

```ts
export async function getPublishedArticles(f: PublishedFilters): Promise<PublishedPage> {
  const conds = [eq(articles.status, "published")];
  if (f.search) conds.push(ilike(articles.title, `%${f.search}%`));
  if (f.categoryId) conds.push(eq(articles.categoryId, f.categoryId));
  if (f.from) conds.push(gte(articles.publishedAt, f.from));
  if (f.to) {
    // Inclusive end-of-day: a date input gives midnight, so compare < to + 1 day to include that day.
    const end = new Date(f.to); end.setDate(end.getDate() + 1);
    conds.push(lt(articles.publishedAt, end));
  }
  if (f.author) conds.push(eq(articles.aiAuthor, f.author === "ai"));
  const where = and(...conds);

  const total = await db.$count(articles, where);
  const pageCount = Math.max(1, Math.ceil(total / f.pageSize));
  const page = Math.min(Math.max(1, f.page), pageCount); // clamp into range so an over-large ?page= still returns the last page

  // At most one wordpress distribution per article (upsertDistribution keeps a single row per
  // article+channel), so this leftJoin never multiplies rows.
  const rows = await db.select({
    id: articles.id, title: articles.title, categoryName: wpCategories.name,
    publishedAt: articles.publishedAt, imageUrl: articles.featuredImageUrl, aiAuthor: articles.aiAuthor,
    wpPostId: distributions.externalId,
  }).from(articles)
    .leftJoin(wpCategories, eq(articles.categoryId, wpCategories.id))
    .leftJoin(distributions, and(eq(distributions.articleId, articles.id), eq(distributions.channel, "wordpress")))
    .where(where)
    .orderBy(desc(articles.publishedAt))
    .limit(f.pageSize)
    .offset((page - 1) * f.pageSize);

  const baseUrl = getWpConfig()?.baseUrl ?? null;
  return {
    rows: rows.map((r) => ({
      id: r.id, title: r.title, categoryName: r.categoryName,
      publishedAt: r.publishedAt!, // status='published' guarantees publishedAt is set
      imageUrl: r.imageUrl, aiAuthor: r.aiAuthor, wpUrl: wpPostUrl(baseUrl, r.wpPostId),
    })),
    total, page, pageCount,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/published-queries.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

```bash
bun run typecheck
git add lib/queries/published.ts tests/published-queries.test.ts
git commit -m "feat(published): getPublishedArticles — filtered, paginated, WP link server-side"
```

---

### Task 4: Page + view + table + pagination (working paginated list)

**Files:**
- Modify: `app/(app)/published/page.tsx` (replace the stub)
- Create: `components/published/published-view.tsx`, `components/published/published-table.tsx`, `components/published/published-pagination.tsx`

**Interfaces:**
- Consumes: `getPublishedArticles`, `parsePublishedSearchParams`, `PublishedFilters`/`PublishedPage` (Tasks 2-3), `getTaxonomy` (`lib/queries/settings.ts`), `formatDate` (`lib/format.ts`).
- Produces: a rendered `/published` page with a server table and working URL-driven pagination (filters added in Task 5).

No unit test (no component-test harness). Gate: `bun run typecheck` + `bun run build` both exit 0, plus manual check.

- [ ] **Step 1: Replace the page stub — `app/(app)/published/page.tsx`**

```tsx
import { requireUser } from "@/lib/session";
import { getPublishedArticles, parsePublishedSearchParams } from "@/lib/queries/published";
import { getTaxonomy } from "@/lib/queries/settings";
import { PublishedView } from "@/components/published/published-view";

export default async function PublishedPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireUser();
  const filters = parsePublishedSearchParams(await searchParams);
  const [page, { categories }] = await Promise.all([getPublishedArticles(filters), getTaxonomy()]);
  return (
    <PublishedView
      page={page}
      filters={filters}
      categories={categories.map((c) => ({ id: c.id, name: c.name }))}
    />
  );
}
```

- [ ] **Step 2: Server table — `components/published/published-table.tsx`**

```tsx
import Link from "next/link";
import { ExternalLink } from "lucide-react";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { formatDate } from "@/lib/format";
import type { PublishedRow } from "@/lib/queries/published";

export function PublishedTable({ rows, filtered }: { rows: PublishedRow[]; filtered: boolean }) {
  if (rows.length === 0) {
    return (
      <p className="rounded-lg border py-10 text-center text-sm text-muted-foreground">
        {filtered ? "Aucun résultat pour ces filtres." : "Aucun article publié pour l'instant."}
      </p>
    );
  }
  return (
    <div className="rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Article</TableHead>
            <TableHead>Catégorie</TableHead>
            <TableHead>Publié le</TableHead>
            <TableHead>Auteur</TableHead>
            <TableHead className="text-right">WordPress</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={r.id}>
              <TableCell>
                <Link href={`/article/${r.id}`} className="flex items-center gap-3 hover:underline">
                  {r.imageUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={r.imageUrl} alt="" className="size-10 shrink-0 rounded object-cover" />
                  ) : (
                    <div className="size-10 shrink-0 rounded bg-muted" />
                  )}
                  <span className="line-clamp-2 font-medium">{r.title}</span>
                </Link>
              </TableCell>
              <TableCell>{r.categoryName ?? "—"}</TableCell>
              <TableCell className="whitespace-nowrap">{formatDate(r.publishedAt)}</TableCell>
              <TableCell><Badge variant="outline">{r.aiAuthor ? "IA" : "Humain"}</Badge></TableCell>
              <TableCell className="text-right">
                {r.wpUrl ? (
                  <a href={r.wpUrl} target="_blank" rel="noopener noreferrer"
                     className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground">
                    Voir <ExternalLink className="size-3.5" />
                  </a>
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
```

- [ ] **Step 3: Pagination (client) — `components/published/published-pagination.tsx`**

```tsx
"use client";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";

export function PublishedPagination({ page, pageCount }: { page: number; pageCount: number }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  function goto(p: number) {
    const params = new URLSearchParams(searchParams.toString());
    params.set("page", String(p));
    router.push(`${pathname}?${params.toString()}`);
  }

  return (
    <div className="flex items-center justify-end gap-2 text-sm text-muted-foreground">
      <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => goto(page - 1)}>Précédent</Button>
      <span>Page {page} / {pageCount}</span>
      <Button variant="outline" size="sm" disabled={page >= pageCount} onClick={() => goto(page + 1)}>Suivant</Button>
    </div>
  );
}
```

- [ ] **Step 4: View (server) — `components/published/published-view.tsx`**

(Note: `PublishedFilterBar` is added in Task 5; this Task 4 version renders header + table + pagination only.)

```tsx
import { PublishedTable } from "./published-table";
import { PublishedPagination } from "./published-pagination";
import type { PublishedFilters, PublishedPage } from "@/lib/queries/published";

export function PublishedView({
  page, filters, categories,
}: {
  page: PublishedPage;
  filters: PublishedFilters;
  categories: { id: string; name: string }[];
}) {
  const filtered = Boolean(filters.search || filters.categoryId || filters.from || filters.to || filters.author);
  void categories; // used by the filter bar in Task 5
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Articles publiés</h1>
        <span className="text-sm text-muted-foreground">{page.total} article{page.total > 1 ? "s" : ""}</span>
      </div>
      <PublishedTable rows={page.rows} filtered={filtered} />
      <PublishedPagination page={page.page} pageCount={page.pageCount} />
    </div>
  );
}
```

- [ ] **Step 5: Verify typecheck + build**

Run: `bun run typecheck` (exit 0), then `bun run build` (exit 0).
Expected: `/published` compiles as a dynamic route; no client-bundle "Module not found".

- [ ] **Step 6: Manual check**

Via the `run` skill or `bun dev`, open `/published` as any signed-in user: the list renders newest-first with thumbnail/title(link)/category/date/author/WordPress-link, an empty state when there are none, and `?page=2` (or the Suivant button) advances the page.

- [ ] **Step 7: Commit**

```bash
git add "app/(app)/published/page.tsx" components/published/
git commit -m "feat(published): server-rendered paginated list replaces the /published stub"
```

---

### Task 5: Filter bar (client, URL-driven)

**Files:**
- Create: `components/published/published-filter-bar.tsx`
- Modify: `components/published/published-view.tsx` (render the filter bar)

**Interfaces:**
- Consumes: `PublishedFilters` type (Task 2), the categories prop.
- Produces: `<PublishedFilterBar filters categories />` — search + category + date range + author controls that update the URL and reset to page 1.

No unit test. Gate: `bun run typecheck` + `bun run build` + manual.

- [ ] **Step 1: Build the filter bar — `components/published/published-filter-bar.tsx`**

```tsx
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

      <Select value={filters.categoryId ?? "all"} onValueChange={(v) => setParams({ cat: v === "all" ? undefined : v })}>
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

      <Select value={filters.author ?? "all"} onValueChange={(v) => setParams({ author: v === "all" ? undefined : v })}>
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
```

- [ ] **Step 2: Render it in the view**

In `components/published/published-view.tsx`: add the import, remove the `void categories;` line, and render `<PublishedFilterBar>` above the table:

```tsx
import { PublishedFilterBar } from "./published-filter-bar";
// ...
      </div>
      <PublishedFilterBar filters={filters} categories={categories} />
      <PublishedTable rows={page.rows} filtered={filtered} />
```

- [ ] **Step 3: Verify typecheck + build**

Run: `bun run typecheck` (exit 0), then `bun run build` (exit 0).

- [ ] **Step 4: Manual check**

Open `/published`: typing in search narrows after ~300ms; selecting a category / author / date range narrows the list and resets to page 1; all state is reflected in the URL (`?q=…&cat=…&from=…&to=…&author=…`) and survives a reload.

- [ ] **Step 5: Commit**

```bash
git add components/published/
git commit -m "feat(published): URL-driven filter bar (search, category, date range, author)"
```

---

### Task 6: Full verification

**Files:** none (verification only).

- [ ] **Step 1: Typecheck** — `bun run typecheck` → exit 0.
- [ ] **Step 2: Full suite** — `bun test` → all green (new `published`, `published-queries`, plus existing).
- [ ] **Step 3: Build** — `bun run build` → exit 0, `/published` listed as a dynamic route.
- [ ] **Step 4:** Confirm the nav already links `/published` (`components/shell/nav-items.ts` — "Articles publiés") so the page is reachable; no nav change needed.

---

## Self-Review

**Spec coverage:**
- Currently-published only, newest first → Task 3 (`status='published'`, `desc(publishedAt)`). ✅
- Read-only rows: link to `/article/[id]` + reconstructed "Voir sur WordPress" → Tasks 1, 3, 4. ✅
- Rich filtering (search + category + date range + AI/human author) + pagination, server-side/URL-driven → Tasks 2, 3, 4, 5. ✅
- Authenticated read-only, no role gate → Task 4 (`requireUser`, no permission check). ✅
- WP URL reconstructed server-side onto each row (client-bundle safe) → Tasks 1, 3. ✅
- Inclusive end-of-day `to` bound → Task 3 (`< to + 1 day`), tested. ✅
- No migration → confirmed (no schema change in any task). ✅

**Type consistency:** `PublishedFilters`/`PublishedRow`/`PublishedPage` defined in Task 2 are consumed unchanged by Task 3 (`getPublishedArticles`), Task 4 (page/view/table/pagination), and Task 5 (filter bar). `wpUrl: string | null` on the row (Task 2) is produced in Task 3 and read in Task 4's table. `categories: { id; name }[]` shape is produced by the page (Task 4) and consumed by the filter bar (Task 5).

**Placeholder scan:** no TBD/TODO; every code step has real content and every test has real assertions.

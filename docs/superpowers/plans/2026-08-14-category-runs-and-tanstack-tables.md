# Category-scoped Runs + TanStack Tables Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add category-scoped manual pipeline runs, and migrate all 7 table screens to a shared TanStack DataTable with sorting + search + per-column filters (fixing `/queue` header sorting).

**Architecture:** Feature A threads a `categoryIds` field through the existing `RunParams` plumbing and enforces "filter output" in `stageSources` after AI classification. Feature B adds a shared `DataTable` client primitive over `@tanstack/react-table` + shadcn `Table`, with two modes — server-side URL-driven sort for the paginated tables (queue, published) and client-side sort/filter for the fully-loaded tables.

**Tech Stack:** Next.js (customized — see AGENTS.md), React (RSC pages → client table components), Drizzle/Postgres, `@tanstack/react-table@8.21.3` (already installed), shadcn/ui table, bun test, Zod.

**Spec:** `docs/superpowers/specs/2026-08-14-category-runs-and-tanstack-tables-design.md` (read it — the plan argues from it).

## Global Constraints

- No new runtime dependency. `@tanstack/react-table@8.21.3` is already present; do NOT add react-query/react-virtual.
- Server-side sort MUST use a hardcoded column allowlist mapping `?sort` values → Drizzle order expressions. NEVER interpolate the raw `sort` param into SQL.
- Category scope `[]` normalizes to `null` (all categories) — never construct a run that can persist nothing.
- `StepRec.status` is `"success" | "failed"` only (`lib/pipeline/stages.ts:28`). Do NOT add a `skipped` value or any schema/enum migration. The category-skip step is a `success` step named `"Hors catégorie sélectionnée (ignoré)"`.
- Preserve every existing filter, pagination, and row-action behavior (row-click → detail sheet on runs; row selection on queue). The migration adds sort + per-column filters; it does NOT rewrite data fetching (RSC page → Drizzle query → props → client table).
- French UI copy, consistent with existing screens.
- `bun run test:pure` stays green; `bunx tsc --noEmit` clean. **Do NOT register this plan's new test files in `scripts/test-fast.ts` PURE_FILES** — the `--pure` runner groups multiple files per worker and the studio-render DOM tests' per-file teardown makes co-scheduled files (e.g. studio-render-clippath) fail with `window is not defined`; adding files reshuffles the grouping and deterministically breaks them. New pure-logic tests run under plain `bun test <file>` (and CI's canonical full `bun test`), which is unaffected. Verify each new test with `bun test <file>` AND confirm `bun run test:pure` is still green (2 fails = you added to PURE_FILES; remove it).
- Customized Next.js: read `node_modules/next/dist/docs/` before touching any Next API (searchParams, RSC, route handlers).
- Commit after each task (or each green step). Branch: `feat/category-runs-and-tanstack-tables`.
- **TESTING APPROACH — no React component testing exists in this repo** (no `@testing-library`, zero `.test.tsx`; all tests are `.test.ts` over pure functions/queries/actions). Do NOT add a component-test framework. For UI tasks, make behavior testable by **extracting pure helpers** and unit-testing THOSE with `bun test` (sort resolvers, the sort-toggle state machine, column accessor/`sortingFn`/`filterFn` functions, param-builders). Interaction (clicking a header re-sorts, a filter narrows rows) is verified in the **browser preview** (dev server + Browser tools), not in a DOM unit test. Name new pure-logic test files `.test.ts` and register them in `scripts/test-fast.ts` PURE allowlist. Every table task MUST end with a browser-verification step against the running app.

---

# Feature A — Category-scoped pipeline runs

### Task A1: `categoryIds` in RunParams + validation + resolver

**Files:**
- Modify: `db/schema.ts:21-28` (the `RunParams` type)
- Modify: `lib/validation.ts:127-138` (`runParamsSchema`)
- Modify: `lib/pipeline/run-params.ts:10-20` (`resolveRunParams`)
- Test: `tests/run-params.test.ts` (create or extend if it exists)

**Interfaces:**
- Produces: `RunParams` now has `categoryIds: string[] | null`. `resolveRunParams(input, defaults)` normalizes `input.categoryIds` (`[]`→`null`, `undefined`→`null`) onto the resolved object. `runParamsSchema` accepts `categoryIds: string[] | null | undefined`.
- Consumes: existing `RunParams`/`runParamsSchema`/`resolveRunParams` shapes (mirror the `feedIds` field exactly).

- [ ] **Step 1: Read** `db/schema.ts:21-28`, `lib/validation.ts:127-138`, `lib/pipeline/run-params.ts` to copy the `feedIds` handling pattern precisely (nullability, defaulting).

- [ ] **Step 2: Write failing tests** in `tests/run-params.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import { resolveRunParams } from "@/lib/pipeline/run-params";
import { runParamsSchema } from "@/lib/validation";

describe("resolveRunParams categoryIds", () => {
  it("passes through a category id array", () => {
    const r = resolveRunParams({ categoryIds: ["11111111-1111-1111-1111-111111111111"] } as any, {} as any);
    expect(r.categoryIds).toEqual(["11111111-1111-1111-1111-111111111111"]);
  });
  it("normalizes empty array to null (no scope)", () => {
    const r = resolveRunParams({ categoryIds: [] } as any, {} as any);
    expect(r.categoryIds).toBeNull();
  });
  it("defaults missing categoryIds to null", () => {
    const r = resolveRunParams({} as any, {} as any);
    expect(r.categoryIds).toBeNull();
  });
});

describe("runParamsSchema categoryIds", () => {
  it("accepts null", () => { expect(runParamsSchema.parse({ categoryIds: null }).categoryIds).toBeNull(); });
  it("accepts a uuid array", () => {
    const v = runParamsSchema.parse({ categoryIds: ["11111111-1111-1111-1111-111111111111"] });
    expect(v.categoryIds).toHaveLength(1);
  });
  it("rejects a non-uuid entry", () => {
    expect(() => runParamsSchema.parse({ categoryIds: ["not-a-uuid"] })).toThrow();
  });
});
```

- [ ] **Step 3: Run** `bun test tests/run-params.test.ts` — expect FAIL (field absent).

- [ ] **Step 4: Implement.** Add `categoryIds: string[] | null` to the `RunParams` type (`db/schema.ts`). In `runParamsSchema` add `categoryIds: z.array(z.string().uuid()).nullish()` (matching `feedIds`). In `resolveRunParams`, add `categoryIds: input.categoryIds && input.categoryIds.length > 0 ? input.categoryIds : null` (mirroring feedIds normalization; confirm feedIds' exact style and match it).

- [ ] **Step 5: Run** `bun test tests/run-params.test.ts` and `bunx tsc --noEmit` — expect PASS/clean.

- [ ] **Step 6: Commit** `feat(pipeline): categoryIds in RunParams + validation`.

---

### Task A2: Enforce category scope in the run (executeRun + stageSources)

**Files:**
- Modify: `lib/pipeline/run.ts:198` (load `{id,name}` categories; build scope) and the `stageSources(...)` call site (`run.ts:486`)
- Modify: `lib/pipeline/stages.ts` (`stageSources` signature + skip logic before "Dépôt en revue")
- Test: `tests/stage-category-scope.test.ts` (create)

**Interfaces:**
- Consumes: `RunParams.categoryIds` (Task A1); existing `stageSources(sources, categoryNames, hooks?, timeoutMs?, autoPublishCfg?)` signature.
- Produces: `stageSources(..., categoryScope?: Set<string> | null)` — a new trailing optional arg (default `null`). When non-null and the AI's `draft.category` is not in the set (or is empty), the story is not persisted, a `success` step `"Hors catégorie sélectionnée (ignoré)"` is appended, and `{ articleId: null, steps }` is returned.

- [ ] **Step 1: Read** `lib/pipeline/stages.ts` `stageSources` (around `:121-257`) to find the exact point after `repairDraft`/scoring and before the `persistArticle` "Dépôt en revue" `timedStep` (`:228`). Read `run.ts:198` (category-name load) and `:486` (stageSources call).

- [ ] **Step 2: Write failing test** `tests/stage-category-scope.test.ts` — drive `stageSources` with a stubbed AI that yields a known category, asserting the skip. Model it on the existing `stageSources`/`persistArticle` tests (find them first: `tests/auto-publish-run.test.ts` uses `persistArticle` directly; check how the AI/embed are faked network-free). Concretely, assert: given `categoryScope = new Set(["Sport"])` and a draft whose category is `"Économie"`, `stageSources` returns `articleId: null`, appends a step named `"Hors catégorie sélectionnée (ignoré)"` with `status: "success"`, and does NOT insert an article row (query count unchanged). And given `categoryScope = null` (or containing `"Économie"`), it persists as today. If a fully network-free `stageSources` drive is impractical (mock LLM sets `aiDegraded`), test the pure decision helper instead (see Step 4) and cover the wiring with a thin `stageSources` assertion on the skip branch only.

- [ ] **Step 3: Run** the test — expect FAIL.

- [ ] **Step 4: Implement.**
  - Extract a tiny pure helper in `stages.ts`: `export function isInCategoryScope(category: string | null | undefined, scope: Set<string> | null): boolean { if (scope === null) return true; return typeof category === "string" && scope.has(category); }`.
  - Add `categoryScope: Set<string> | null = null` as the trailing param of `stageSources`.
  - After the draft's category is final (post `repairDraft`, before the `persistArticle` timedStep at `:228`): `if (!isInCategoryScope(draft.category, categoryScope)) { const step: StepRec = { name: "Hors catégorie sélectionnée (ignoré)", status: "success", durationMs: 0 }; steps.push(step); await hooks.onStageStart?.(step.name); await hooks.onStageEnd?.(step); return { articleId: null, steps }; }` (match the existing best-effort hook pattern used by the "Publication automatique" step at `:239-251`; keep it never-throw).
  - In `run.ts`: change the category load at `:198` to select `{ id: wpCategories.id, name: wpCategories.name }`. Build `const categoryNames = cats.map(c => c.name)` (unchanged downstream) AND `const categoryScope = params.categoryIds && params.categoryIds.length > 0 ? new Set(cats.filter(c => params.categoryIds!.includes(c.id)).map(c => c.name)) : null;`. Pass `categoryScope` as the new trailing arg to `stageSources(...)` at `:486`.

- [ ] **Step 5: Run** `bun test tests/stage-category-scope.test.ts` + `bun run test:pure` + `bunx tsc --noEmit`.

- [ ] **Step 6: Commit** `feat(pipeline): filter run output by selected categories`.

---

### Task A3: Category multi-select in the run-config dialog

**Files:**
- Modify: `lib/actions/pipeline-actions.ts:40-54` (`getRunConfigOptions` returns categories)
- Modify: `components/pipeline/run-config-dialog.tsx` (category multi-select; `buildInput` includes `categoryIds`)
- Test: `tests/run-config-dialog.test.tsx` (create) or extend existing dialog test if present

**Interfaces:**
- Consumes: `RunParamsInput.categoryIds` (A1), `stageSources` scope (A2), `getRunConfigOptions()` result.
- Produces: `getRunConfigOptions()` returns `{ ...existing, categories: { id: string; name: string }[] }`. `buildInput()` sets `categoryIds: checkedCategoryIds.length ? checkedCategoryIds : null`.

- [ ] **Step 1: Read** `run-config-dialog.tsx` (feed multi-select at `:141-157`, `buildInput` at `:69-86`) and `getRunConfigOptions` (`:40-54`). Match the feed checkbox-list pattern exactly for categories.

- [ ] **Step 2: Write failing test** — a component/unit test asserting: given options with 3 categories, checking 2 makes `buildInput()` produce `categoryIds` with those 2 ids; checking none produces `categoryIds: null`. (Use the project's existing component-test approach — check how other `*.test.tsx` under `tests/` render/inspect; if the dialog logic is best tested via the pure `buildInput`, export/extract it and unit-test that.)

- [ ] **Step 3: Run** — expect FAIL.

- [ ] **Step 4: Implement.** Extend `getRunConfigOptions` to also `db.select({ id: wpCategories.id, name: wpCategories.name }).from(wpCategories).orderBy(wpCategories.name)`. Add a category checkbox multi-select block in the dialog beside the feed list (same styles/labels; heading e.g. "Catégories (toutes par défaut)"). Track checked ids in state; include them in `buildInput()` as above (null when empty).

- [ ] **Step 5: Run** the test + `bunx tsc --noEmit`; manually verify via the browser preview later.

- [ ] **Step 6: Commit** `feat(pipeline): category selector in run-config dialog`.

---

# Feature B — TanStack DataTable migration

### Task B1: Shared `DataTable` primitive + sortable header + toolbar

**Files:**
- Create: `components/ui/data-table.tsx`
- Create: `components/ui/data-table-column-header.tsx`
- Create: `components/ui/data-table-toolbar.tsx`
- Test: `tests/data-table-sort.test.ts` (pure `nextSortDir` helper; no DOM)

**Interfaces:**
- Produces:
  - `DataTable<TData>({ columns, data, sorting?, onSortingChange?, manualSorting?, globalFilter?, onGlobalFilterChange?, columnFilters?, onColumnFiltersChange?, toolbar?, onRowClick? }): JSX` — builds `useReactTable`. When `manualSorting` is true, `sorting`/`onSortingChange` are controlled and no `getSortedRowModel` is applied; otherwise it applies `getSortedRowModel` + `getFilteredRowModel` and manages state internally when the controlled props are absent.
  - `DataTableColumnHeader({ column, title })` — renders a button toggling asc→desc→none; shows `ArrowUp`/`ArrowDown`/`ArrowUpDown` (from `lucide-react`, already used in the codebase — verify import path). In manual mode it must call the same `column.toggleSorting()` API (TanStack routes it to `onSortingChange`).
  - `DataTableToolbar({ globalValue, onGlobalChange, children })` — a search `Input` + a slot (`children`) for per-column filter controls.
- Consumes: shadcn `Table*` from `@/components/ui/table`, `Input`/`Button` from `@/components/ui/*` (verify these exist).

- [ ] **Step 1: Read** `components/queue/queue-table.tsx` (existing `useReactTable` usage) and `components/ui/table.tsx`, `components/ui/input.tsx`, `components/ui/button.tsx` to match import style and props.

- [ ] **Step 2: Write failing tests** `tests/data-table-sort.test.ts` over a PURE sort-toggle helper (no DOM — see Global Constraints testing approach). Extract the header's click behavior into a pure function and test it:

```ts
import { describe, it, expect } from "bun:test";
import { nextSortDir } from "@/components/ui/data-table-column-header";
describe("nextSortDir (asc → desc → none cycle)", () => {
  it("false → asc", () => expect(nextSortDir(false)).toBe("asc"));
  it("asc → desc", () => expect(nextSortDir("asc")).toBe("desc"));
  it("desc → false (clear)", () => expect(nextSortDir("desc")).toBe(false));
});
```

Client-mode sorting/filtering themselves are TanStack's own well-tested row models — do not re-test the library. Our testable surface is the toggle state machine (above) and, in later tasks, each table's pure column accessor/`sortingFn`/`filterFn`. DOM interaction is browser-verified in Step 6.

- [ ] **Step 3: Run** — expect FAIL.

- [ ] **Step 4: Implement** the three components. `DataTable` core:

```tsx
"use client";
import { flexRender, getCoreRowModel, getSortedRowModel, getFilteredRowModel,
  useReactTable, type ColumnDef, type SortingState, type ColumnFiltersState,
  type OnChangeFn } from "@tanstack/react-table";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useState } from "react";

type Props<T> = {
  columns: ColumnDef<T, any>[]; data: T[];
  manualSorting?: boolean;
  sorting?: SortingState; onSortingChange?: OnChangeFn<SortingState>;
  globalFilter?: string; onGlobalFilterChange?: OnChangeFn<string>;
  columnFilters?: ColumnFiltersState; onColumnFiltersChange?: OnChangeFn<ColumnFiltersState>;
  onRowClick?: (row: T) => void; toolbar?: React.ReactNode; emptyMessage?: string;
};

export function DataTable<T>(p: Props<T>) {
  const [s, setS] = useState<SortingState>([]);
  const [cf, setCf] = useState<ColumnFiltersState>([]);
  const [gf, setGf] = useState("");
  const sorting = p.sorting ?? s, columnFilters = p.columnFilters ?? cf, globalFilter = p.globalFilter ?? gf;
  const table = useReactTable({
    data: p.data, columns: p.columns,
    state: { sorting, columnFilters, globalFilter },
    onSortingChange: p.onSortingChange ?? setS,
    onColumnFiltersChange: p.onColumnFiltersChange ?? setCf,
    onGlobalFilterChange: p.onGlobalFilterChange ?? setGf,
    getCoreRowModel: getCoreRowModel(),
    ...(p.manualSorting ? { manualSorting: true } : { getSortedRowModel: getSortedRowModel() }),
    getFilteredRowModel: getFilteredRowModel(),
  });
  // render toolbar + Table with flexRender for headers/cells; onRowClick on TableRow; emptyMessage when 0 rows.
}
```

Fill in the JSX (headers via `header.column.columnDef.header` through `flexRender`, cells via `flexRender(cell.column.columnDef.cell, cell.getContext())`). In `data-table-column-header.tsx`, export the pure `export function nextSortDir(cur: false | "asc" | "desc"): false | "asc" | "desc" { return cur === false ? "asc" : cur === "asc" ? "desc" : false; }` and have the header's onClick apply it via TanStack (`const d = nextSortDir(column.getIsSorted()); d === false ? column.clearSorting() : column.toggleSorting(d === "desc");`). Icon from `column.getIsSorted()`. Accessible (button, `aria-sort` on the `TableHead`).

- [ ] **Step 5: Run** `bun test tests/data-table-sort.test.ts` + `bunx tsc --noEmit`.

- [ ] **Step 6: Commit** `feat(ui): shared TanStack DataTable primitive`. (Browser verification happens in Task B2, the first table to render it.)

---

### Task B2: Queue server-side header sorting (fixes /queue)

**Files:**
- Modify: `lib/queries/queue.ts` (`orderBy` at `:102-116`; add sort param)
- Modify: `app/(app)/queue/page.tsx` (parse `?sort`/`?dir`)
- Modify: `components/queue/columns.tsx` (sortable headers via `DataTableColumnHeader`)
- Modify: `components/queue/queue-table.tsx` (controlled manual sorting → URL)
- Modify: `components/queue/queue-filters.tsx:112-119` (REMOVE the sort `<Select>`)
- Test: `tests/queue-sort.test.ts`

**Interfaces:**
- Consumes: `DataTable` + `DataTableColumnHeader` (B1).
- Produces: `resolveQueueSort(sort?: string, dir?: string): { column: QueueSortCol; direction: "asc"|"desc" }` (exported from `lib/queries/queue.ts`) with an allowlist `QueueSortCol` ∈ {`"title"`,`"category"`,`"score"`,`"date"`,`"source"`,`"status"`}; unknown → default (`date` desc = newest). `getQueue(filters)` accepts `filters.sort`/`filters.dir` and applies the mapped `orderBy`.

- [ ] **Step 1: Read** `lib/queries/queue.ts` (esp. `orderBy` `:102-105`, `parseQueueSearchParams`), `columns.tsx`, `queue-table.tsx`, `queue-filters.tsx`.

- [ ] **Step 2: Write failing test** `tests/queue-sort.test.ts` for the pure allowlist resolver:

```ts
import { describe, it, expect } from "bun:test";
import { resolveQueueSort } from "@/lib/queries/queue";
describe("resolveQueueSort", () => {
  it("maps known column+dir", () => expect(resolveQueueSort("score","asc")).toEqual({ column:"score", direction:"asc" }));
  it("defaults unknown column to date desc", () => expect(resolveQueueSort("evil;DROP","asc")).toEqual({ column:"date", direction:"desc" }));
  it("defaults bad dir to desc", () => expect(resolveQueueSort("title","sideways").direction).toBe("desc"));
});
```

- [ ] **Step 3: Run** — expect FAIL.

- [ ] **Step 4: Implement.** Add `resolveQueueSort` with an explicit `Record<QueueSortCol, SQL>` order map (e.g. `title: articles.title`, `score: sql\`${articles.score} desc nulls last\`` adapted for direction, `date: articles.createdAt`/the existing default column, `category: wpCategories.name`, `source: <source expr>`, `status: articles.status`). Use it in `getQueue`. Parse `?sort`/`?dir` in `parseQueueSearchParams` (page). In `columns.tsx`, replace plain string headers with `header: ({ column }) => <DataTableColumnHeader column={column} title="Titre" />` for sortable columns (keep `enableSorting:false` ones as plain text). In `queue-table.tsx`, set `manualSorting`, derive `sorting` from the URL params, and `onSortingChange` → `router.push` updating `?sort`/`?dir` (toggle asc→desc→remove). Remove the `<Select>` sort control from `queue-filters.tsx`.

- [ ] **Step 5: Run** `bun test tests/queue-sort.test.ts` + `bun run test:pure` + `bunx tsc --noEmit`. Later: browser-verify `/queue` header clicks re-sort across pages.

- [ ] **Step 6: Commit** `feat(queue): click-to-sort headers (server-side) + remove sort dropdown`.

---

### Task B3: Published server-side header sorting + DataTable

**Files:**
- Modify: `lib/queries/published.ts:74` (parametrize `orderBy`)
- Modify: `app/(app)/published/page.tsx` (parse `?sort`/`?dir`)
- Create: `components/published/columns.tsx`
- Modify: `components/published/published-table.tsx` (use `DataTable`, manual sort → URL)
- Test: `tests/published-sort.test.ts`

**Interfaces:**
- Consumes: `DataTable`, `DataTableColumnHeader` (B1).
- Produces: `resolvePublishedSort(sort?, dir?)` with allowlist ∈ {`"title"`,`"category"`,`"publishedAt"`,`"author"`}; default `publishedAt` desc.

- [ ] **Step 1: Read** `published-table.tsx`, `lib/queries/published.ts`, `app/(app)/published/page.tsx`, `PublishedFilterBar`.
- [ ] **Step 2: Write failing test** `tests/published-sort.test.ts` mirroring B2's resolver tests (known col maps; unknown→publishedAt desc).
- [ ] **Step 3: Run** — FAIL.
- [ ] **Step 4: Implement** `resolvePublishedSort` + order map; thread into `getPublishedArticles`; parse params in the page; build `columns.tsx` (title, category, publishedAt, author sortable; keep the WP link + AI/human badge cells); convert `published-table.tsx` to `DataTable` in manual mode with URL-driven sort, preserving `PublishedFilterBar` + `PublishedPagination`.
- [ ] **Step 5: Run** tests + `test:pure` + tsc.
- [ ] **Step 6: Commit** `feat(published): DataTable + click-to-sort headers`.

---

### Task B4: Runs table → client DataTable (sort + faceted filters + search)

**Files:**
- Modify: `components/pipeline/runs-view.tsx` (`:56-61` client filters, `:149-161` table)
- Create: `components/pipeline/runs-columns.tsx`
- Test: `tests/runs-table.test.tsx`

**Interfaces:** Consumes `DataTable` (B1). Client mode (all rows loaded).

- [ ] **Step 1: Read** `runs-view.tsx` (existing `statusFilter`/`triggerFilter` `useState` + `filterRuns` useMemo; row-click opens the detail sheet).
- [ ] **Step 2: Write failing test** asserting: rows sort by clicking a header (e.g. "new items"); the status filter narrows rows; row click still fires the detail-sheet handler. (Adapt to repo test tooling; if DOM testing isn't set up, test the `columns` cell/accessor functions + keep the existing filter logic behind the DataTable's `columnFilters`.)
- [ ] **Step 3: Run** — FAIL.
- [ ] **Step 4: Implement** `runs-columns.tsx` (timestamp, trigger, feeds read, new items, duration, status — all `enableSorting`). Convert the table to `DataTable` in client mode; pass `onRowClick` = open detail sheet; render the existing status/trigger `<Select>`s + a search `Input` in the toolbar slot, wired to `columnFilters`/`globalFilter`. Preserve current default order.
- [ ] **Step 5: Run** tests + `test:pure` + tsc.
- [ ] **Step 6: Commit** `feat(runs): DataTable with sort + filters`.

---

### Task B5: Feeds table → client DataTable

**Files:**
- Modify: `components/settings/feeds-table.tsx` (`:81-110`, `FeedRow`)
- Create: `components/settings/feeds-columns.tsx`
- Test: `tests/feeds-table.test.tsx`

- [ ] **Step 1: Read** `feeds-table.tsx` + `FeedRow` (health badge, actions menu, active toggle).
- [ ] **Step 2: Write failing test** — sort by name / 7d count; filter by status/active; search by name. (Adapt to tooling; test `columns` accessors + a smoke render.)
- [ ] **Step 3: Run** — FAIL.
- [ ] **Step 4: Implement** `feeds-columns.tsx` (name, url, health, last fetch, status, 7d count, active, actions). Sortable: name, last fetch, 7d count, status, active. Actions column `enableSorting:false`. Convert to `DataTable` client mode; toolbar = health/status/active filters + search. Preserve the row actions and active toggle.
- [ ] **Step 5: Run** tests + `test:pure` + tsc.
- [ ] **Step 6: Commit** `feat(feeds): DataTable with sort + filters`.

---

### Task B6: Members table → client DataTable

**Files:**
- Modify: `components/settings/members-table.tsx` (`:37-60`, `MemberRow`)
- Create: `components/settings/members-columns.tsx`
- Test: `tests/members-table.test.tsx`

- [ ] **Step 1: Read** `members-table.tsx` + `MemberRow` (role, status, actions).
- [ ] **Step 2: Write failing test** — sort by name/last login; filter by role/status; search by name/email.
- [ ] **Step 3: Run** — FAIL.
- [ ] **Step 4: Implement** `members-columns.tsx` (name, email, role, status, last login, actions). Sortable: name, email, role, status, last login. Convert to `DataTable` client mode; toolbar = role/status filters + search; preserve row actions.
- [ ] **Step 5: Run** tests + `test:pure` + tsc.
- [ ] **Step 6: Commit** `feat(members): DataTable with sort + filters`.

---

### Task B7: Taxonomy tables (categories & tags) → client DataTable

**Files:**
- Modify: `components/settings/taxonomy-tables.tsx` (`:87-107`, rendered twice)
- Create: `components/settings/taxonomy-columns.tsx`
- Test: `tests/taxonomy-table.test.tsx`

- [ ] **Step 1: Read** `taxonomy-tables.tsx` (two taxonomies share one row shape: name, WP id, article count).
- [ ] **Step 2: Write failing test** — sort by name / article count; search by name; both instances (categories + tags) work.
- [ ] **Step 3: Run** — FAIL.
- [ ] **Step 4: Implement** `taxonomy-columns.tsx` (name, wpId, articleCount — all sortable). Convert both table instances to `DataTable` client mode with a search toolbar. One `columns` factory reused for both.
- [ ] **Step 5: Run** tests + `test:pure` + tsc.
- [ ] **Step 6: Commit** `feat(taxonomy): DataTable with sort + search`.

---

### Task B8: Templates table → client DataTable (keep gallery toggle)

**Files:**
- Modify: `components/studio/templates-table.tsx:12`
- Create: `components/studio/templates-columns.tsx`
- Test: `tests/templates-table.test.tsx`

- [ ] **Step 1: Read** `templates-table.tsx` (list view + `TemplatesGallery` toggle).
- [ ] **Step 2: Write failing test** — sort by name/date; search by name; gallery toggle still switches views.
- [ ] **Step 3: Run** — FAIL.
- [ ] **Step 4: Implement** `templates-columns.tsx` (name, date, any actions). Convert ONLY the list-view table to `DataTable` client mode + search; leave the gallery view and its toggle intact.
- [ ] **Step 5: Run** tests + `test:pure` + tsc.
- [ ] **Step 6: Commit** `feat(studio): templates DataTable with sort + search`.

---

## Self-review notes (author)
- Spec coverage: A1-A3 cover Feature A (params, enforcement, UI). B1 primitive; B2 queue (the reported fix); B3 published; B4-B8 the five client tables. Out-of-scope card/list UIs intentionally excluded (spec B4).
- Server-sort allowlist appears in B2 (`resolveQueueSort`) and B3 (`resolvePublishedSort`) — both enforce the injection guard from Global Constraints.
- `stageSources` gains ONE new trailing optional arg (A2) consumed only by `run.ts`; `stageItem` and existing tests keep working via the `null` default.
- Type names consistent: `DataTable`, `DataTableColumnHeader`, `DataTableToolbar`, `resolveQueueSort`/`resolvePublishedSort`, `isInCategoryScope`.
- Every table task follows the same shape (columns file + DataTable conversion + preserve behaviors); B5-B8 are same-shape and MAY be batched into fewer dispatches during execution if the reviewer surface stays clear.

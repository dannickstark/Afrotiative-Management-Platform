# Design — Category-scoped pipeline runs + TanStack tables

Date: 2026-08-14
Status: approved-for-planning (pending user spec review)
Branch: `feat/category-runs-and-tanstack-tables` (one combined PR)

Two independent features, delivered on one branch:
- **A. Category-scoped pipeline runs** — the manual "run pipeline" dialog can restrict a run to selected
  WordPress categories; stories the AI classifies outside that set are skipped before persistence.
- **B. TanStack DataTable migration** — a shared sortable/filterable table used by all 7 table screens,
  fixing the `/queue` "can't sort by clicking the header" gap.

Decisions locked with the user:
- Category scoping = **filter the output** (AI classifies from the full list; keep only selected categories).
- Sort model = **hybrid**: server-side (URL-driven) for the paginated tables (queue, published), client-side
  for the fully-loaded tables (runs, feeds, members, taxonomy, templates).
- Filtering = **global search + per-column filters**.
- The queue/published **sort dropdown is replaced** by click-to-sort headers.

---

## Feature A — Category-scoped pipeline runs

### A1. Data model / params
- `RunParams` (`db/schema.ts:21-28`): add `categoryIds: string[] | null`. `null` = all categories (current
  behavior). `[]` is treated as `null` (no scope) to avoid a run that can never persist anything.
- `runParamsSchema` (`lib/validation.ts:127-138`): add `categoryIds: z.array(z.string().uuid()).nullable()`
  (mirror the `feedIds` field's shape/nullability).
- `resolveRunParams` (`lib/pipeline/run-params.ts`): pass `categoryIds` through to the persisted `RunParams`,
  normalizing `[]`→`null`.
- Persistence: unchanged — `params` jsonb already written by `openRun` (`run.ts:111`) and read back in
  `executeRun` (`run.ts:203-204`).

### A2. UI (`components/pipeline/run-config-dialog.tsx`)
- `getRunConfigOptions()` (`lib/actions/pipeline-actions.ts:40-54`): also return
  `categories: { id: string; name: string }[]` from `wpCategories` (id + name, ordered by name).
- Add a category multi-select beside the existing feed checkbox list (`run-config-dialog.tsx:141-157`),
  same interaction pattern as feeds. `buildInput()` (`:69-86`) includes `categoryIds` — `null` when none
  selected (= all), otherwise the checked ids.
- Copy/labels in French, matching the dialog's existing tone.

### A3. Enforcement — "filter output" (the core logic)
- `executeRun` already loads category names at `run.ts:198`. Change that read to load `{ id, name }` and
  build the run's **category scope**: `null` when `params.categoryIds` is null/empty, else a `Set` of the
  selected category **names** (resolved from the selected ids via the loaded id→name map).
  - Name-based, because the AI outputs a category **name** (`draft.category`) and `stageSources` can compare
    without a DB round-trip. Ids that no longer resolve to a live `wpCategories` row are dropped from the
    scope set (a stale selected id simply can't match anything — consistent with "keep only these").
- Thread the scope into `stageSources(...)` as an optional `categoryScope: Set<string> | null` argument
  (defaulted `null` so `stageItem`/tests are unaffected).
- In `stageSources`, **after** `generateArticle` + `repairDraft` (so classification uses the full category
  list and is accurate) and **before** the "Dépôt en revue" persist step: if `categoryScope` is non-null and
  `draft.category ∉ categoryScope` (also skip when the story's category is empty/uncertain), short-circuit:
  do NOT call `persistArticle`, record a step and return `{ articleId: null, steps }`.
- Step status: `StepRec.status` is `"success" | "failed"` only (`stages.ts:28`) — there is NO `skipped`
  value and this design adds no schema/enum migration for one. The skip is recorded as a **success** step
  named `"Hors catégorie sélectionnée (ignoré)"` (the filter step succeeded in deciding to skip), so it
  reads distinctly from a `failed` step in the run trace. The run-level `RunStatus` enum (`run.ts:31`) is
  untouched.
- `executeRun`'s per-story loop already tolerates `articleId: null` (a story that produced nothing), so no
  change is needed there for the run to complete; the skipped story simply contributes no persisted article.

### A4. Tests (Feature A)
- `resolveRunParams`: `categoryIds` passthrough; `[]`→`null` normalization.
- `runParamsSchema`: accepts `null` and a uuid array; rejects non-uuid.
- `stageSources` category filter: with a scope excluding the AI's category → no persist, skipped step
  recorded, `articleId: null`; with a matching/`null` scope → persists as today. (Reuse the existing
  `persistArticle`/`stageSources` test harness; network-free.)
- UI: dialog builds `categoryIds` correctly (null when none checked).

---

## Feature B — TanStack DataTable migration

### B1. Shared primitive `components/ui/data-table.tsx`
A reusable client component over `useReactTable` + the shadcn `Table` primitive (`components/ui/table.tsx`).
Two modes, chosen per table via props:

- **Client mode** (default): `getCoreRowModel` + `getSortedRowModel` + `getFilteredRowModel`; internal
  `SortingState`, `ColumnFiltersState`, and a `globalFilter` string. Renders a global search input and,
  where columns declare it, per-column faceted filter controls.
- **Server/manual mode**: `manualSorting: true`, `manualPagination: true`; `sorting` is a controlled prop and
  `onSortingChange` calls back so the host reflects it to URL search params. Filtering/pagination stay with
  the host's existing filter bar + `QueuePagination`/`PublishedPagination`.

Supporting pieces:
- `components/ui/data-table-column-header.tsx` — a sortable `<TableHead>` button (asc/desc/none, `ArrowUpDown`
  / `ArrowUp` / `ArrowDown` icons), works in both modes (client: `column.toggleSorting`; server: calls the
  host's sort callback).
- Optional `components/ui/data-table-toolbar.tsx` — global search input + slot for per-column filter controls.
- Column defs live in a per-table `columns.tsx` (mirroring the existing `components/queue/columns.tsx`).
- Keep tables as thin **client** components receiving `rows` as props from their RSC page (the app's dominant
  pattern — no data-fetching library introduced).

### B2. Server-side sort plumbing (queue + published)
- URL params: `?sort=<col>&dir=<asc|desc>` (single-column). Extend `parseQueueSearchParams`
  (`app/(app)/queue/page.tsx` / its parser) and the published equivalent to read these with an **allowlist**
  mapping `col` → a Drizzle order expression; unknown `col` falls back to the current default order. This
  allowlist is the injection guard — never interpolate the raw param into SQL.
- `lib/queries/queue.ts` (`orderBy` at `:102-105`) and `lib/queries/published.ts` (currently a fixed
  `orderBy(desc(articles.publishedAt))` at `:74`): accept the resolved `(column, direction)` and emit the
  corresponding `orderBy`. Preserve `nulls last` semantics for score/date; keep the current order as the
  default when no `?sort` is present (queue: newest; published: publishedAt desc).
- Queue has a 3-option sort `<Select>` (`components/queue/queue-filters.tsx:112-119`) — **remove it** and
  drive sorting from clickable headers instead. Published has **no** sort control today (fixed order) — just
  **add** header sorting; nothing to remove. Header click sets `?sort`/`?dir` (toggling asc→desc→default)
  via `router.push` (server re-query), consistent with the existing URL-driven filter model.

### B3. Per-table migration (7 tables)
Each converts to `DataTable` + a `columns.tsx`. Sortable columns and filters noted:

| Table | File | Mode | Sort columns | Filters |
|-------|------|------|--------------|---------|
| Queue | `components/queue/queue-table.tsx` (+`columns.tsx`) | server | title, category, score, date, source, status | existing `QueueFilters` (status/search/category/source) kept |
| Published | `components/published/published-table.tsx` | server | title, category, publishedAt, author | existing `PublishedFilterBar` kept |
| Runs | `components/pipeline/runs-view.tsx` | client | timestamp, trigger, feeds read, new items, duration, status | status + trigger (already client filters → faceted) + search |
| Feeds | `components/settings/feeds-table.tsx` | client | name, last fetch, 7d count, status, active | health/status/active + search |
| Members | `components/settings/members-table.tsx` | client | name, email, role, status, last login | role/status + search |
| Taxonomy (×2) | `components/settings/taxonomy-tables.tsx` | client | name, wpId, articleCount | search |
| Templates | `components/studio/templates-table.tsx` | client | name/date | search (keep the gallery/grid toggle) |

- Queue keeps its existing `useReactTable`; the change is adding the sorted model + sortable headers + wiring
  to `?sort`/`?dir`. This is the reported `/queue` fix.
- Row-click behaviors (runs → detail sheet; queue row selection) are preserved.

### B4. Out of scope (not `<table>` UIs — unchanged)
Social-channel cards (`components/settings/social-channels.tsx`), dashboard pending/error lists, article
history `<ol>`, diffusion distribution cards, run-trends tiles. Not converted.

### B5. Tests (Feature B)
- `DataTable` primitive: client-mode sort toggling reorders rows; global search filters; per-column filter
  narrows; server-mode emits sort changes without reordering locally (host owns order).
- `data-table-column-header`: toggles asc→desc→none; correct aria/indicator.
- Server sort allowlist: known col → expected Drizzle order; unknown col → default; direction respected;
  `nulls last` preserved. (Reuse existing `queue`/`published` query test patterns.)
- Per-table smoke: each table renders with its `columns.tsx`, sorts, and preserves existing filters/row
  actions. Keep everything in the `test:pure` lane where DB-free.

---

## Rollout / sequencing (informs the plan, not the runtime)
1. Feature B shared primitive (`data-table.tsx`, column-header, toolbar) + tests.
2. Queue server sort (fixes the reported regression) + Published server sort.
3. The 5 client tables (runs, feeds, members, taxonomy, templates).
4. Feature A: params/validation → UI → enforcement in `stageSources` → tests.
Order 4-after-B is arbitrary; A and B share no files except none — they can interleave. Both ship in one PR.

## Global constraints
- No new runtime dependency (TanStack already at `@tanstack/react-table@8.21.3`; no react-query).
- Preserve every existing filter, pagination, and row-action behavior; the migration is additive on sort +
  per-column filter, not a rewrite of data fetching.
- Server sort MUST use a column allowlist (no raw param → SQL).
- Category scope `[]` normalizes to `null` (never a run that can persist nothing by construction).
- French UI copy consistent with existing screens.
- `bun run test:pure` stays green; `tsc --noEmit` clean. Customized Next.js (AGENTS.md) — read
  `node_modules/next/dist/docs/` before touching any Next API (RSC/searchParams/route handlers).

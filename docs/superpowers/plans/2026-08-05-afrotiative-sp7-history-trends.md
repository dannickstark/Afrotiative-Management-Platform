# SP7 — Run history + trends — Plan

**Goal:** Turn the `/runs` list into a usable history: filter by status/trigger, show duration, and a lightweight trends strip (runs/day, articles produced, failure rate) over a recent window. One focused implementer + review.

**Branch:** `feat/pipeline-v2` (after SP6). **Tech:** Next.js 16 RSC, Drizzle/Neon, shadcn. NO new chart dependency (CSS bars + stat tiles).

## Scope (no migration — derive trends from existing data)
- The `/runs` page already renders `LiveRunPanel` + a runs table (`components/pipeline/runs-view.tsx`) from a server query in `app/(app)/runs/page.tsx`. This SP enhances the LIST + adds a TRENDS strip. Do NOT touch the live panel (SP-A) or the runner.

### 1. Trends query — `lib/queries/runs.ts`
`getRunTrends(days = 14)` returns:
- `perDay: { day: string; runs: number; failures: number; produced: number }[]` — one row per day over the window. `runs`/`failures` from `pipeline_runs` grouped by `date(started_at)` (failures = status in `('failed','partial','cancelled')` — count `failed`+`partial` as failures; treat `cancelled` separately or as non-failure — your call, document it). `produced` = `articles` grouped by `date(coalesce(generated_at, created_at))` (articles created that day; the pipeline sets `generatedAt`). Join/merge the two aggregates by day; fill zero days.
- `summary: { runs7d: number; articles7d: number; failureRatePct: number; avgDurationSec: number|null }` — over the last 7 days: run count, articles produced, failure rate (% of runs failed/partial), avg run duration (`finished_at - started_at` for finalized runs).
Keep it a couple of grouped SQL queries (Drizzle `sql`), merged in JS. Pure-ish; unit-test the day-merge/fill helper separately.

### 2. Runs list rework — `components/pipeline/runs-view.tsx` + `app/(app)/runs/page.tsx`
- Load more history: bump the page query from 20 → ~50 runs (still one query).
- **Filter bar** (client-side over the loaded runs): filter by status (all / success / partial / failed / cancelled) and trigger (all / manual / scheduled / reprocess). shadcn `Select` or a small segmented control; French labels. Keep it simple + accessible.
- **Duration column**: `finished_at - started_at` (reuse/lift the existing `formatRunDuration` from `run-detail-sheet.tsx` or a shared `lib/format` helper — DRY it if trivial). Show "en cours"/"en pause" for active runs (respect the paused label added in SP5).
- Keep existing columns (timestamp, trigger, status + failedSteps, feedsRead, newItems). Row click still opens the detail sheet (unchanged).
- Add `paused`/`cancelled` to the list's status styling if not already present (SP5 added them to the maps — verify).

### 3. Trends strip — `components/pipeline/run-trends.tsx` (new)
- A `Card` above the runs table with: 4 stat tiles (Exécutions 7 j, Articles produits 7 j, Taux d'échec, Durée moyenne) + a small per-day bar row (last 14 days) showing runs with a failure-colored portion — pure CSS bars (height/width %), theme-aware, no chart lib. French labels. Read from `getRunTrends`.
- Render it in `runs-view.tsx` (fed initial data from the page) or as its own server-fetched block on the page — pick the cleaner wiring; the page is a server component so fetching `getRunTrends` there and passing it down is simplest.

## Tests (bun:test, real Neon dev, cleanup)
- `getRunTrends`: insert a handful of `pipeline_runs` (varied statuses, started_at across several days) + a few `articles` (varied generated_at) → assert perDay aggregation (right counts per day, zero-fill), and summary (runs7d, failureRatePct, avgDurationSec). Clean up all inserted rows.
- The day-merge/zero-fill helper: unit test pure (given two aggregates + a window → merged perDay with zeros filled).
- If you extract a pure filter function for the list, unit-test it; otherwise the client filter is trivial and covered by typecheck.

## Verify
`bun run typecheck` 0; `bun test` full suite green. Manual: `bun run dev`, `/runs` shows the trends strip + filterable list (note visual verification if browser unavailable). Update roadmap SP7 box. Commit(s): `feat(runs): history filters + duration + trends strip`.

## Notes
No migration. `cancelled` runs: count as non-failure in the failure rate (an admin stop isn't a pipeline failure) — but show them in the list + filter. Keep the trends strip lightweight; this is an internal ops view, not a BI dashboard.

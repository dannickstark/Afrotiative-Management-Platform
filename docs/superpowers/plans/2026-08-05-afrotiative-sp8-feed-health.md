# SP8 — Feed-health matrix (make it real) — Plan

**Goal:** Give each feed a truthful health signal — last fetch time + status, items captured (7d), and failure streaks — and surface it as a matrix on `/settings/feeds`. One focused implementer + review.

**Branch:** `feat/pipeline-v2` (after SP7).

## Key finding (why this is more than UI)
`feeds.lastFetchAt` / `lastFetchStatus` / `itemsCaptured7d` exist and are ALREADY DISPLAYED in `components/settings/feeds-table.tsx`, but **nothing writes them except the seed** — the health shown today is fake/stale. So SP8 must (1) make the runner MAINTAIN these fields, (2) add failure-streak tracking, (3) enrich the matrix view.

## Build

### 1. Migration (additive)
Add `feeds.consecutiveFailures integer NOT NULL DEFAULT 0` (`consecutive_failures`) — for failure streaks. (`lastFetchAt`/`lastFetchStatus`/`itemsCaptured7d` already exist; no new columns for those.) Generate + apply.

### 2. Wire the runner to maintain feed health — `lib/pipeline/run.ts` (phase-1 feed loop)
In `executeRun`'s feed-read loop, after each feed parse attempt, best-effort update the feed row (a health-update failure must NEVER fail the run — wrap in try/catch):
- **Success:** `lastFetchAt = now`, `lastFetchStatus = 'ok'`, `consecutiveFailures = 0`, `itemsCaptured7d = <recomputed>`.
- **Failure (parse threw):** `lastFetchAt = now`, `lastFetchStatus = 'error'`, `consecutiveFailures = consecutiveFailures + 1` (leave itemsCaptured7d as-is or recompute).
- `itemsCaptured7d` recompute = `SELECT count(*) FROM raw_items WHERE feed_id = ? AND fetched_at >= now() - interval '7 days'` (raw_items carries `feedId` + `fetchedAt`). One small query per feed per run — fine.
- This runs for BOTH the scheduled/manual and resume paths' feed reads (resume skips phase 1, so feed health is updated only on the initial run — acceptable; document it).
- Extract a small helper `updateFeedHealth(feedId, outcome)` (in run.ts or a `lib/pipeline/feed-health.ts`) so it's testable.

### 3. Health derivation (pure, tested) — `lib/pipeline/feed-health.ts`
`deriveFeedHealth(feed): 'healthy' | 'degraded' | 'failing' | 'idle'`:
- `failing` if `lastFetchStatus === 'error'` OR `consecutiveFailures >= 3`;
- `degraded` if `consecutiveFailures` in 1..2 (recovered-but-shaky) OR (`lastFetchStatus === 'ok'` but `itemsCaptured7d === 0` over ≥ some reads — keep simple: 0 items 7d while active → degraded);
- `idle` if `lastFetchStatus === 'never'` (never read) or feed inactive;
- else `healthy`.
Document the thresholds. Pure + unit-tested.

### 4. Feed-health matrix UI — `/settings/feeds`
Enhance `components/settings/feeds-table.tsx` (+ `lib/queries/settings.ts` `getFeeds` if it doesn't already select the fields): the matrix per feed shows name, active, **health indicator** (colored dot/badge from `deriveFeedHealth`, French: Sain / Dégradé / En échec / Inactif), **dernière lecture** (relative time from `lastFetchAt`, e.g. `relativeDate`), **statut** (lastFetchStatus badge — already present), **éléments 7 j** (itemsCaptured7d — already present), and **série d'échecs** (consecutiveFailures when > 0, e.g. "3 échecs consécutifs"). Keep the existing edit/toggle actions. Theme-aware, French. If a compact "matrix" summary header helps (e.g. counts: X sains / Y dégradés / Z en échec), add a small strip above the table.
- Make sure `getFeeds` selects `consecutiveFailures` + the health fields; add `deriveFeedHealth` per row (server or client).

## Constraints
- Additive migration. French copy. Best-effort feed-health updates (never fail a run). Do NOT touch the live panel; only the feed-read loop in the runner + the feeds settings view. Preserve the runner's invariants (the health update is inside the per-feed try, after the read outcome is known, best-effort).

## Tests (bun:test, real Neon dev, cleanup)
- Runner health update: run `executeRun` with a fixture feed that parses OK → assert the feed row's `lastFetchStatus='ok'`, `lastFetchAt` recent, `consecutiveFailures=0`, `itemsCaptured7d` reflects recorded items. A feed whose parse FAILS (unreachable URL fixture, like existing tests) → `lastFetchStatus='error'`, `consecutiveFailures` incremented. Run twice-failing → streak = 2; then a success → streak reset to 0. Full cleanup.
- `deriveFeedHealth` pure unit tests across the states.

## Verify
`bun run typecheck` 0; `bun test` full suite green. Manual: `/settings/feeds` shows the health matrix (note visual pending if no browser). Update roadmap SP8 box. Commit(s): `feat(feeds): real feed-health tracking + health matrix`.

## Notes
Feed health is now updated by real runs, so the seed's fake values get corrected on the first run of each feed. `consecutiveFailures` gives failure-streak visibility that pairs with SP9 alerting (a feed going dark = high streak).

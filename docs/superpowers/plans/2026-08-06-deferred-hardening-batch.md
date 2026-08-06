# Deferred Hardening Batch (#3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Clear the accumulated deferred-minor backlog from the run-trigger, /published, and AI-regenerate features — logic/observability/test/DX fixes plus two hardening migrations.

**Architecture:** Independent corrective fixes grouped into cohesive tasks; two additive DB constraints (a partial unique index and a CHECK), both verified against the dev DB to have zero existing violations.

**Tech Stack:** Next.js 16, Drizzle + Postgres (Neon), `bun test`.

## Global Constraints

- **French UI copy / comments** consistent with the surrounding code.
- **Migrations are additive and pre-verified safe** (dev DB checked: 0 published articles with null `published_at`; 0 duplicate `(article_id, channel='wordpress')` distributions). Generate via `bun run db:generate`, apply via `bun run db:migrate`. Migrations live under `db/migrations/` (per `drizzle.config.ts`).
- **`published_at` must NOT become a plain `NOT NULL` column** — non-published articles (draft/pending) legitimately have null `published_at`. The correct hardening is a CHECK: `status <> 'published' OR published_at IS NOT NULL`.
- **No behavior regressions:** keep the full suite green. Tests run against the real Neon dev DB.
- Each fix is small; keep diffs tight and scoped to the named files.

---

### Task 1: Run-trigger hardening (logic + DRY + tests)

**Files:**
- Modify: `lib/pipeline/run.ts` (candidate loop dedup/recency order; feed-target guard)
- Modify: `lib/pipeline/run-params.ts` (DRY the age-cutoff formula)
- Modify: `lib/validation.ts` (DRY the duplicated message — optional const)
- Test: `tests/run-params.test.ts`, `tests/run-params-db.test.ts` (add cases)

- [ ] **Step 1: `tooOld` no longer counts already-processed items.** In `lib/pipeline/run.ts`'s phase-1 per-item loop, the recency filter currently runs before the dedup checks, so an item that is both too-old AND already-recorded is counted in `tooOld` every run. Reorder so the dedup checks run first: move `if (!isWithinRecency(item.isoDate, cutoff)) { tooOld++; continue; }` to AFTER `if (seenHashes.has(item.contentHash)) continue;` and `if (await isSeen(feed.id, item)) continue;` (but still before `seenHashes.add` / the candidate push). Now `tooOld` counts only genuinely-new items that were skipped for age. Existing tests should stay green; the `run-recency-e2e` test's old item is not already-seen, so it still counts.

- [ ] **Step 2: Tighten the feed-target nullish fallback.** In `executeRun`, change `const paramFeedIds = params?.feedIds ?? opts.feedIds;` to `const paramFeedIds = params != null ? params.feedIds : opts.feedIds;` so an explicit `params.feedIds: null` ("all active feeds") is honored rather than falling through to `opts.feedIds`.

- [ ] **Step 3: DRY the age-cutoff formula in `run-params.ts`.** `resolveRecency` computes `new Date(now.getTime() - hours * HOUR_MS).toISOString()` twice (explicit-age branch + default branch). Extract a local `const ageCutoff = (h: number) => new Date(now.getTime() - h * HOUR_MS).toISOString();` and use it in both. No behavior change.

- [ ] **Step 4: (optional DRY) validation message.** In `lib/validation.ts`, if trivial, extract the repeated `"Doit être un entier positif"` used by `hours` and `maxItems` in `runParamsSchema` into a local `const POSITIVE_INT_MSG = "Doit être un entier positif";`. Skip if it complicates more than it helps.

- [ ] **Step 5: Add the missing coverage.**
  - `tests/run-params.test.ts` — add a `narrowByRecency` case with two items of EQUAL non-null timestamps asserting stable order (input order preserved).
  - `tests/run-params-db.test.ts` — add round-trip cases for `recency.kind === "since"` and `"none"`, and a non-null `feedIds` array (assert they persist + read back unchanged).

- [ ] **Step 6: Verify + commit.** `bun test tests/run-params.test.ts tests/run-params-db.test.ts tests/run-recency-e2e.test.ts` green; `bun run typecheck` clean.
```bash
git add lib/pipeline/run.ts lib/pipeline/run-params.ts lib/validation.ts tests/run-params.test.ts tests/run-params-db.test.ts
git commit -m "fix(pipeline): count tooOld after dedup; honor explicit all-feeds; DRY cutoff; +recency tests"
```

---

### Task 2: AI-regenerate hardening (observability + cluster + tests)

**Files:**
- Modify: `lib/pipeline/cluster.ts` (`decideCluster` gains `excludeArticleId`)
- Modify: `lib/pipeline/regenerate.ts` (pass `excludeArticleId`; flag mock embedding)
- Modify: `lib/actions/article-actions.ts` (log the extraction `catch`; drop redundant `db`/`eq` re-import)
- Test: `tests/regenerate.test.ts` (exclude-self assertion), `tests/ai-improve.test.ts` (happy-path)

- [ ] **Step 1: `decideCluster` can exclude an article's own embedding.** Add an optional 2nd param and filter it out of the similarity query:
```ts
export async function decideCluster(embedding: number[], excludeArticleId?: string): Promise<{ clusterId: string | null; isNew: boolean; bestScore: number }> {
  // ...
  const result = await db.execute<NearestRow>(sql`
    select a.cluster_id as cluster_id, 1 - (e.embedding <=> ${vec}::vector) as score
    from ${articleEmbeddings} e join ${articles} a on a.id = e.article_id
    where a.generated_at >= ${since} and a.cluster_id is not null
    ${excludeArticleId ? sql`and a.id <> ${excludeArticleId}` : sql``}
    order by e.embedding <=> ${vec}::vector asc limit 1`);
```
This is backward-compatible (existing callers omit it).

- [ ] **Step 2: `applyRegeneration` excludes the article from its own re-cluster + flags a mock embedding.** In `lib/pipeline/regenerate.ts`'s body-changed branch: call `decideCluster(vector, articleId)` (so a regen doesn't self-match its stale embedding and inflate cohesion). Also capture `embed`'s `via`: `const { vector, via: embedVia } = await embed(...)`, and when `embedVia === "mock"`, set `clusterUncertain: true` and `aiDegraded: true` in the merged confidence (mirror `stages.ts:170-175`) — extend the `mergedConfidence` build to OR-in these when the embedding was a mock. Keep the per-field merge from the last fix intact.

- [ ] **Step 3: Log the extraction failure in `regenerate`.** In `lib/actions/article-actions.ts`, the per-source `catch { /* best-effort */ }` swallows silently. Add `console.warn(\`[regenerate] extraction échouée pour ${s.url}: ${(e as Error).message}\`)` (name the caught error `e`), matching the AI-provider loops' logging.

- [ ] **Step 4: Drop the redundant dynamic re-import.** In `regenerate` and `improveWithAi`, `db`, `articles`, `eq` (and any other binding already statically imported at the top of `article-actions.ts`) are dynamically re-imported for no deferral benefit (they're already in the static graph). Use the file's existing static `db`/`articles`/`eq`; keep dynamic-importing only the genuinely-heavy new modules (`@/lib/extract`, `@/lib/ai/generate-article`, `@/lib/ai/improve-article`, `@/lib/pipeline/regenerate`) and the not-yet-static ones (`articleSources`, `wpCategories`). Verify `bun run build` still shows no jsdom-in-route error.

- [ ] **Step 5: Tests.**
  - `tests/regenerate.test.ts` — in (or beside) the body-regen test, assert `decideCluster` self-exclusion: with the article's own embedding being the only recent one, a body regen must NOT attach to its own prior cluster via self-match (assert the resolved cluster is a fresh one / `bestScore` isn't spuriously ~1). Keep existing assertions.
  - `tests/ai-improve.test.ts` — add a happy-path test for `improveArticleBody`: mock `@/lib/ai/providers` `buildModel` + `ai` `generateText` (follow `tests/ai-fallback.test.ts`'s `mock.module` + captured-real-impl pattern to avoid cross-file leakage) so a configured provider returns a canned improved body, and assert `via` is the provider name and `bodyHtml` is the returned text. If the `mock.module` approach proves leak-prone in this repo, note it and keep only the existing mock-fallback test.

- [ ] **Step 6: Verify + commit.** `bun test tests/regenerate.test.ts tests/ai-improve.test.ts tests/pipeline-grouping.test.ts` green (grouping uses `decideCluster` — confirm no regression); `bun run typecheck` + `bun run build` clean.
```bash
git add lib/pipeline/cluster.ts lib/pipeline/regenerate.ts lib/actions/article-actions.ts tests/regenerate.test.ts tests/ai-improve.test.ts
git commit -m "fix(regenerate): decideCluster excludeArticleId + flag mock embedding; log extraction fail; drop redundant imports"
```

---

### Task 3: /published + configure-run dialog polish

**Files:**
- Modify: `components/published/published-view.tsx` (hide pagination at ≤1 page)
- Modify: `components/pipeline/run-config-dialog.tsx` (refetch options on each open)
- Modify: `docs/superpowers/specs/2026-08-06-afrotiative-published-articles-page-design.md` (reconcile the WP-link em-dash note)

- [ ] **Step 1: Hide pagination when there's nothing to page.** In `published-view.tsx`, render `<PublishedPagination>` only when `page.pageCount > 1` (`{page.pageCount > 1 && <PublishedPagination .../>}`), so an empty/single-page list doesn't show inert "Page 1 / 1" + disabled buttons.

- [ ] **Step 2: Configure-run dialog refetches on each open.** In `run-config-dialog.tsx`, `handleOpenChange` currently fetches options only when `feeds.length === 0` (once per mount), so a settings/feed change made elsewhere isn't reflected on reopen. Change it to refetch on every open (`if (next) { …fetch… }`), keeping the loading state. Guard against overlapping fetches if trivial.

- [ ] **Step 3: Reconcile the WP-link em-dash.** The /published spec §7 said the "Voir sur WordPress" link is "masqué" when null, but the shipped table renders an em-dash placeholder (clearer in a table cell). Update the spec line to describe the em-dash placeholder (code stays as-is) so spec and code agree.

- [ ] **Step 4: Verify + commit.** `bun run typecheck` + `bun run build` clean (UI-only; no unit test). Manually note: `/published` with ≤1 page shows no pager; the run dialog reflects a fresh settings value on reopen.
```bash
git add components/published/published-view.tsx components/pipeline/run-config-dialog.tsx docs/superpowers/specs/2026-08-06-afrotiative-published-articles-page-design.md
git commit -m "fix(ui): hide /published pager at ≤1 page; refetch run-config options on each open; spec reconcile"
```

---

### Task 4: Migration — distributions one-wordpress-per-article

**Files:**
- Modify: `db/schema.ts` (`distributions` table extras: partial unique index)
- Create: `db/migrations/<generated>.sql`
- Test: `tests/wp-publish.test.ts` or a small new test

**Interfaces:** enforces at most one `channel='wordpress'` distribution row per article (the `upsertDistribution` invariant), preventing a theoretical race-created duplicate that would double a row in the /published list.

- [ ] **Step 1: Add the partial unique index.** In `db/schema.ts`, give `distributions` a table-extras array (currently none) modeled on `pipeline_runs_one_running` (schema.ts:270):
```ts
export const distributions = pgTable("distributions", {
  // ...unchanged columns...
}, (t) => [
  uniqueIndex("distributions_one_wordpress_per_article").on(t.articleId).where(sql`${t.channel} = 'wordpress'`),
]);
```
(`uniqueIndex` and `sql` are already imported.)

- [ ] **Step 2: Generate + apply.** `bun run db:generate` (expect a single `CREATE UNIQUE INDEX ... WHERE channel = 'wordpress'`), then `bun run db:migrate`. Dev DB is pre-verified duplicate-free, so it applies cleanly.

- [ ] **Step 3: Test the guarantee.** Add a focused DB test (in `tests/wp-publish.test.ts` or a new `tests/distributions-unique.test.ts`): insert a `wordpress` distribution for an article, then a second insert for the SAME article+channel must reject (SQLSTATE 23505). Insert a `non-wordpress` channel row for the same article to confirm the partial index does NOT block other channels. FK-safe cleanup.

- [ ] **Step 4: Verify + commit.** `bun test <that file>` green; `bun run typecheck` clean.
```bash
git add db/schema.ts db/migrations/ tests/
git commit -m "feat(db): partial unique index — one wordpress distribution per article"
```

---

### Task 5: Migration — published articles must have a publish date (CHECK)

**Files:**
- Modify: `db/schema.ts` (`articles` table extras: CHECK constraint; add `check` to the pg-core import)
- Create: `db/migrations/<generated>.sql`
- Test: `tests/published-queries.test.ts` or a small new test

**Interfaces:** DB-level guarantee that `status='published' ⇒ published_at IS NOT NULL`, backing the `PublishedRow.publishedAt: Date` type + the `r.publishedAt!` assertion. Non-published rows keep null `published_at`.

- [ ] **Step 1: Add the CHECK constraint.** Import `check` from `drizzle-orm/pg-core`. In `db/schema.ts`, add to the `articles` table-extras array (it already returns an array with `index("articles_status_idx")`):
```ts
check("articles_published_has_date", sql`${t.status} <> 'published' OR ${t.publishedAt} IS NOT NULL`),
```

- [ ] **Step 2: Generate + apply.** `bun run db:generate` (expect an `ALTER TABLE articles ADD CONSTRAINT "articles_published_has_date" CHECK (...)`), then `bun run db:migrate`. Dev DB is pre-verified (0 published rows with null `published_at`), so it applies cleanly.

- [ ] **Step 3: Test the constraint.** Add a focused DB test: inserting/updating an article to `status='published'` with `published_at = NULL` must reject (SQLSTATE 23514, check_violation); a `pending` article with null `published_at` inserts fine; a `published` article WITH a date inserts fine. FK-safe cleanup.

- [ ] **Step 4: Verify + commit.** `bun test <that file>` green; `bun run typecheck` clean.
```bash
git add db/schema.ts db/migrations/ tests/
git commit -m "feat(db): CHECK — a published article must have a published_at"
```

---

### Task 6: Full verification

- [ ] **Step 1:** `bun run typecheck` → 0.
- [ ] **Step 2:** `bun test` → all green (sequential; if a shared-DB flake appears, re-run that file in isolation and report).
- [ ] **Step 3:** `bun run build` → 0.

---

## Self-Review

**Backlog coverage:** run-trigger (tooOld order, feedIds tighten, DRY ×2, recency tests) → T1; AI-regenerate (decideCluster excludeArticleId, mock-embed flag, extraction log, redundant import, improve happy-path test) → T2; /published (pager-at-1, spec reconcile) + configure-dialog refetch → T3; distributions unique index → T4; published-has-date CHECK → T5; verification → T6. The `sel.bodyHtml!` assertion and module-private `Tx` (T3-of-prior-feature minors) are intentionally left (sound as-is). ✅

**Migration safety:** both constraints pre-verified against the dev DB (0 violations); `published_at` uses a CHECK (not NOT NULL) so drafts keep null. ✅

**Placeholder scan:** the one conditional is the `improveArticleBody` happy-path test (may fall back to the existing mock test if `mock.module` leaks) — explicitly noted with the fallback, not a TODO. No other placeholders.

# SP4 — Pipeline Quality (cross-check synthesis + references + subheadings + scoring + sanitize) — Plan

**Goal:** Turn the pipeline's "1 raw item → 1 article" into "same-story items (+ web coverage) → 1 well-sourced article with subheadings, a references list, a quality score, and sanitized HTML." Delivers the user's core pipeline improvements.

**Branch:** `feat/pipeline-v2` (after SP3). **Tech:** Next.js 16, Drizzle/Neon+pgvector, Vercel AI SDK, Bun. **Executed task-by-task via subagent-driven-development** (this SP is high-risk — the runner restructure in Task 6 is load-bearing).

## Decisions baked in (from the program roadmap)
- **Cross-check = corpus + web.** Corpus = group THIS run's collected candidates by embedding similarity ("same story") and synthesize ONE article per story from all its sources. Web = optionally augment each story with external coverage via a pluggable search provider (Brave default, optional). **Out of scope for SP4:** regenerating/merging into an already-staged article from a PRIOR run (decideCluster still assigns clusterId for grouping/observability; we do not rewrite existing articles). Note this boundary.
- Multi-source synthesis is already supported by `generateArticle({sources:[]})`; references are already rendered by `buildPostBody` from `article_sources`. The work is in the RUNNER (gather sources) + prompt + scoring + sanitize.

## Existing facts (exploration)
- `stageItem` (lib/pipeline/stages.ts) embeds via `embed()`, calls `decideCluster`, `generateArticle([oneSource])`, inserts 1 article + 1 article_sources + 1 article_embeddings. `executeRun` (lib/pipeline/run.ts) two-phase: phase 1 collects candidates (no record), phase 2 processes each.
- `article_sources` supports N rows/article. `bodyHtml` is unsanitized today (LLM output persisted raw) — security gap to close. `isomorphic-dompurify` is already a dep (used only on scraped input).
- No `articles.score` exists. `decideCluster` returns `bestScore` (cosine sim) — a scoring input. Confidence flags: categoryUncertain/imageMissing/clusterUncertain/aiDegraded.

## Global constraints
- **Human-review barrier intact** — all output stays `status:"pending"`. (Auto-publish is SP6.)
- Additive migrations only. French copy/step names. Best-effort observability (never let a step-write fail a run). Preserve the overlap/finalize invariants in `executeRun`.
- SSRF-safe web fetch: reuse the existing extract chain + its SSRF guard (see `lib/extract` and the `testFeed` SSRF guard referenced in git history) — never fetch arbitrary internal addresses.
- Tests: real Neon dev, network-free (mock providers/search), clean up rows.

---

## Task 1 — `articles.score` column (additive migration)
Add `score integer` (nullable) to `articles` in `db/schema.ts`; generate + apply migration. Test: round-trip an article with a score. This is the field SP6 reads for auto-publish.

## Task 2 — Server-side HTML sanitization of `bodyHtml`
New `lib/sanitize.ts`: `sanitizeArticleHtml(html: string): string` using `isomorphic-dompurify` with an allow-list suited to editorial articles — tags `p, h2, h3, h4, ul, ol, li, a, strong, em, blockquote, br`; attrs `href, target, rel` on `a` (force `rel="noopener noreferrer"`, drop `javascript:`); strip everything else (script/style/iframe/on*). Wire it: sanitize `draft.bodyHtml` in `stageItem` BEFORE the article insert, and in the human-edit save path (`saveDraft` action / wherever bodyHtml is persisted from the editor). Tests: strips `<script>`/`onclick`/`javascript:` href; preserves `h2/h3`/lists/links; a references `<ul><li><a>` survives. (Note: `buildPostBody` appends the Sources list AFTER sanitize at publish time from `article_sources` — that stays escaped as today.)

## Task 3 — Subheadings + reference-aware prompt
In `lib/ai/generate-article.ts`, extend the prompt: instruct the model to (a) structure the article with `<h2>`/`<h3>` **sous-titres** (e.g. every 2-3 paragraphs, meaningful section titles), (b) write in a sourced/cross-checked style drawing on ALL provided sources, attributing claims, since a **references list is appended automatically** after the body (so it must NOT invent its own sources section). Keep the structured schema. Update `lib/ai/mock.ts` so the mock draft also contains `<h2>` subheadings (it already emits `<h2>Contexte</h2>` — ensure ≥2 subheadings for tests). Test: assert the prompt string contains the subheading + multi-source instructions; assert the mock draft `bodyHtml` contains `<h2>`.

## Task 4 — Article scoring
New `lib/pipeline/score.ts`: pure `computeArticleScore(input): number` (0-100) from weighted signals:
- corroboration: `sourceCount` (1 source = baseline, more = higher, capped) — the cross-check payoff;
- cluster cohesion: `bestScore` (0-1) from decideCluster;
- confidence penalties: subtract for `categoryUncertain`/`imageMissing`/`clusterUncertain`/`aiDegraded`;
- completeness: body length ≥ threshold + has ≥1 `<h2>`;
- image present; category certain.
Document the weighting; clamp 0-100. Wire into `stageItem` to set `articles.score` at insert (compute from the draft + sourceCount + bestScore + confidence). Unit-test the pure function across representative inputs (single low-confidence source → low; multi-source + image + subheadings + no flags → high; monotonic in sourceCount). Surface the score in the review queue UI (`/queue`) as a small badge (read-only; optional but do it — one line in the queue query + list item).

## Task 5 — Pluggable web search provider (optional, off by default)
New `lib/search/index.ts`: `searchRelated(query: string, opts): Promise<{title:string;url:string;snippet:string}[]>`. Provider chain: Brave (`BRAVE_SEARCH_API_KEY` env) → none. Returns `[]` when `webSearchEnabled` (settings) is false OR no key — a graceful no-op, never throws. New `lib/search/brave.ts` (fetch Brave API). Respect a small result cap. Tests: no-op returns `[]` when disabled/keyless; Brave parser maps a fixture JSON response to results (no real network — feed a canned response). Do NOT fetch/extract the result URLs here — that's Task 6's job (reusing the SSRF-safe extract chain).

## Task 6 — Batch cross-check synthesis in the runner (the load-bearing change)
Restructure `executeRun` (lib/pipeline/run.ts) phase 2 to synthesize per STORY, not per item:
- **Phase 1 (unchanged collect)** then **embed each candidate** (`embed()` on title+snippet) and **group candidates by embedding similarity** into stories (greedy: a candidate joins an existing group if cosine ≥ `clusterThreshold` to the group's centroid/first member, else starts a new group). Cap group size sensibly.
- **Phase 2 per group:** pick a primary; for each member, `recordRawItem` (marks ALL members seen — resolves the dedup tension: merged members never become separate articles next run) + `extract` its content. If `webSearchEnabled`, `searchRelated(primary.title)` → fetch+extract top web results via the SSRF-safe extract chain → add as sources. Then ONE `generateArticle({ sources: [...all members + web...] })`, sanitize (Task 2), compute score (Task 4), insert ONE article + N `article_sources` rows (one per member + per web source) + 1 embedding. Emit live steps per group (reuse the hooks). `current_item` = primary title.
- Progress: `total_items` becomes number of STORIES (groups); `processed_items` per group. Keep the always-finalize + overlap invariants. Update the two-phase cap: `maxItemsPerRun` now caps STORIES (groups) or candidates — decide and document (recommend: cap candidates collected as today, then group; a group counts as one processed unit).
- **Tests** (real Neon, network-free, mock providers, full cleanup): (a) two same-story candidates (near-identical fixture content) collapse into ONE article with 2 `article_sources` rows; (b) two unrelated candidates → 2 articles; (c) all members recorded as seen (raw_items count matches, none reprocessed); (d) score set on the article; (e) invariants: run finalizes, one-running interlock holds; (f) web augmentation adds a source when enabled+mocked, and is skipped (no error) when disabled.
- This restructure MUST keep `runPipeline`/the cron route working and all existing pipeline tests green (adjust them for the new per-story semantics where they assert per-item counts).

## Verify (whole SP4)
`bun run typecheck` 0; `bun test` full suite green. Manual: a dev run produces a `pending` article with subheadings + multiple sources (references visible in the WP preview via `buildPostBody`) + a score. Commit per task (SDD). Update the roadmap SP4 box to done.

## Notes for later SPs
`articles.score` → SP6 auto-publish gate. Web-source quality/ranking, and prior-run article merging, are explicit future work.

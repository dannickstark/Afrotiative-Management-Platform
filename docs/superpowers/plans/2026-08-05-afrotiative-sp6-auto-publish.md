# SP6 — Gated auto-publish (default OFF) — Plan

**Goal:** When a generated article's `score ≥ threshold` AND safety conditions hold, auto-approve it for publication — behind a global setting that DEFAULTS OFF, with an audit trail. A deliberate, admin-configured exception to the human-review barrier.

**Branch:** `feat/pipeline-v2` (after SP5). Single well-scoped implementer + review.

## Design principle — reuse the barrier's own mechanism
The human-review barrier is enforced at ONE point: `publishDueArticles()` publishes ONLY `status='approved'` articles (and articles only reached `approved` via the human-gated `schedule()`). We do NOT weaken that. Instead, auto-publish adds a SECOND, gated way to reach `approved`: a qualifying article is **auto-approved** (status `approved` + `scheduledAt = now`) so the EXISTING, tested publish-due cron publishes it. So:
- `publishArticle`/`publishDueArticles` are UNCHANGED — the pipeline stays decoupled from WordPress.
- "pending is never published directly" stays TRUE (the existing test keeps passing).
- The only change: an article can now reach `approved` via gated auto-approval, recorded in `article_revisions` for audit.

## Settings (SP1, already present) 
`autoPublishEnabled` (bool, default **false**), `scoreThreshold` (auto-publish min score, default 70), `autoPublishMinSources` (default 2). Read via `getPipelineSettings()`.

## Global constraints
- **Default OFF.** French copy. Human-review barrier's enforcement point (`publishDueArticles` = only `approved`) untouched. Additive only. Best-effort (an auto-approve failure never fails a run; the article falls back to `pending`).

## Tasks (one implementer, multi-commit ok)

### 1. Auto-publish gate (pure, tested)
New `lib/pipeline/auto-publish.ts`: pure `shouldAutoPublish(input): boolean` where input =
`{ enabled: boolean; score: number|null; scoreThreshold: number; sourceCount: number; minSources: number; hasImage: boolean; confidence: { categoryUncertain?; imageMissing?; clusterUncertain?; aiDegraded? } }`.
Returns true iff: `enabled` AND `score != null && score >= scoreThreshold` AND `sourceCount >= minSources` AND `hasImage` AND NONE of the low-confidence flags set. Document the conditions. Unit tests: enabled+high-score+image+sources+no-flags → true; each failing condition individually → false; disabled → always false; null score → false.

### 2. Wire auto-approve into `stageSources` (`lib/pipeline/stages.ts`)
After computing `score` + the confidence flags, evaluate `shouldAutoPublish(...)` (reads `perOperation`... no — pass the settings-derived values in; the runner already reads `getPipelineSettings()` and can pass `{autoPublishEnabled, scoreThreshold, autoPublishMinSources}` into `stageSources`, OR stageSources reads settings itself — match how the timeout was threaded). If it passes, INSERT the article with `status: "approved"` + `scheduledAt: new Date()` (instead of `pending`) — inside the SAME transaction — and add an `article_revisions` row: `action: "publié automatiquement"`, `detail: "Score {score} ≥ seuil {threshold}; {n} source(s); aucune alerte de confiance."` (actorId null = system). If the gate fails → `status: "pending"` exactly as today.
- Emit a distinct live step / journal note when an article is auto-approved (e.g. a `"Publication automatique"` step, French) so the run's live view + trace show it happened. Best-effort.
- The article is now `approved` + `scheduledAt=now` → the existing `publishDueArticles()` cron (POST /api/publish/due) publishes it on its next run. No change to that path.

### 3. Docs — record the policy change
- `README.md`: update the "Barrière de revue humaine (non négociable)" note to state that auto-publication is an **optional, désactivée par défaut, réservée admin** exception for high-confidence articles (score ≥ seuil + conditions de sûreté), **auditée** via `article_revisions`, and that the enforcement point (seuls les articles `approved` sont publiés) reste intact.
- `docs/superpowers/specs/2026-08-04-afrotiative-sp5-wordpress-publish-design.md` (or wherever the barrier is documented): add a short note pointing to this SP6 policy.
- Update the `publishDueArticles` in-code comment that says "an article only ever reaches approved via the human review flow" → "…via the human review flow OR gated auto-approval (SP6, default off, audited)".

### 4. Tests (bun:test, real Neon dev, network-free, cleanup)
- Gate unit tests (Task 1).
- Integration: run the pipeline (or call `stageSources` directly) with `autoPublishEnabled=true` (upsert settings singleton, snapshot/restore) + a fixture yielding a HIGH-score, image-present, multi-source, no-flags article → assert the article is `status='approved'`, `scheduledAt` set, and an `article_revisions` "publié automatiquement" row exists. With `autoPublishEnabled=false` (or a low score / missing image / <minSources / a confidence flag) → article stays `pending`, no auto-approve revision.
- Confirm the existing publish-due human-review-gate test STILL passes (pending never published directly).
- Full cleanup (articles cascade, clusters, raw_items, run, feed; restore settings singleton).

## Verify
`bun run typecheck` 0; `bun test` full suite green. Update roadmap SP6 box. Commit(s) per the above.

## Notes
Mock/degraded articles set `aiDegraded` → auto-publish is blocked for them (good). If WordPress isn't configured, the auto-approved article simply waits `approved`+scheduled until the publish-due cron can publish it (no run failure). Auto-published articles appear in `/published` with the audit revision; they do NOT clutter `/queue`.

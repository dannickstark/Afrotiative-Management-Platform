# V3 — Aperçu dans la page article — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the article's image panel into *Image originale* / *Aperçu final*, and make the image actually published to WordPress be the **generated** one, produced at "Approuver & publier".

**Architecture:** A tab in an existing client component calls a new guarded Server Action that delegates to V1's `renderForArticle`. The publish path asks V1 for a render before building the WordPress payload and uploads that instead of the raw image.

**Tech Stack:** Next.js 16 App Router · shadcn on Base UI (`render` prop, never `asChild`) · Drizzle/Postgres

**Spec:** `docs/superpowers/specs/2026-08-09-afrotiative-v3-apercu-article-design.md`

## Global Constraints

- **Read the Next.js docs** under `node_modules/next/dist/docs/01-app/` before touching Server Actions or config — `AGENTS.md` requires it, and Task 3 changes `next.config.ts`.
- **Every export of a `"use server"` module is an unauthenticated Server Action** (`lib/actions/taxonomy-actions.ts:5-11`). Guard with `requireUser()` + `requirePermission()`.
- All user-facing strings in **French**.
- **The human-review barrier is untouchable:** `publishDueArticles` must continue to select only `status='approved'`. `tests/publish-due.test.ts` asserts it; that test must stay green and unmodified.
- **Never run two `bun test` invocations concurrently** (`test-setup.ts:38-40`).
- **Two pre-existing suite failures** — `tests/pipeline-web-search.test.ts` case (a), `tests/pipeline-pause-resume.test.ts` checkpoint (b) — attributed at the branch point, not yours.
- Commit messages in **French**, prefix `feat(article):` / `fix(article):`, ending with:
  `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`

---

### Task 1: `next.config.ts` — native packages, and prove the import works

**Files:** `next.config.ts`, `tests/studio-server-import.test.ts` (create)

V1's whole-branch review assigned this here: nothing in `app/` imported `lib/studio` before, and `sharp` / `@resvg/resvg-js` / `satori` ship native `.node` binaries that Turbopack cannot bundle. The file already documents the identical problem for `jsdom` / `css-tree` — same remedy, same reason.

- [ ] Read `node_modules/next/dist/docs/01-app/03-api-reference/05-config/` on `serverExternalPackages`.
- [ ] Add `sharp`, `@resvg/resvg-js` and `satori` to `serverExternalPackages`, with a comment explaining that V3 is the first application-code consumer of `lib/studio`.
- [ ] Write a test that imports `renderForArticle` the way a Server Action does and asserts the module loads and the export is a function. This is a cheap guard against a future bundling regression.
- [ ] `bun run typecheck`, `bun run build` (the build is the real proof here — a bundling failure will not show up in `bun test`), full `bun test` once, commit.

### Task 2: The *Aperçu final* tab

**Files:** `components/article/image-panel.tsx`, `lib/actions/article-preview-actions.ts` (create), `tests/article-preview.test.ts` (create)

**Contract:**
- `previewArticleImage(articleId)` — guarded by `article:edit`; delegates to `renderForArticle(articleId, { context: "article_image" })` and returns its result shape unchanged.
- `image-panel.tsx` gains two tabs (`components/ui/tabs.tsx` exists). **Onglet « Image originale »** is the current content, behaviour unchanged. **Onglet « Aperçu final »** renders on demand.
- The render is triggered **only when the tab is first opened** — never on page load. Most article views will never open it, and a render costs seconds.
- Four states, all explicit: the image (plus the template's name); « Aucun gabarit configuré — l'image originale sera publiée telle quelle. » for `{ ok: true, url: null }`; the engine's French message for `{ ok: false }`, presented as a list of missing information rather than a technical error; « Stockage R2 non configuré. » when unconfigured.

**Required tests:** the action is refused for a role without `article:edit`; opening the tab triggers exactly one render and re-opening triggers none (the V1 `inputHash` cache makes the second call a lookup); the no-template case renders the explanatory copy, not an error.

**Steps:** failing tests first, confirm they fail for the right reason, implement, verify, `bun run typecheck`, full `bun test` once, commit.

### Task 3: Publish the generated image

**Files:** `lib/wp/publish.ts`, `tests/wp-publish-render.test.ts` (create)

**Contract:** in `buildPublishPayload`, before uploading the featured image, call `renderForArticle(articleId, { context: "article_image" })`:

1. `{ ok: true, url }` → upload **that** URL to the WordPress media library.
2. `{ ok: true, url: null }` → no template configured; upload `articles.featuredImageUrl` exactly as today.
3. `{ ok: false, message }` → **the publish fails** with that French message; the article stays `approved` and is retryable.

Case 3 is a deliberate hardening and must be commented as such: `uploadFeaturedImage` is *fail-soft* today, so an unreachable image publishes an article with no featured image. Once a template is configured the generated image **is** the article's illustration, and shipping without it produces a visibly broken post. The fail-soft behaviour of the WordPress upload itself is unchanged.

**`articles.featuredImageUrl` must never be rewritten** — it remains the record of the original image with its credit and source link, and it is what the template re-renders from each time.

**Required tests:**
- with a resolved template, the URL handed to the WordPress media upload is the render's, not the raw image's;
- with no template, the raw image is used and behaviour is byte-identical to today;
- a failing render fails the publish and leaves `status = 'approved'`;
- `featuredImageUrl` is unchanged after a successful publish;
- two successive publishes produce **one** render (cache hit).

`tests/wp-publish.test.ts` and `tests/publish-due.test.ts` must stay green **without modification** — they cover the no-template path, which is unchanged. If they need editing, something in the contract above was misread; stop and report rather than editing them.

### Task 4: Incomplete-article copy + documentation

**Files:** `components/article/image-panel.tsx`, `README.md`, `docs/DEPLOYMENT.md`, `tests/article-preview-incomplete.test.ts` (create)

**Contract:** an article with no featured image or no category makes the render fail hard (V1 §6, by design). The engine's message already names the missing tokens; the tab must present them as a checklist of what to complete, in French, with the field names an editor recognises — not `article.image` but « image à la une ».

Document in `README.md` that the published image is generated at approve-time, and in `docs/DEPLOYMENT.md` that a configured `article_image` template makes a successful render a **precondition** of publishing.

**Required tests:** an article missing its image produces copy naming « image à la une »; an article missing its category names « catégorie ».

---

## Self-Review

**Spec coverage:** §1 tabs → Task 2; §2 publish-time generation → Task 3; §3 V1 debt → Tasks 1 and 4; §4 errors → Tasks 2 and 4; §5 tests → every task.

**Risks:**
1. Task 3 touches the publish path, which carries the project's most load-bearing invariant. The existing publish suites staying green *unmodified* is the signal that the no-template path was preserved.
2. Task 1's real proof is `bun run build`, not `bun test` — a Turbopack bundling failure will not surface in the test runner.
3. Task 2's "renders only when opened" is easy to get wrong with an eager `useEffect`; assert the call count.

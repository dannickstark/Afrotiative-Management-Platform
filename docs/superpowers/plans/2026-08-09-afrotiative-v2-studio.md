# V2 — Studio (éditeur visuel) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give V1's headless render engine a usable interface — create, edit, preview and publish templates; upload brand assets and fonts; set category colours; generate one-off images.

**Architecture:** Server Components fetch, Client Components edit, Server Actions write. The editor canvas is DOM (absolutely-positioned divs) styled by the **same** `textStyleFor` the renderer uses, so there is one source of truth for text styling. Real fidelity comes from an on-demand render through the V1 engine, returned as a data URI so drafts never touch the cache or object storage.

**Tech Stack:** Next.js 16 App Router (RSC + Server Actions) · TypeScript · Bun · Drizzle/Postgres · shadcn on **Base UI** (`base-nova` preset — `render` prop, never `asChild`) · Tailwind v4 · sonner

**Spec:** `docs/superpowers/specs/2026-08-09-afrotiative-v2-studio-design.md`

## A note on this plan's style

Unlike this programme's V1 plan, tasks below specify **contracts, behaviour and required tests** rather than transcribing complete implementations. V1's experience is the reason: its plan carried full sample code, and reviewers found real defects *in that sample code* on nine of thirteen tasks — an incomplete `extractTokens`, English leaking through Zod, a tautological assertion, an unguarded font loader. Implementers correcting a bad sample cost more than implementers writing to a clear contract.

So: exact names, signatures, French copy and acceptance criteria are binding. How the component is built is the implementer's call. **Use a mid-tier model or better for every task here** — none of these is transcription.

## Global Constraints

- **Read the Next.js docs first.** `AGENTS.md` is non-negotiable: this Next.js version has breaking changes vs. training data. Before writing any route, layout, Server Action or `next/*` import, read the relevant guide under `node_modules/next/dist/docs/01-app/`. This applies to nearly every task here.
- **Every export of a `"use server"` module is an unauthenticated Server Action.** `lib/actions/taxonomy-actions.ts:5-11` documents this trap. Every action starts with `requireUser()` + `requirePermission()`. Never export a raw DB writer from a `"use server"` file — put the core in a plain module and keep the guarded action as the only door.
- **All user-facing strings in French.** Actions return `{ ok: false, message }` rather than throwing; the UI surfaces `message` verbatim via `sonner`.
- **Base UI, not Radix:** `render={<Component />}`, never `asChild`. Follow `components/shell/nav-main.tsx`.
- **Never run two `bun test` invocations concurrently** — they share a live Neon dev branch (`test-setup.ts:38-40`).
- **DB-writing tests must delete their scopes defensively in `beforeAll`** and clean up in `afterAll` even on failure. Use `tests/studio-fixtures.ts`.
- **Two pre-existing suite failures** — `tests/pipeline-web-search.test.ts` case (a) and `tests/pipeline-pause-resume.test.ts` checkpoint (b) — were attributed at the branch point and are not yours. Report the tally; anything beyond those two is yours.
- Commit messages in **French**, prefix `feat(studio):`, ending with:
  `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`

## What V1 already gives you (`lib/studio/`)

`renderForArticle`, `renderScene`, `resolveTemplate`, `validateScene`, `parseScene`, `sceneSchema`, `extractTokens`, `CONTEXT_TOKENS`, `TOKEN_KINDS`, `TOKEN_IDS`, `TEMPLATE_CONTEXTS`, `CHANNELS`, `FORMAT_PRESETS`, `FORMAT_KEYS`, the `Scene`/`Layer`/… types, `TemplateContext`/`Channel` types, `AssetLoader`/`LoadedFont`, `MemoryRenderStore`, and the error classes `RenderError`/`MissingTokensError`/`ImageFetchError`/`SceneError`. `textStyleFor` is exported from `lib/studio/element.ts`.

Tables: `render_templates` (working `scene`, `publishedVersion`, `archived`, scope unique on `(context, channel, category_id)` **NULLS NOT DISTINCT WHERE archived = false**), `render_template_versions`, `render_assets` (declared, unused), `renders`.

---

# Lot 1 — Fondations

### Task 1: RBAC `template` + queries + studio list page

**Files:** `lib/rbac.ts`, `lib/queries/studio.ts` (create), `app/(app)/studio/page.tsx` (create), `components/studio/templates-table.tsx` (create), `components/shell/nav-items.ts`, `tests/studio-rbac.test.ts` (create)

**Contract:**
- `lib/rbac.ts`: resource `template`, actions `read` / `manage` / `publish`. `editor` and `admin` get all three; `journalist` gets none.
- `lib/queries/studio.ts` exports `listTemplates(): Promise<TemplateRow[]>` where `TemplateRow = { id, name, context, channel, categoryId, categoryName, format, width, height, archived, publishedVersion, hasUnpublishedChanges, updatedAt }`. `hasUnpublishedChanges` is derived by comparing `scene` to the published version's snapshot — **not** stored.
- `/studio` is a Server Component: `requireUser()` + `requirePermission(role, "template", "read")`, then renders the table grouped by context.
- Nav: a **Studio** section in `NAV_SECTIONS` with *Gabarits* (`/studio`), roles `["admin","editor"]`. `ROUTE_LABELS` picks it up automatically since `NAV_ITEMS` is derived.

**Steps:**
- [ ] Read `node_modules/next/dist/docs/01-app/` guides for Server Components and `app` routing before writing the page.
- [ ] Write failing tests: `can("journalist","template","read")` is false; `can("editor","template","publish")` is true; `hasUnpublishedChanges` true when `scene` differs from the published snapshot and false when identical.
- [ ] Run them, confirm they fail for the right reason.
- [ ] Implement.
- [ ] Confirm green; `bun run typecheck`; full `bun test` once; commit.

### Task 2: Template CRUD Server Actions

**Files:** `lib/actions/studio-actions.ts` (create), `lib/studio/template-core.ts` (create — plain module, not `"use server"`), `tests/studio-template-actions.test.ts` (create)

**Contract** — every action guarded, every return `{ ok: true, ... } | { ok: false, message }`:
- `createTemplate({ name, context, channel, categoryId, format })` — width/height frozen from `FORMAT_PRESETS[format]`; seeds a minimal valid scene (canvas + one text layer); returns `{ ok: true, id }`. On scope conflict returns a French message **naming the existing template**.
- `renameTemplate(id, name)`, `duplicateTemplate(id)` (copies the working scene, new name suffixed « (copie) », `publishedVersion: null`, and a **free** scope — if the source's scope is taken, the copy is created unscoped with a message saying so), `archiveTemplate(id, archived)`.
- `saveTemplateScene(id, scene)` — validates with `parseScene` **and** `validateScene(scene, context)`; refuses on either. This is the autosave endpoint.
- `publishTemplate(id)` — `validateScene` must return `[]`; inserts a snapshot at `version = max+1` and sets `publishedVersion`, **in one `db.transaction`**; returns the new version number.
- `restoreVersion(id, version)` — copies that snapshot into `scene`; **must not** touch `publishedVersion`.

**Required tests:** journalist refused on each action; scope conflict message; publish refused on an invalid scene; version increments 1→2; the snapshot is immutable after a later `saveTemplateScene`; `restoreVersion` leaves `publishedVersion` unchanged.

**Steps:** as Task 1 — failing tests first, confirm the failure, implement, verify, commit.

### Task 3: Category colour in `/settings/taxonomy`

**Files:** `lib/actions/taxonomy-actions.ts`, `components/settings/taxonomy-tables.tsx`, `lib/queries/settings.ts`, `tests/category-color.test.ts` (create)

**Contract:** `setCategoryColor(id, color: string | null)` guarded by `taxonomy:manage`; accepts strict `#RRGGBB` or `null`/empty (clears); anything else returns a French refusal. The table gains a **Couleur** column: a colour swatch plus an input. `TaxonomyTables`' `Row` type was narrowed during V1 — widen it for categories only, keeping tags unchanged.

This closes V1's documented gap: with no colour set, every render uses `DEFAULT_CATEGORY_COLOR`.

**Required tests:** `#1B7F4A` accepted; `rouge` refused; empty clears to `null`; a journalist is refused.

---

# Lot 2 — Éditeur

### Task 4: Scene reducer + coordinate maths

**Files:** `lib/studio/editor-state.ts` (create — pure), `tests/studio-editor-state.test.ts` (create)

**Contract:** a pure reducer over `{ scene: Scene; selectedId: string | null; past: Scene[]; future: Scene[] }` with actions: `select`, `moveLayer(id, dx, dy)`, `resizeLayer(id, frame)`, `rotateLayer(id, deg)`, `setLayerProp(id, patch)`, `addLayer(type)`, `deleteLayer(id)`, `reorderLayer(id, toIndex)`, `toggleVisible(id)`, `toggleLocked(id)`, `undo`, `redo`.

Rules: every produced scene passes `parseScene` — if an action would produce an invalid scene, the reducer returns the previous state unchanged. Never mutate. A `locked` layer ignores move/resize/rotate/delete. Undo history capped at 50.

Also export `toCanvasCoords(clientDelta, scale)` and its inverse — the editor renders at `transform: scale(k)`, and a drag of N screen pixels must move the layer by `N / k` **template** pixels.

**Required tests:** each action; locked-layer immunity; the invalid-scene guard; undo/redo round-trip; no mutation of the input; coordinate conversion at `k = 0.5` and `k = 1.7`.

### Task 5: Canvas surface + layer rendering

**Files:** `components/studio/canvas.tsx` (create), `components/studio/layer-view.tsx` (create), `tests/studio-canvas.test.ts` (create)

**Contract:** renders a scene as absolutely-positioned DOM at scale `k`, sized to the template's real dimensions. **Text layers must use `textStyleFor` from `lib/studio/element.ts`** — do not re-derive text styling. Image layers show the asset/URL or a placeholder for an unresolved `{{slot}}`; shape and QR layers render representatively. Selection outline on the selected layer; `locked` layers are visually marked and not interactive.

**Required tests:** a scene renders one node per visible layer in array order (paint order); an invisible layer renders nothing; text style comes from `textStyleFor` (assert a property only that function produces, e.g. `lineClamp` from `maxLines`).

### Task 6: Drag, resize, rotate

**Files:** `components/studio/canvas.tsx`, `hooks/use-layer-drag.ts` (create), `tests/studio-drag.test.ts` (create)

**Contract:** pointer-events based (not mouse-only). Drag moves; eight handles resize; one handle rotates. Every gesture converts screen deltas to template pixels via Task 4's helper. `Suppr` deletes, arrows nudge 1px, `Maj+arrows` 10px. Gestures commit **one** undo entry each, not one per pointer-move.

**Required tests:** a simulated drag of 100 screen px at `k = 0.5` moves the layer 200 template px; a resize respects a 1px minimum; a locked layer does not move; one gesture yields exactly one undo entry.

### Task 7: Layer panel

**Files:** `components/studio/layer-panel.tsx` (create), `tests/studio-layer-panel.test.ts` (create)

**Contract:** lists layers **top-most first** (i.e. reversed relative to the scene array — paint order is bottom-up, and users expect the opposite). Reorder by drag or by up/down buttons, toggle visibility and lock, delete, add a layer of each of the four types. Renaming a layer edits `name`.

**Required tests:** the displayed order is the reverse of `scene.layers`; moving the top item down reorders the underlying array correctly (this is the assertion most likely to be written backwards — verify it by constructing a three-layer scene and checking ids, not lengths).

### Task 8: Property panel + token binding

**Files:** `components/studio/property-panel.tsx` (create), `components/studio/token-picker.tsx` (create), `tests/studio-token-picker.test.ts` (create)

**Contract:** per-layer-type property forms — frame x/y/w/h, rotation, opacity; text: content, font family/size/weight/italic, colour, align, vAlign, lineHeight, letterSpacing, maxLines, autoFit, shadow, stroke; image: source (asset / slot / URL), fit, radius, blur, overlay; shape: fill (solid or gradient), radius, border with per-side toggles; QR: slot, fg, bg, margin.

The **token picker** offers only `CONTEXT_TOKENS[template.context]`, filtered by the `TokenKind` the field expects — an image slot lists only `image` tokens, a colour field only `color` tokens. Each token shows its French label.

This is where V1's `article.url`-in-`article_image` rule becomes visible to users: the token simply is not offered.

**Required tests:** the picker for an `article_image` template never offers `article.url`; a colour field never offers a `text` token; changing a property produces a scene that still validates.

### Task 9: Editor shell, autosave, publish, version history

**Files:** `app/(app)/studio/[id]/page.tsx` (create), `components/studio/editor-shell.tsx` (create), `components/studio/version-history.tsx` (create), `tests/studio-autosave.test.ts` (create)

**Contract:** composes canvas + layer panel + property panel. Autosaves the draft 1.5s after the last change via `saveTemplateScene`, with a visible state (« Enregistré » / « Enregistrement… » / « Échec »). *Publier* calls `publishTemplate` and surfaces `validateScene` errors field-by-field on refusal. Version history lists versions with *Restaurer*. A « modifications non publiées » badge when the draft differs from the published snapshot.

**Required tests:** autosave debounces (N rapid edits → 1 call); a failed save surfaces the error and does **not** clear the dirty state; publish refusal lists the errors.

### Task 10: Real preview

**Files:** `lib/actions/studio-preview-actions.ts` (create), `lib/studio/sample-values.ts` (create), `components/studio/preview-pane.tsx` (create), `tests/studio-preview.test.ts` (create)

**Contract:** `previewTemplate({ templateId, values? })` — guarded; renders the **draft** scene via `renderScene` and returns `{ ok: true, dataUri, degraded }`. It must write **nothing**: no `renders` row, no R2 object. Values resolve in order: caller-supplied → selected article (`articleTokenValues`) → `SAMPLE_VALUES` (French sample data so a brand-new template previews immediately).

Debounced 800ms after the scene stabilises, plus an *Actualiser* button. Failures show the engine's French message in the pane. `degraded` shows a badge.

**Required tests:** a preview leaves `renders` row-count and the store untouched (use `MemoryRenderStore` and assert `objects.size === 0`, plus a DB count before/after); sample values alone are sufficient to render every seeded starter template; a failing render surfaces the message rather than throwing.

---

# Lot 3 — Bibliothèque

### Task 11: Asset upload + library page

**Files:** `lib/actions/asset-actions.ts` (create), `lib/studio/asset-validate.ts` (create — pure), `app/(app)/studio/assets/page.tsx` (create), `components/studio/asset-library.tsx` (create), `tests/studio-asset-validate.test.ts` (create)

**Contract:** `uploadAsset(formData)` guarded by `template:manage`. Limits: images 5 MB / `png,jpeg,webp,svg`; fonts 2 MB / TTF/OTF. **The browser-declared MIME type is never trusted** — `asset-validate.ts` decides: images must survive `sharp().metadata()` with real dimensions; fonts must start with `00 01 00 00`, `true`, `ttcf` or `OTTO`. **WOFF2 is refused explicitly** with a French message saying Satori cannot read it. On success: R2 put under `assets/{yyyy}/{mm}/{uuid}.{ext}`, then a `render_assets` row.

`deleteAsset(id)` refuses when a **non-archived** template references the asset, naming those templates.

**Required tests** (pure, no network): a WOFF2 buffer is refused; a file declaring `image/png` but containing text is refused; a 6 MB image is refused; each valid font magic is accepted; delete refused while referenced.

### Task 12: `DbAssetLoader` + wire it in + fix the leak

**Files:** `lib/studio/asset-loader.ts` (create), `lib/studio/index.ts`, `lib/studio/render.ts`, `tests/studio-asset-loader.test.ts` (create)

**Contract:** `DbAssetLoader implements AssetLoader` — `font(assetId)` returns a `LoadedFont` (fetch bytes from R2, cache in-process by `assetId`); `imageUrl(assetId)` returns the public URL. A missing asset returns **`null`**, never throws — that is the contract `renderScene` degrades on.

`renderForArticle` uses `DbAssetLoader` by default (still overridable via the `assets` option).

**Also fix, now that this path is reachable:** `lib/studio/render.ts`'s `assets.imageUrl()` call currently lets a rejecting loader leak a raw English error. V1's review deferred it precisely until a real loader existed. Wrap it: a French `RenderError`, with `console.error` and `{ cause }`, matching the pattern used at every other native boundary in that file.

**Required tests:** a font asset round-trips; an unknown id returns `null`; a **rejecting** loader produces a French `RenderError`, not a raw leak; the in-process cache serves a second call without a second fetch.

### Task 13: Asset and font pickers in the editor

**Files:** `components/studio/asset-picker.tsx` (create), `components/studio/property-panel.tsx`, `tests/studio-asset-picker.test.ts` (create)

**Contract:** an image layer's source can be chosen from the library; a text layer's font can be chosen from uploaded fonts, falling back to the bundled Noto Sans. Pickers show a thumbnail (images) or a rendered sample (fonts).

**Required tests:** selecting an asset sets `{ kind: "asset", assetId }`; selecting a font sets `font.assetId`; the bundled family remains selectable.

---

# Lot 4 — Saisie manuelle

### Task 14: `/studio/generer`

**Files:** `app/(app)/studio/generer/page.tsx` (create), `components/studio/manual-generate.tsx` (create), `lib/actions/studio-manual-actions.ts` (create), `tests/studio-manual.test.ts` (create)

**Contract:** pick a context among `quote_card` / `newsletter_header` / `recap_card`; the form is **built from `CONTEXT_TOKENS[context]`**, one field per token typed by `TOKEN_KINDS` (text input, colour input, asset picker for images). `renderManual({ context, channel, categoryId, values })` — guarded — renders and **does** persist (R2 + a `renders` row with `subjectType: "manual"`, `subjectId: null`), returning the URL with a download link.

This is what finally makes V1's `quote.*` / `edition.*` / `recap.*` tokens useful.

**Required tests:** the form's field set matches `CONTEXT_TOKENS` for each context; `renderManual` writes exactly one `renders` row with `subjectType: "manual"`; missing values produce the engine's French message.

### Task 15: Documentation + read-only mode without R2

**Files:** `README.md`, `docs/DEPLOYMENT.md`, `components/studio/*`, `tests/studio-no-r2.test.ts` (create)

**Contract:** when `getStudioConfig()` returns `null`, `/studio` renders with an explicit French banner and upload/preview/publish disabled rather than failing at click time. Document the studio surfaces in `README.md` and the operator steps in `docs/DEPLOYMENT.md` (including that `STUDIO_BRAND_LOGO_URL` is optional and what breaks without it).

**Required tests:** with the five `R2_*` vars cleared, the actions return the French "non configuré" message rather than throwing.

---

## Self-Review

**Spec coverage:** §1 surfaces → Tasks 1, 9, 11, 14, 3. §2 editor model → Tasks 4-8. §3 state/persistence → Tasks 2, 9. §4 preview → Task 10. §5 assets → Tasks 11-13. §6 category colour → Task 3. §7 manual contexts → Task 14. §8 errors → Tasks 2, 10, 15. §9 tests → every task. §10 lots → the four sections.

**Known risks flagged for implementers:**
1. Task 7's reversed layer ordering is the single most likely place to write a backwards assertion.
2. Task 10 must be proven to write nothing — assert store size *and* a DB row count, not just a successful return.
3. Task 12's leak fix only becomes testable once a real loader exists; do not skip it.
4. Task 6 must commit one undo entry per gesture, not per pointer-move.

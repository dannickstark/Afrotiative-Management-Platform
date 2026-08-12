# Studio Pro · Chantier A — Coque canevas-d'abord & IA responsive — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Take the studio editor full-screen out of the admin shell, make it canvas-first and responsive (drawers below ~1024), and turn the template list into a visual thumbnail gallery — the structural fixes for "cramped, ugly, not responsive."

**Architecture:** The editor route moves to its own route group with a no-sidebar full-screen layout (auth preserved); `EditorShell`'s header becomes the editor top bar; the three-zone body gets a neutral canvas backdrop, compact empty states and resizable borders; a pure `editorLayoutMode(width)` drives Sheet-based drawers at narrow widths; `/studio` gains a rendered-thumbnail card grid with a grid⇄table toggle.

**Tech Stack:** Next.js 16.3 App Router (Turbopack — a breaking-change fork; READ `node_modules/next/dist/docs/` before touching routing/layouts), Bun test, the U0 DOM harness, `components/ui/sheet.tsx` (drawers), `hooks/use-mobile.ts`, Playwright (dev-server screenshots for visual verification — a `.claude/launch.json` dev config already exists; creds are in README).

## Global Constraints

- **Auth is never weakened.** Every route that renders the editor must keep `requireUser()` + `requirePermission(role,"template","read")` exactly as `app/(app)/studio/[id]/page.tsx` has today.
- **No URL changes.** The editor stays at `/studio/[id]`; the list at `/studio`; assets at `/studio/assets`; generer at `/studio/generer`. Route groups `(name)` must not alter these paths.
- **`/studio` (list) + `/studio/assets` keep the admin shell.** Only the EDITOR goes full-screen.
- **Scope = structure + responsive + gallery.** No zoom/pan mechanics (B), no inspector-field redesign (C), no brand/motion craft (E). Don't regress D's constraints widget in the inspector.
- **Pure-first + mutation-as-judge + anti-vacuity** as in chantiers D/U4. `lib/`/pure helpers stay DB-free/client-safe. Fast loop `bun run test:pure`.
- **Visual proof is Playwright** at 1440/1280/1024/768, before/after.

---

## Task 1: Spike — full-screen editor routing (STOP-AND-REPORT)

**This Next.js is a breaking-change fork; nothing here has escaped a parent layout via route groups. Prove the mechanism before building the top bar / body on it. If it doesn't work as expected, STOP and report — the fallback (a conditional layout / `usePathname` chrome-hiding) is the human's call.**

**Files:**
- Create: `app/(studio-editor)/layout.tsx` (minimal full-screen layout: `requireUser()`, no sidebar/header, renders `{children}` edge-to-edge)
- Move: `app/(app)/studio/[id]/` → `app/(studio-editor)/studio/[id]/` (page unchanged; keep its `requireUser`+`requirePermission`)
- Keep in `(app)`: `studio/page.tsx` (list), `studio/assets/`, `studio/generer/`
- Test: `tests/studio-fullscreen-route.test.ts` (as feasible) + a Playwright manual check

**Interfaces:**
- Produces: a working `/studio/[id]` that renders WITHOUT the app sidebar/header, same URL, auth intact, and a `← Gabarits` back-nav target (`/studio`).

- [ ] **Step 1: Read the routing docs.** Read `node_modules/next/dist/docs/` on route groups + layouts (how a route group's layout replaces vs nests; whether two groups can serve sibling paths `/studio` and `/studio/[id]` without collision).
- [ ] **Step 2: Create `app/(studio-editor)/layout.tsx`** — `async` server layout, `await requireUser()`, returns `<div className="h-dvh w-dvw overflow-hidden">{children}</div>` (no SidebarProvider). NO permission-less path.
- [ ] **Step 3: Move the editor route** `app/(app)/studio/[id]/` → `app/(studio-editor)/studio/[id]/` (git mv the directory). Leave the page's own `requireUser`+`requirePermission` intact (belt-and-suspenders with the layout guard).
- [ ] **Step 4: Verify (the spike's proof).** `bun run dev` (via `.claude/launch.json`) + Playwright: log in, navigate `/studio` (admin shell present) → open a template → `/studio/[id]` renders full-screen (NO app sidebar), URL unchanged; navigate directly to `/studio/[id]` while logged out → redirected to login (auth intact). Screenshot both. Also confirm `/studio/assets` + `/studio/generer` still show the admin shell.
- [ ] **Step 5: STOP and report.** Does route-group layout-escape work in this Next with no URL change and no collision? If YES, hand Task 2 the full-screen shell. If NO (collision, or the parent layout still wraps), report the exact failure + the recommended fallback and WAIT for the human.
- [ ] **Step 6: Commit.**

```bash
git add -A && git commit -m "spike(studio): l'éditeur en plein écran hors coque admin — ce que ce Next autorise (chantier A T1)"
```

---

## Task 2: Editor top bar

**Files:**
- Modify: `components/studio/editor-shell.tsx` (its existing header `:339` becomes the top-level editor bar)
- Create (optional): `components/studio/editor-topbar.tsx` if extracting the header keeps `editor-shell.tsx` focused
- Modify: `app/(studio-editor)/layout.tsx` if the bar lives in the layout vs the shell
- Test: `tests/studio-editor-shell.test.ts`

**Interfaces:**
- Consumes: the full-screen layout (T1). EditorShell already renders mode-switch/save-indicator/Historique/Publier.
- Produces: a slim top bar — left `← Gabarits` (link to `/studio`) + template name + `SaveIndicator`; center `ModeSwitch`; right a **zoom control slot** (a disabled/placeholder control that chantier B fills) + `Historique` + `Publier`.

- [ ] **Step 1: Failing test** — the editor bar renders a `← Gabarits` link to `/studio`, the template name, the mode switch, and a zoom slot; asserts the admin `Breadcrumbs`/`SidebarTrigger` are NOT present (full-screen). U0 harness.
- [ ] **Step 2: Run fail → implement** the top bar by restructuring EditorShell's header (add back-nav + zoom slot; keep save/mode/historique/publier). Ensure it's a slim single row.
- [ ] **Step 3: Run pass** + Playwright screenshot at 1440.
- [ ] **Step 4: Commit.** `git commit -m "feat(studio): barre supérieure d'éditeur — retour Gabarits, nom, mode, zoom, publier (chantier A T2)"`

---

## Task 3: Three-zone body — neutral backdrop, compact empty states, resizable borders

**Files:**
- Modify: `components/studio/editor-shell.tsx` (the flex row rail/panel/canvas/inspector)
- Modify: `components/studio/canvas-chrome.tsx` / the canvas container (neutral backdrop behind the artboard)
- Modify: `components/studio/property-panel.tsx` (compact empty state — the "Sélectionnez un calque" void)
- Modify: `lib/studio/editor-prefs.ts` + `hooks/use-editor-prefs.ts` (persist panel/inspector widths)
- Test: `tests/studio-editor-prefs.test.ts`, `tests/studio-editor-shell.test.ts`

**Interfaces:**
- Consumes: editor-prefs (add `railPanelWidth?`, `inspectorWidth?` with defaults + per-field parse, mirroring the existing boolean-pref idiom).
- Produces: a canvas zone on a neutral token background (`bg-muted/40` or similar) with the artboard centered + shadow; a compact inspector empty state; drag handles that resize + persist.

- [ ] **Step 1: Failing prefs test** — `DEFAULT_PREFS` gains `inspectorWidth`/`railPanelWidth` numbers; `parsePrefs` restores + falls back per-field (a corrupt width → default). Mutation: make the width required → a no-field prefs blob loses other fields (proves per-field parse).
- [ ] **Step 2: Run fail → implement** the prefs fields (per-field parser like `parseZoom`).
- [ ] **Step 3: Neutral backdrop + compact empty state** — the canvas container gets a neutral token bg (not white); `PropertyPanel`'s empty state becomes a small centered card, not a 300px void. DOM test: the empty inspector renders the compact state; the canvas container carries the neutral bg class.
- [ ] **Step 4: Resizable borders** — a lightweight pointer-drag handle (reuse the pointer patterns already in the studio; no new dep) between rail-panel↔canvas and canvas↔inspector, clamped to sane min/max, writing the width to prefs. Pure `clampPanelWidth(px, min, max)` unit-tested; the drag wiring covered by a U0-harness pointer test. Mutation: drop the clamp → a width test reddens.
- [ ] **Step 5: Run + Playwright** at 1440. Commit. `git commit -m "feat(studio): corps trois zones — fond neutre, états vides compacts, bordures redimensionnables (chantier A T3)"`

---

## Task 4: Responsive — `editorLayoutMode` + drawers

**Files:**
- Create: `lib/studio/layout-mode.ts` (pure)
- Modify: `components/studio/editor-shell.tsx` (consume the mode → render inspector/panels as `Sheet` drawers)
- Create: `hooks/use-editor-layout.ts` (width → mode, on resize; reuse `use-mobile`'s matchMedia pattern)
- Test: `tests/studio-layout-mode.test.ts`, `tests/studio-editor-shell.test.ts`

**Interfaces:**
- Consumes: `Sheet` (`components/ui/sheet.tsx`).
- Produces: `editorLayoutMode(width: number): "full" | "inspector-drawer" | "all-drawers" | "too-small"` with EXACT breakpoints — `>=1280 full`; `1024..1279 inspector-drawer`; `768..1023 all-drawers`; `<768 too-small`.

- [ ] **Step 1: Failing pure test** — assert the mode at each boundary EXACTLY: 1280→full, 1279→inspector-drawer, 1024→inspector-drawer, 1023→all-drawers, 768→all-drawers, 767→too-small. Anti-vacuity: all four modes are reachable. (A choice function — sweep the boundaries.)
- [ ] **Step 2: Run fail → implement** `editorLayoutMode` (pure, exact thresholds).
- [ ] **Step 3: Wire the shell** — `use-editor-layout` computes the mode; `EditorShell` renders: full = three columns; inspector-drawer = inspector in a right `Sheet` opened on selection; all-drawers = rail + panel + inspector as Sheets, canvas full-bleed with a minimum width; too-small = the read-only "Écran trop petit — aperçu seulement" state (reuse render-mode preview).
- [ ] **Step 4: DOM test (U0 harness)** — at a simulated 1100px the inspector is a drawer (not an inline column) and the canvas is not crushed; at 700px the too-small state renders; at 1400px the full three-zone renders. Assert the composition (U1 lesson: present≠visible), the 1024px overlap from the audit is gone.
- [ ] **Step 5: Playwright** at 1440/1280/1024/768 — screenshot each; confirm the toolbar/chip collision is gone at 1024 and the too-small state at 768.
- [ ] **Step 6: Commit.** `git commit -m "feat(studio): éditeur responsive — editorLayoutMode + tiroirs sous 1024, état trop-petit (chantier A T4)"`

---

## Task 5: Visual template gallery

**Files:**
- Create: server action `renderTemplateThumbnail(templateId)` (cached render) — near `lib/studio/preview-core.ts`/`render.ts`
- Modify: `components/studio/templates-table.tsx` → add a card-grid view + a grid⇄table toggle (persist choice)
- Create: `components/studio/templates-gallery.tsx` (the card grid; lazy thumbnails via IntersectionObserver, like `render-mode.tsx`'s filmstrip)
- Test: `tests/studio-templates-gallery.test.ts`, the thumbnail action's test

**Interfaces:**
- Consumes: the render pipeline (`renderScene`) + its cache (reuse `computeInputHash`/store); `FORMAT_PRESETS`.
- Produces: a card per template (thumbnail + name + format badge + status + actions), grouped by context; a grid⇄table toggle defaulting to grid.

- [ ] **Step 1: Failing test** — `renderTemplateThumbnail` returns a cached image for a template (second call hits cache — assert one render, two returns); the gallery renders one card per template with its name/format/status; the toggle switches grid⇄table and persists.
- [ ] **Step 2: Run fail → implement** the thumbnail action (cached, lazy) + the card grid + the toggle. Reuse the filmstrip's IntersectionObserver lazy-load so off-screen thumbnails don't render.
- [ ] **Step 3: Run + Playwright** the `/studio` gallery at 1440 + a narrow width (cards reflow). Commit. `git commit -m "feat(studio): galerie de gabarits en vignettes rendues + bascule grille/tableau (chantier A T5)"`

---

## Self-review

**Spec coverage:** §1 full-screen → Tasks 1+2; §2 three-zone body → Task 3; §3 responsive → Task 4; §4 gallery → Task 5; §5 craft (neutral backdrop, compact empty states) folded into Task 3. Routing spike/stop-and-report → Task 1. All spec sections mapped.

**Placeholder scan:** Task 1 is a genuine research spike (routing unproven in this Next fork), consistent with chantier D's opening spike. The zoom control in Task 2 is deliberately a placeholder SLOT (chantier B fills it) — named as such, not a hidden gap. All other steps carry concrete files/tests.

**Type consistency:** `editorLayoutMode` (T4) used verbatim by `use-editor-layout` + shell. `inspectorWidth`/`railPanelWidth` prefs (T3) match the existing `EditorPrefs` boolean/number idiom. `renderTemplateThumbnail` (T5) reuses `computeInputHash`/store from chantier D. `← Gabarits` → `/studio` consistent with the no-URL-change constraint.

**Ordering:** T1 (routing) gates T2 (top bar in the full-screen shell) and T3 (three-zone). T4 (responsive) needs the three-zone body. T5 (gallery) is independent of T1-T4 (it's the list page, admin shell) — could run in parallel but sequenced last. Each ends with an independently testable + screenshot-verifiable deliverable.

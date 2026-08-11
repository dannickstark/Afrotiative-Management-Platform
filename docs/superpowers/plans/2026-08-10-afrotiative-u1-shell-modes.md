# U1 — Studio shell, rail and modes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the studio's three-column shell with a labelled icon rail, a docked panel per category, a floating `Montage ⇄ Rendu réel` mode switch, and a properties rail whose geometry strip never scrolls away.

**Architecture:** Every decision is UI-only — no schema, no migration, no engine change. The pattern this repo already rewards is a **pure core plus a thin component**: preferences, token rows, text presets, shape tiles and mode state each get a pure module with its own tests, and the components stay dumb. Panels *host* the existing library surfaces rather than reimplementing them.

**Tech Stack:** Next.js 16 App Router · TypeScript · Bun · Base UI (shadcn preset `base-nova`) · existing `components/ui/collapsible.tsx`, `tabs.tsx`, `tooltip.tsx`

**Spec:** `docs/superpowers/specs/2026-08-10-afrotiative-u1-shell-modes-design.md` — read the section named in each task before implementing it.
**Programme:** `docs/superpowers/specs/2026-08-10-afrotiative-studio-ux-roadmap.md`.

## Global Constraints

- **Read the Next.js docs** under `node_modules/next/dist/docs/01-app/` before writing or changing a Server Action or a page — `AGENTS.md` requires it; this version has breaking changes vs. training data.
- **Every export of a `"use server"` module is an unauthenticated Server Action** (`lib/actions/taxonomy-actions.ts:5-11`). Guard first; raw writers stay in plain modules. U1 should need no new Server Action.
- **`lib/diffusion/settings-core.ts` and anything importing `@/db` must never be value-imported by a `"use client"` component** — `db/index.ts` builds a `pg` Pool at module scope. This repo has shipped that bug three times. Data a client panel needs arrives as a **prop from a Server Component**. Neither `bun test` nor `tsc --noEmit` catches a violation; only a real `bun run build` does.
  - **Carve-out — *except through a file-level `"use server"` module* (added by the U0+U2 final review; full statement and evidence in `docs/superpowers/plans/2026-08-11-afrotiative-u2-surface-precision.md`).** The compiler cuts the graph at a `"use server"` boundary and leaves a `createServerReference` proxy on the client side, so nothing that module imports is followed into the client bundle. `components/studio/editor-shell.tsx:30` (`@/lib/actions/studio-actions`, a `"use server"` module that does reach `@/db`) is a true-but-harmless path — verified in a fresh browser bundle: 0 real `@/db` paths, 0 hits for `DATABASE_URL` / `pg-pool` / `drizzle` / `new Pool`. A static transitive-import scan that does not stop at `"use server"` will flag it and be wrong. The prohibition still stands, with no exception, for a **plain** module (no `"use server"` header) that reaches `@/db`.
- **The human-review barrier is untouchable.** `tests/publish-due.test.ts` and `tests/wp-publish.test.ts` must stay green **and unmodified**.
- All user-facing strings in **French**; **Base UI** (`render` prop, never `asChild`).
- **No real network calls in tests.**
- **Never run two `bun test` invocations concurrently** (`test-setup.ts:38-40`).
- **A full-suite count is not reproducible on this repo.** Suites share the dev Neon branch and interfere by order. A failure in a full run is **not** evidence of regression until the file is re-run alone — report both results. Also: **any fixture with a future deadline must be cleaned up in an `afterAll` that runs even on failure**, or it becomes due later and breaks unrelated suites (see the roadmap's «&nbsp;Hygiène des tests&nbsp;»).
- **Three suite failures are pre-existing**: `tests/pipeline-web-search.test.ts` (a) and (d), `tests/pipeline-pause-resume.test.ts` pause checkpoint (b). Never attribute them to your work; never fix them.
- Commit messages in **French**, prefix `feat(studio):` (or `fix(studio):`), ending with:
  `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`

## File Structure

| File | Responsibility |
|---|---|
| `lib/studio/editor-prefs.ts` (create) | Pure parse/serialize of per-user editor preferences (open panel, collapsed, rulers, grid, safe areas, zoom, section open-state). No `window` access. |
| `hooks/use-editor-prefs.ts` (create) | Thin `localStorage` hook wrapping the pure module. |
| `lib/studio/text-presets.ts` (create) | `TEXT_PRESETS` — Titre / Sous-titre / Corps with font size and weight. |
| `lib/studio/dynamic-text.ts` (create) | `dynamicTextRowsFor(context)` and `buildDynamicTextLayer(...)` — which token rows exist, which are available, and the layer a click inserts. |
| `lib/studio/shape-gallery.ts` (create) | `SHAPE_TILES` — the tiles the `Éléments` panel offers. U3 extends this list. |
| `lib/studio/studio-mode.ts` (create) | `StudioMode`, and the pure part of mode switching (what state survives a round trip). |
| `components/studio/rail.tsx` (create) | The icon rail: six labelled categories, selected pill. |
| `components/studio/panel-host.tsx` (create) | Docked panel frame: search slot, primary action slot, sections, edge chevron. |
| `components/studio/panels/*.tsx` (create) | One file per category — `modeles`, `elements`, `texte`, `images`, `marque`, `calques`. Each hosts existing surfaces. |
| `components/studio/mode-switch.tsx` (create) | Floating segmented control + `R` binding. |
| `components/studio/render-mode.tsx` (create) | Large render, format filmstrip, provenance, stale badge, degraded flag. |
| `components/studio/canvas-chrome.tsx` (create) | Floating format/zoom chips, rulers, grid. |
| `components/studio/save-indicator.tsx` (create) | Three states, retry action. |
| `components/studio/editor-shell.tsx` (modify) | Becomes a composition root: rail + panel + canvas + properties. Sheds the grid and the stacked right column. |
| `components/studio/property-panel.tsx` (modify) | Pinned geometry strip extracted; type sections become collapsible. |

Tests: `tests/studio-editor-prefs.test.ts`, `tests/studio-dynamic-text.test.ts`, `tests/studio-shape-gallery.test.ts`, `tests/studio-mode.test.ts`, `tests/studio-rail.test.ts`, `tests/studio-render-mode.test.ts`, `tests/studio-save-indicator.test.ts`, plus edits to `tests/studio-property-panel.test.ts` and `tests/studio-layer-panel.test.ts`.

**Expect test churn.** 33 `tests/studio-*.test.ts` files exist and several were written against today's arrangement — `studio-canvas`, `studio-layer-panel`, `studio-property-panel`, `studio-token-picker`, `studio-templates-table`, `studio-asset-picker`, `studio-preview`. Updating a test because the structure legitimately changed is correct; **weakening an assertion to make it pass is not**. If a test's premise no longer holds, say so in the report rather than deleting the assertion.

---

### Task 1: Editor preferences (pure) + the rail with the Calques panel (spec §3)

**Files:** create `lib/studio/editor-prefs.ts`, `hooks/use-editor-prefs.ts`, `components/studio/rail.tsx`, `components/studio/panel-host.tsx`, `components/studio/panels/calques-panel.tsx`; modify `components/studio/editor-shell.tsx`; create `tests/studio-editor-prefs.test.ts`, `tests/studio-rail.test.ts`

**Interfaces:**
- Consumes: `LayerPanel` (`components/studio/layer-panel.tsx`) unchanged, with its existing props.
- Produces:

```ts
// lib/studio/editor-prefs.ts — PURE. No window, no localStorage, no React.
export type RailCategory = "modeles" | "elements" | "texte" | "images" | "marque" | "calques";
export const RAIL_CATEGORIES: readonly RailCategory[];
export const RAIL_LABELS: Record<RailCategory, string>; // French

export type EditorPrefs = {
  openPanel: RailCategory | null;   // null = collapsed
  rulers: boolean;                  // default false
  grid: boolean;                    // default false
  safeAreas: boolean;               // default true
  zoom: number | "fit";             // default "fit"
  sectionsOpen: Record<string, boolean>; // key: `${layerType}.${sectionId}`
};
export const DEFAULT_PREFS: EditorPrefs;
export function parsePrefs(raw: string | null): EditorPrefs;   // never throws; unknown/corrupt → DEFAULT_PREFS
export function serializePrefs(p: EditorPrefs): string;
```

Read spec §3. This task delivers a **working** rail: the layer panel stops being its own column and becomes the `Calques` panel. The other five categories render an empty panel body for now — that is not a placeholder, it is the sequencing: Tasks 2-4 fill them, and a category that opens an empty panel is honest, whereas a disabled rail button is not.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/studio-editor-prefs.test.ts
import { describe, expect, it } from "bun:test";
import { parsePrefs, serializePrefs, DEFAULT_PREFS, RAIL_CATEGORIES, RAIL_LABELS } from "@/lib/studio/editor-prefs";

describe("editor prefs — pure, never throws", () => {
  it("returns defaults for null, empty, corrupt JSON and wrong-shaped JSON", () => {
    for (const raw of [null, "", "{", "[]", '{"openPanel":42}', '{"zoom":"enormous"}']) {
      expect(parsePrefs(raw)).toEqual(DEFAULT_PREFS);
    }
  });

  it("round-trips a full prefs object", () => {
    const p = { openPanel: "texte" as const, rulers: true, grid: true, safeAreas: false, zoom: 0.5, sectionsOpen: { "text.ombre": false } };
    expect(parsePrefs(serializePrefs(p))).toEqual(p);
  });

  it("defaults: no panel forced open, rulers and grid OFF, safe areas ON, zoom fit", () => {
    expect(DEFAULT_PREFS.rulers).toBe(false);
    expect(DEFAULT_PREFS.grid).toBe(false);
    expect(DEFAULT_PREFS.safeAreas).toBe(true);
    expect(DEFAULT_PREFS.zoom).toBe("fit");
  });

  it("keeps an unknown sectionsOpen key rather than dropping it", () => {
    // a section id added by a later task must survive a round trip through an older client
    const p = { ...DEFAULT_PREFS, sectionsOpen: { "shape.forme": false } };
    expect(parsePrefs(serializePrefs(p)).sectionsOpen["shape.forme"]).toBe(false);
  });

  it("every rail category has a French label", () => {
    for (const c of RAIL_CATEGORIES) {
      expect(RAIL_LABELS[c]).toBeTruthy();
      expect(RAIL_LABELS[c]).not.toMatch(/^[a-z_]+$/); // not the raw key
    }
  });
});
```

```ts
// tests/studio-rail.test.ts — the rail's behaviour, not its pixels
import { describe, expect, it } from "bun:test";
import { nextOpenPanel } from "@/lib/studio/editor-prefs";

describe("rail selection semantics", () => {
  it("clicking a closed category opens it", () => {
    expect(nextOpenPanel(null, "texte")).toBe("texte");
  });
  it("clicking a different category switches without collapsing", () => {
    expect(nextOpenPanel("calques", "texte")).toBe("texte");
  });
  it("clicking the OPEN category collapses the panel", () => {
    expect(nextOpenPanel("texte", "texte")).toBe(null);
  });
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `bun test tests/studio-editor-prefs.test.ts tests/studio-rail.test.ts`
Expected: FAIL — `@/lib/studio/editor-prefs` does not exist.

- [ ] **Step 3: Implement**

Write `editor-prefs.ts` including `nextOpenPanel(current, clicked)` exactly as the tests describe. `parsePrefs` validates each field independently and falls back per-field, so one bad field doesn't discard the rest — except that a non-object or unparseable input returns `DEFAULT_PREFS` whole.

`hooks/use-editor-prefs.ts` reads once on mount and writes on change, keyed `studio.editor-prefs`. Guard `typeof window === "undefined"`.

`rail.tsx` renders `RAIL_CATEGORIES` as labelled buttons, selected state a filled pill, each with `aria-pressed`. `panel-host.tsx` provides the frame: optional search slot, optional primary-action slot, a children area, and the edge chevron whose click calls `nextOpenPanel(open, open)`.

`editor-shell.tsx` replaces `grid-cols-[220px_1fr_300px]` with rail + panel + canvas + properties. **Do not move the preview yet** — Task 5 owns it; leave it where it is so this task stays independently shippable.

- [ ] **Step 4: Run and confirm passing, then check the client boundary**

Run: `bun test tests/studio-editor-prefs.test.ts tests/studio-rail.test.ts tests/studio-layer-panel.test.ts`
Then: `bun run build` — and grep the studio page's client-reference-manifest for `pg`, `@/db` and `settings-core`. A hit means a panel value-imported a server module; fix it by passing a prop instead.

- [ ] **Step 5: Commit**

```bash
git add lib/studio/editor-prefs.ts hooks/use-editor-prefs.ts components/studio/rail.tsx components/studio/panel-host.tsx components/studio/panels/ components/studio/editor-shell.tsx tests/studio-editor-prefs.test.ts tests/studio-rail.test.ts
git commit   # feat(studio): rail d'icônes libellées + panneau accosté, les calques y déménagent
```

---

### Task 2: Modèles, Images and Marque panels (spec §3)

**Files:** create `components/studio/panels/modeles-panel.tsx`, `images-panel.tsx`, `marque-panel.tsx`; modify `app/(app)/studio/[id]/page.tsx`; modify `tests/studio-templates-table.test.ts`, `tests/studio-asset-picker.test.ts`

**Interfaces:**
- Consumes: `RailCategory`, `PanelHost` (Task 1); `TemplatesTable` (`components/studio/templates-table.tsx`), `AssetLibrary` / `AssetPicker` (`asset-library.tsx`, `asset-picker.tsx`), the font list surfaces.
- Produces: nothing new — these panels are hosts.

Read spec §3, including the reuse rule. **These three panels must host the existing components, not reimplement them.** A duplicated asset grid is a review finding.

The data these panels need (templates list, assets, fonts) is fetched in the **Server Component** `app/(app)/studio/[id]/page.tsx` and passed down as props. That is not a style preference — see the Global Constraints note about `pg` in the client bundle.

- [ ] **Step 1: Write the failing tests**

```ts
// added to tests/studio-templates-table.test.ts
it("the Modèles panel renders the existing templates table, not a copy", async () => {
  // assert the panel's rendered output contains the table's own testid,
  // which only components/studio/templates-table.tsx sets
  const html = renderModelesPanel({ templates: [fixtureTemplate()] });
  expect(html).toContain('data-testid="templates-table"');
});

it("the Modèles panel offers « Nouveau gabarit vierge » as its primary action", async () => {
  const html = renderModelesPanel({ templates: [] });
  expect(html).toContain("Nouveau gabarit vierge");
});
```

```ts
// added to tests/studio-asset-picker.test.ts
it("the Images panel hosts the asset picker and lists the context's image slots", async () => {
  const html = renderImagesPanel({ context: "article_image", assets: [fixtureAsset()] });
  expect(html).toContain('data-testid="asset-picker"');
  expect(html).toContain("article.image");
});
```

- [ ] **Step 2: Run and confirm failure.** Run: `bun test tests/studio-templates-table.test.ts tests/studio-asset-picker.test.ts` — FAIL, the panel modules don't exist.

- [ ] **Step 3: Implement** the three panels as thin hosts. `Marque` is read-only: uploaded fonts, brand logo, category colours — it links to the existing asset and font management pages rather than duplicating their write paths.

- [ ] **Step 4: Run and confirm passing.** Run: `bun test tests/studio-templates-table.test.ts tests/studio-asset-picker.test.ts tests/studio-asset-loader.test.ts`

- [ ] **Step 5: Commit**

```bash
git add components/studio/panels/ "app/(app)/studio/[id]/page.tsx" tests/
git commit   # feat(studio): panneaux Modèles, Images et Marque — ils accueillent les surfaces existantes
```

---

### Task 3: The Texte panel and « Texte dynamique » (spec §4)

**Files:** create `lib/studio/text-presets.ts`, `lib/studio/dynamic-text.ts`, `components/studio/panels/texte-panel.tsx`; create `tests/studio-dynamic-text.test.ts`

**Interfaces:**
- Consumes: `CONTEXT_TOKENS` and `TOKEN_KINDS` (`lib/studio/tokens.ts`), `TemplateContext`, the editor reducer's existing add-text action (`lib/studio/editor-state.ts`), `FORMAT_PRESETS` (`lib/studio/formats.ts`).
- Produces:

```ts
// lib/studio/text-presets.ts
export type TextPresetId = "titre" | "sous_titre" | "corps";
export const TEXT_PRESETS: Record<TextPresetId, { label: string; size: number; weight: number }>;

// lib/studio/dynamic-text.ts — PURE
export type DynamicTextRow = {
  tokenId: string;          // e.g. "title"
  label: string;            // French, e.g. "Titre de l'article"
  preset: TextPresetId;
  available: boolean;       // false when the token is illegal in this context
  reason?: string;          // French, present iff !available
};
export function dynamicTextRowsFor(context: TemplateContext): DynamicTextRow[];
export function buildDynamicTextLayer(
  row: DynamicTextRow,
  canvas: { width: number; height: number },
): TextLayer;   // a normal TextLayer with `text` set to `{{tokenId}}`
```

Read spec §4. This is the section that makes bindings discoverable, and the part of U1 most specific to this product.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/studio-dynamic-text.test.ts
import { describe, expect, it } from "bun:test";
import { dynamicTextRowsFor, buildDynamicTextLayer } from "@/lib/studio/dynamic-text";
import { CONTEXT_TOKENS, TEMPLATE_CONTEXTS } from "@/lib/studio/tokens";
import { parseScene } from "@/lib/studio/scene";

describe("dynamic text rows", () => {
  it("marks a token legal in this context available, with no reason", () => {
    const rows = dynamicTextRowsFor("article_image");
    const title = rows.find((r) => r.tokenId === "title")!;
    expect(title.available).toBe(true);
    expect(title.reason).toBeUndefined();
  });

  it("marks a token illegal in this context unavailable, with a French reason", () => {
    // article.url is a social_post token — assert against CONTEXT_TOKENS rather than hardcoding
    const ctx = TEMPLATE_CONTEXTS.find((c) => !CONTEXT_TOKENS[c].includes("article.url"))!;
    const row = dynamicTextRowsFor(ctx).find((r) => r.tokenId === "article.url");
    if (row) {
      expect(row.available).toBe(false);
      expect(row.reason).toBeTruthy();
      expect(row.reason).not.toMatch(/^[a-z_.]+$/); // a sentence, not a key
    }
  });

  it("offers only text-kind tokens — image and colour tokens are not text rows", () => {
    const rows = dynamicTextRowsFor("article_image");
    expect(rows.some((r) => r.tokenId === "article.image")).toBe(false);
    expect(rows.some((r) => r.tokenId === "category.color")).toBe(false);
  });

  it("every row in every context carries a French label distinct from its token id", () => {
    for (const ctx of TEMPLATE_CONTEXTS) {
      for (const r of dynamicTextRowsFor(ctx)) {
        expect(r.label).toBeTruthy();
        expect(r.label).not.toBe(r.tokenId);
      }
    }
  });
});

describe("the layer a click inserts", () => {
  it("is a normal text layer bound to the token, and parseScene accepts it", () => {
    const row = dynamicTextRowsFor("article_image").find((r) => r.tokenId === "title")!;
    const layer = buildDynamicTextLayer(row, { width: 1200, height: 630 });
    expect(layer.type).toBe("text");
    expect(layer.text).toBe("{{title}}");
    // it must survive the real schema, not just look right
    const scene = parseScene(JSON.stringify({ version: 1, canvas: { width: 1200, height: 630 }, layers: [layer] }));
    expect(scene.layers).toHaveLength(1);
  });

  it("lands inside the canvas, not off-board", () => {
    const row = dynamicTextRowsFor("article_image").find((r) => r.tokenId === "title")!;
    const l = buildDynamicTextLayer(row, { width: 1080, height: 1920 });
    expect(l.frame.x).toBeGreaterThanOrEqual(0);
    expect(l.frame.y).toBeGreaterThanOrEqual(0);
    expect(l.frame.x + l.frame.w).toBeLessThanOrEqual(1080);
    expect(l.frame.y + l.frame.h).toBeLessThanOrEqual(1920);
  });

  it("applies the preset's size and weight", () => {
    const row = dynamicTextRowsFor("article_image").find((r) => r.tokenId === "title")!;
    const l = buildDynamicTextLayer(row, { width: 1200, height: 630 });
    expect(l.font.size).toBeGreaterThan(buildDynamicTextLayer({ ...row, preset: "corps" }, { width: 1200, height: 630 }).font.size);
  });
});
```

**Amended 2026-08-11 — Task 3's implementer found four defects in the test code above; it does not compile as written.** Recorded so the next reader does not trust it verbatim: the token id is `article.title`, not `title`; the `TextLayer` content field is `content`, not `text`; the scene key is `schemaVersion`, not `version`; `parseScene` takes an object, not a `JSON.stringify` result. Worst of the four: the "illegal token" case picked a token whose kind is not `text`, so it would have **passed vacuously** — the very failure mode this plan warns implementers about. The shipped tests in `tests/studio-dynamic-text.test.ts` are the corrected, authoritative version.

- [ ] **Step 2: Run and confirm failure.** Run: `bun test tests/studio-dynamic-text.test.ts`

- [ ] **Step 3: Implement.** `dynamicTextRowsFor` filters `CONTEXT_TOKENS`-eligible tokens to those whose `TOKEN_KINDS` entry is `"text"`, and marks the rest of the text-kind token universe unavailable with a reason naming the context. The panel renders `TEXT_PRESETS` at their real size, the primary action « Ajouter une zone de texte », then the rows — an unavailable row is disabled and inserts nothing on click.

- [ ] **Step 4: Run and confirm passing.** Run: `bun test tests/studio-dynamic-text.test.ts tests/studio-tokens.test.ts tests/studio-scene.test.ts tests/studio-editor-state.test.ts`

- [ ] **Step 5: Commit**

```bash
git add lib/studio/text-presets.ts lib/studio/dynamic-text.ts components/studio/panels/texte-panel.tsx tests/studio-dynamic-text.test.ts
git commit   # feat(studio): panneau Texte — un clic insère un calque déjà lié au jeton
```

---

### Task 4: The Éléments panel (spec §3)

**Files:** create `lib/studio/shape-gallery.ts`, `components/studio/panels/elements-panel.tsx`; create `tests/studio-shape-gallery.test.ts`

**Interfaces:**
- Consumes: the shape and QR layer schemas (`lib/studio/scene.ts`), the reducer's add-layer actions.
- Produces:

```ts
// lib/studio/shape-gallery.ts
export type ShapeTile = { id: string; label: string; kind: "shape" | "qr"; shape?: "rect" };
export const SHAPE_TILES: readonly ShapeTile[];   // U3 extends this
export function buildShapeLayer(tile: ShapeTile, canvas: { width: number; height: number }): Layer;
```

Read spec §3. **The gallery offers only what the schema supports today** — `rect` and the QR layer. No disabled tiles for ellipse, line or polygons; U3 adds them by appending to `SHAPE_TILES`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/studio-shape-gallery.test.ts
import { describe, expect, it } from "bun:test";
import { SHAPE_TILES, buildShapeLayer } from "@/lib/studio/shape-gallery";
import { parseScene } from "@/lib/studio/scene";

describe("shape gallery", () => {
  // This is the guard that makes U3 impossible to half-ship: adding a shape to the schema
  // without a tile leaves a designer with no way to insert it.
  it("offers a tile for every shape the schema accepts", () => {
    // AMENDED 2026-08-11 — as originally written this line was a hand-copied mirror of the schema,
    // so the guard caught tile/mirror drift but NOT the dangerous case: extending scene.ts's real
    // schema while the gallery falls behind. Both sides stayed ["rect"] and the test passed.
    // The shipped fix exports SHAPE_KINDS from scene.ts, builds the schema from it
    // (shape: z.enum(SHAPE_KINDS)), and iterates that same constant here — one source, two consumers.
    const schemaShapes = SHAPE_KINDS; // imported from @/lib/studio/scene
    const tileShapes = SHAPE_TILES.filter((t) => t.kind === "shape").map((t) => t.shape);
    expect([...tileShapes].sort()).toEqual([...schemaShapes].sort());
  });

  it("offers no tile for a shape the schema rejects", () => {
    for (const tile of SHAPE_TILES) {
      const layer = buildShapeLayer(tile, { width: 1200, height: 630 });
      const scene = parseScene(JSON.stringify({ version: 1, canvas: { width: 1200, height: 630 }, layers: [layer] }));
      expect(scene.layers).toHaveLength(1);
    }
  });

  it("every tile has a French label", () => {
    for (const t of SHAPE_TILES) expect(t.label).not.toBe(t.id);
  });

  it("an inserted shape lands inside the canvas", () => {
    for (const t of SHAPE_TILES) {
      const l = buildShapeLayer(t, { width: 1080, height: 1080 });
      expect(l.frame.x).toBeGreaterThanOrEqual(0);
      expect(l.frame.x + l.frame.w).toBeLessThanOrEqual(1080);
    }
  });
});
```

- [ ] **Step 2: Run and confirm failure.** Run: `bun test tests/studio-shape-gallery.test.ts`

- [ ] **Step 3: Implement.** The panel shows « Utilisés récemment » (from prefs, most-recent-first, capped at six) then « Formes ». Clicking a tile dispatches an add-layer action with `buildShapeLayer`'s result and selects it.

- [ ] **Step 4: Run and confirm passing.** Run: `bun test tests/studio-shape-gallery.test.ts tests/studio-scene.test.ts`

- [ ] **Step 5: Commit**

```bash
git add lib/studio/shape-gallery.ts components/studio/panels/elements-panel.tsx tests/studio-shape-gallery.test.ts
git commit   # feat(studio): panneau Éléments — galerie de formes, limitée à ce que le schéma accepte
```

---

### Task 5: Modes and render mode (spec §5)

**Files:** create `lib/studio/studio-mode.ts`, `components/studio/mode-switch.tsx`, `components/studio/render-mode.tsx`; modify `components/studio/editor-shell.tsx`; create `tests/studio-mode.test.ts`, `tests/studio-render-mode.test.ts`

**Interfaces:**
- Consumes: `PreviewPane` (`components/studio/preview-pane.tsx`, props `{ templateId, context, scene, articles?, disabled? }`), `FORMAT_PRESETS` / `FORMAT_KEYS` (`lib/studio/formats.ts`), `EditorPrefs` (Task 1).
- Produces:

```ts
// lib/studio/studio-mode.ts — PURE
export type StudioMode = "montage" | "rendu";
export type PreservedView = { selectedId: string | null; zoom: number | "fit"; scrollX: number; scrollY: number };
export function toggleMode(m: StudioMode): StudioMode;
export function preserveView(v: PreservedView): PreservedView;   // identity by contract — the test below is what makes it load-bearing
```

Read spec §5. Note the honest limitation it states: until U5, seven filmstrip renders show a design built for another aspect ratio, and **the UI must not offer an "adapt" affordance that doesn't exist**.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/studio-mode.test.ts
import { describe, expect, it } from "bun:test";
import { toggleMode, preserveView } from "@/lib/studio/studio-mode";

describe("mode switching", () => {
  it("toggles both ways", () => {
    expect(toggleMode("montage")).toBe("rendu");
    expect(toggleMode("rendu")).toBe("montage");
  });

  it("preserves selection, zoom and scroll across a round trip", () => {
    const v = { selectedId: "abc", zoom: 0.75 as number, scrollX: 120, scrollY: 40 };
    expect(preserveView(preserveView(v))).toEqual(v);
  });
});
```

```ts
// tests/studio-render-mode.test.ts
describe("render mode", () => {
  it("renders no editing chrome — no rail, no properties, no layer list", () => {
    const html = renderRenderMode(fixtureProps());
    expect(html).not.toContain('data-testid="studio-rail"');
    expect(html).not.toContain('data-testid="property-panel"');
    expect(html).not.toContain('data-testid="layer-panel"');
  });

  it("shows the current format large and the other seven as a filmstrip", () => {
    const html = renderRenderMode({ ...fixtureProps(), format: "ig_portrait" });
    expect(countFilmstripThumbs(html)).toBe(7);
    expect(largeSlotFormat(html)).toBe("ig_portrait");
  });

  it("states where the values came from", () => {
    expect(renderRenderMode(fixtureProps())).toMatch(/valeurs d'exemple|article/i);
  });

  it("surfaces a stale render and offers to re-render", () => {
    const html = renderRenderMode({ ...fixtureProps(), stale: true });
    expect(html).toMatch(/rendre/i);
  });

  it("surfaces the engine's degraded flag when a font fell back", () => {
    const html = renderRenderMode({ ...fixtureProps(), degraded: true });
    expect(html).toMatch(/police/i);   // French, mentions the font fallback
  });

  it("offers no re-layout affordance — U5 does not exist yet", () => {
    const html = renderRenderMode(fixtureProps());
    expect(html).not.toMatch(/adapter|ré-?agencer/i);
  });
});
```

- [ ] **Step 2: Run and confirm failure.** Run: `bun test tests/studio-mode.test.ts tests/studio-render-mode.test.ts`

- [ ] **Step 3: Implement.** `mode-switch.tsx` is the floating segmented control, bound to `R` via a document-level listener that ignores the event when focus is in an input or textarea — otherwise typing "r" in a text layer's content field would switch modes. `render-mode.tsx` composes `PreviewPane` for the large slot and small render requests for the filmstrip.

- [ ] **Step 4: Run and confirm passing.** Run: `bun test tests/studio-mode.test.ts tests/studio-render-mode.test.ts tests/studio-preview.test.ts`

- [ ] **Step 5: Commit**

```bash
git add lib/studio/studio-mode.ts components/studio/mode-switch.tsx components/studio/render-mode.tsx components/studio/editor-shell.tsx tests/studio-mode.test.ts tests/studio-render-mode.test.ts
git commit   # feat(studio): Montage ⇄ Rendu réel — l'aperçu devient un mode, avec sa bande de formats
```

---

### Task 6: The properties rail — pinned strip and collapsible sections (spec §6)

**Files:** modify `components/studio/property-panel.tsx`; create `components/studio/geometry-strip.tsx`; modify `tests/studio-property-panel.test.ts`

**Interfaces:**
- Consumes: the existing `NumberField` primitive and the `patch` callback inside `property-panel.tsx`; `EditorPrefs.sectionsOpen` (Task 1).
- Produces: `GeometryStrip` — X, Y, width, height, rotation, opacity in a compact grid, designed with room for U2's align/distribute row and U5's anchor widget.

Read spec §6. Today `<Section title="Cadre">` is at `property-panel.tsx:646`, **after** Texte / Police / Apparence / Ombre / Contour. That is the defect this task fixes.

- [ ] **Step 1: Write the failing tests**

```ts
// added to tests/studio-property-panel.test.ts
it("geometry is the FIRST thing in the rail, not the last section", () => {
  const html = renderPropertyPanel(textLayerFixture());
  expect(html.indexOf('data-testid="geometry-strip"')).toBeLessThan(html.indexOf("Police"));
});

it("the geometry strip carries all six frame controls", () => {
  const html = renderPropertyPanel(textLayerFixture());
  for (const f of ["frame.x", "frame.y", "frame.w", "frame.h", "rotation", "opacity"]) {
    expect(html).toContain(`data-field="${f}"`);
  }
});

it("type sections are collapsible and their state is keyed by layer type", () => {
  const prefs = { ...DEFAULT_PREFS, sectionsOpen: { "text.ombre": false } };
  const html = renderPropertyPanel(textLayerFixture(), prefs);
  expect(sectionIsOpen(html, "ombre")).toBe(false);
  // a shape layer's section of the same name is unaffected
  const shapeHtml = renderPropertyPanel(shapeLayerFixture(), prefs);
  expect(sectionIsOpen(shapeHtml, "bordure")).toBe(true);
});

it("collapsing a section does not discard the values inside it", () => {
  const before = textLayerFixture();
  const after = collapseSection(before, "ombre");
  expect(after.shadow).toEqual(before.shadow);
});
```

- [ ] **Step 2: Run and confirm failure.** Run: `bun test tests/studio-property-panel.test.ts`

- [ ] **Step 3: Implement.** Extract the `Cadre` section's six fields into `geometry-strip.tsx`, rendered above the type sections and outside the scroll container. Wrap each remaining `<Section>` in the existing `components/ui/collapsible.tsx`, keyed `${layerType}.${sectionId}`. Keep the existing field primitives — this is a re-arrangement, not a rewrite of the controls.

- [ ] **Step 4: Run and confirm passing.** Run: `bun test tests/studio-property-panel.test.ts tests/studio-editor-state.test.ts`

- [ ] **Step 5: Commit**

```bash
git add components/studio/property-panel.tsx components/studio/geometry-strip.tsx tests/studio-property-panel.test.ts
git commit   # feat(studio): la géométrie s'épingle en haut du rail, les sections deviennent repliables
```

---

### Task 7: Canvas chrome and the save indicator (spec §7, §8)

**Files:** create `components/studio/canvas-chrome.tsx`, `components/studio/save-indicator.tsx`; modify `components/studio/editor-shell.tsx`, `components/studio/canvas.tsx`; create `tests/studio-save-indicator.test.ts`; modify `tests/studio-canvas.test.ts`

**Interfaces:**
- Consumes: `EditorPrefs` (Task 1), `FORMAT_PRESETS`, `SaveStatus` from `lib/studio/autosave.ts` (`"idle" | "saving" | "saved" | "error"` — the type already has `error`; what's missing is the UI).
- Produces: `CanvasChrome` (format and zoom chips, optional rulers and grid) and `SaveIndicator` with a retry callback.

Read spec §7 and §8. U1 ships the **surround**; U2 ships snapping, guides and the safe-area bands. The safe-area *toggle* and its persistence live here so U2 only supplies the bands.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/studio-save-indicator.test.ts
import { describe, expect, it } from "bun:test";
import { saveIndicatorLabel, saveIndicatorOffersRetry } from "@/components/studio/save-indicator";

describe("save indicator", () => {
  it("has a distinct French label for each status", () => {
    const labels = (["idle", "saving", "saved", "error"] as const).map(saveIndicatorLabel);
    expect(new Set(labels).size).toBe(4);
    expect(saveIndicatorLabel("saving")).toMatch(/Enregistrement/);
    expect(saveIndicatorLabel("saved")).toMatch(/Enregistré/);
    expect(saveIndicatorLabel("error")).toMatch(/Échec/);
  });

  it("offers retry ONLY on error — this is the affordance that does not exist today", () => {
    expect(saveIndicatorOffersRetry("error")).toBe(true);
    for (const s of ["idle", "saving", "saved"] as const) {
      expect(saveIndicatorOffersRetry(s)).toBe(false);
    }
  });

  it("retry re-attempts the same scene without requiring an edit first", async () => {
    const attempts: number[] = [];
    const ctl = fixtureAutosave({ onSave: () => { attempts.push(1); return { ok: false, message: "réseau" }; } });
    await ctl.flush();
    expect(attempts).toHaveLength(1);
    await ctl.retry();            // no scene mutation in between
    expect(attempts).toHaveLength(2);
  });
});
```

```ts
// added to tests/studio-canvas.test.ts
it("chips state the format name, its pixel size, and the zoom", () => {
  const html = renderCanvasChrome({ format: "ig_portrait", zoom: 0.72, prefs: DEFAULT_PREFS });
  expect(html).toContain("1080");
  expect(html).toContain("1350");
  expect(html).toMatch(/72\s?%/);
});

it("rulers and grid are OFF by default and render when enabled", () => {
  expect(renderCanvasChrome({ prefs: DEFAULT_PREFS })).not.toContain('data-testid="rulers"');
  expect(renderCanvasChrome({ prefs: { ...DEFAULT_PREFS, rulers: true } })).toContain('data-testid="rulers"');
});

it("safe areas default ON for story and portrait, OFF for link formats", () => {
  expect(safeAreaDefaultFor("story")).toBe(true);
  expect(safeAreaDefaultFor("ig_portrait")).toBe(true);
  expect(safeAreaDefaultFor("fb_link")).toBe(false);
  expect(safeAreaDefaultFor("li_link")).toBe(false);
});
```

- [ ] **Step 2: Run and confirm failure.** Run: `bun test tests/studio-save-indicator.test.ts tests/studio-canvas.test.ts`

- [ ] **Step 3: Implement.** `saveIndicatorLabel` and `saveIndicatorOffersRetry` are pure exports so the test above needs no DOM. Wire the retry to the autosave controller's existing save path — the retry must not require a scene mutation to trigger, which is exactly the gap in the deferred-defect list.

- [ ] **Step 4: Run and confirm passing, then the full suite once.** Run the focused files, then `bun test`. For anything that fails, **re-run that file alone** before concluding it is yours, and report both results.

- [ ] **Step 5: Commit**

```bash
git add components/studio/canvas-chrome.tsx components/studio/save-indicator.tsx components/studio/editor-shell.tsx components/studio/canvas.tsx tests/
git commit   # feat(studio): pastilles de format et de zoom, règles et grille optionnelles, réessai d'enregistrement
```

---

## Self-Review

**Spec coverage.** §1 why-first → the plan's task order. §2 what-replaces-what → Task 1. §3 rail and panels → Tasks 1, 2, 4. §4 « Texte dynamique » → Task 3. §5 modes → Task 5. §6 properties rail → Task 6. §7 canvas chrome → Task 7. §8 save state → Task 7. §9 testing → each task's tests, with the panel-hosting assertion in Task 2 and the shape-completeness guard in Task 4. §10 risks → carried into the Global Constraints (client boundary, test churn) and Task 5 (`R` binding conflicts with typing, handled by ignoring the event when focus is in a field).

**One spec item deliberately not given its own task:** §10.3's `⌘/` collision check. It is a five-minute verification inside Task 1 rather than a task, and Task 1's implementer is told to confirm it — if `⌘/` is taken on macOS Chrome, fall back to `⌘.` and say so in the report.

**Placeholders:** none. Where a test helper is named rather than written (`renderModelesPanel`, `fixtureAutosave`, `sectionIsOpen`), the assertion it must make is fully specified and the helper is local test scaffolding whose shape depends on how the implementer renders — inventing its internals here would be guessing at their choice.

**Type consistency:** `RailCategory` is the same union in Tasks 1-4. `EditorPrefs.sectionsOpen`'s `${layerType}.${sectionId}` key format is used identically in Tasks 1 and 6. `StudioMode` and `PreservedView` appear only in Task 5. `SHAPE_TILES` is the extension point Task 4 creates and U3 appends to. `SaveStatus` is imported from `lib/studio/autosave.ts` rather than redeclared.

**Known risk this plan carries:** Task 1 restructures `editor-shell.tsx` while Tasks 2-5 all add panels to it, so every task after the first touches that file. That is sequential by nature — do not attempt these in parallel.

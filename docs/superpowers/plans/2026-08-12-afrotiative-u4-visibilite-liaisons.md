# U4 — Visibilité des liaisons — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make token bindings visible and correct in the studio editor — bound colours paint truthfully, the colour-field list is schema-derived, `parseScene` reports every error, the token picker offers only legal tokens (illegal shown disabled with a reason), and a toggle reveals bound layers on the canvas.

**Architecture:** Six tasks in dependency order. A stop-and-report spike (Task 1) settles whether Zod v4 introspection can drive a single derived colour-field list; Task 2 builds that list and a structural guard; Task 3 uses it to resolve bound colours to sample values in the browser paint path (with a both-paths-agree guard); Tasks 4–6 are largely independent (parseScene, picker, canvas overlay).

**Tech Stack:** Next.js (breaking-change fork — read `node_modules/next/dist/docs/` before touching routes/components), Bun test, Zod v4, Satori (export render, unchanged), Base UI (`@base-ui/react`), the U0 DOM harness (`tests/dom-harness.ts`).

## Global Constraints

- **Engine unchanged.** No Satori/`element.ts` behaviour change; the editor converges to what the export already produces. Verbatim spec rule.
- **§0 — the two paint paths must AGREE.** `components/studio/layer-view.tsx` (browser) and `lib/studio/element.ts` (export) must resolve a given colour field to the same value. Every colour change carries a test asserting this.
- **Structural over hand-maintained.** A guarded/derived source (à la `SHAPE_KINDS`), never a recopied mirror list. A drift must redden a test, not rely on a comment.
- **Mutation is the only judge.** Load-bearing tests must go red under mutation. `expect()`-count and `bun run build` prove nothing (dropped since U2).
- **Anti-vacuity.** Every negative assertion is paired with a positive witness. Beware naïve substrings: Base UI's disabled control renders `aria-disabled="true"` with NO native `disabled` attribute.
- **`lib/studio/*` stays client-safe and DB-free.** No `@/db` import reaches these modules; they must remain importable from a client component and runnable under `TEST_LANE=pure` (see `scripts/test-fast.ts`).
- **French user-facing copy**, matching existing studio strings.
- Run the fast inner loop with `bun run test:pure`; it is deterministic for all studio files touched here.

---

## Task 1: Spike — Zod v4 introspection of `hexColor` (STOP-AND-REPORT)

**Nothing in this repo has introspected a Zod schema tree. This task proves it is possible before Task 2 commits to it. Produce NO production behaviour change beyond (optionally) marking `hexColor`. If introspection cannot enumerate a layer's colour fields, STOP and report — the fallback (keep the two hand-lists + a schema-walking drift guard) is the human's call.**

**Files:**
- Modify (marker only, if needed): `lib/studio/scene.ts:15-18` (`hexColor`)
- Create (throwaway, committed as the spike record): `tests/studio-color-introspection-spike.test.ts`

**Interfaces:**
- Produces (for Task 2, ONLY if the spike succeeds): a proven technique to obtain, for any `Layer`, the list of colour-bearing field paths (e.g. `["color"]`, `["fill"]`, `["fill","stops",0,"color"]`, `["shadow","color"]`, `["border","color"]`, `["fg"]`, `["bg"]`, `["overlay"]`) and the scene-level `canvas.background`.

- [ ] **Step 1: Read the Zod v4 introspection surface.** Read `node_modules/zod/v4/` type defs (or `node_modules/zod/dist/`) for: `z.registry()`, `.meta()`, `.register()`, and how a `ZodString.refine(...)` node exposes its `.def`/`.meta`. Confirm what `hexColor` becomes after `.refine()` (a `ZodCustom`/`ZodEffects` wrapping a string) and whether a marker survives on it.

- [ ] **Step 2: Mark `hexColor`.** In `lib/studio/scene.ts`, attach an introspectable marker. Preferred (verify it chains after `.refine()`):

```ts
export const COLOR_REGISTRY = z.registry<{ color: true }>();
const hexColor = z.string().refine(
  (v) => /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(v) || v === "transparent" || TOKEN_RE.test(v),
  { message: "Couleur invalide (attendu #RGB, #RRGGBB, #RRGGBBAA, « transparent » ou un jeton)" },
).register(COLOR_REGISTRY, { color: true });
```

If `.register()`/`.meta()` does not survive the discriminated unions / arrays / optionals in the schema, fall back in Step 3 to **node-identity**: export the `hexColor` node itself and match by `=== hexColor` (or its inner string node) while walking.

- [ ] **Step 3: Write the spike test that walks a real layer.** Prove enumeration across every wrapper the schema uses — `z.object` (layers), `z.union`/`z.discriminatedUnion` (`shapeLayer.fill`, `imageSource`), `z.array` (`gradient.stops`), `z.optional` (`shadow`, `stroke`, `overlay`). Assert the enumerated paths for one of EACH layer type match the hand-known colour fields:

```ts
import { test, expect } from "bun:test";
import { colorFieldPaths } from "../lib/studio/scene"; // the spike's candidate walker
// a text layer with shadow+stroke -> ["color","shadow.color","stroke.color"]
// a shape layer with a gradient fill -> ["fill.stops.0.color","fill.stops.1.color","border.color","shadow.color"]
// a shape layer with a solid fill -> ["fill","border.color","shadow.color"]
// a qr layer -> ["fg","bg"]; an image layer -> ["overlay"]
```

- [ ] **Step 4: Run the spike.** `bun test tests/studio-color-introspection-spike.test.ts`. Record which approach worked (registry/meta vs node-identity), the exact walker code, and any wrapper it could NOT traverse.

- [ ] **Step 5: STOP and report.** Write a 10-line finding: does introspection enumerate all colour fields for all layer types? If YES, hand Task 2 the proven `colorFieldPaths` technique. If NO, report the gap and the recommended fallback, and WAIT for the human decision before Task 2.

- [ ] **Step 6: Commit.**

```bash
git add lib/studio/scene.ts tests/studio-color-introspection-spike.test.ts
git commit -m "spike(studio): l'introspection Zod de hexColor — ce que le schéma sait révéler (U4 Tâche 1)"
```

---

## Task 2: Derived colour-field list + structural guard

**Replace the two hand-maintained colour-field lists (`tokens.ts#usesInLayer` and `values.ts#resolveTokens`) with ONE derived walker, pinned by a tripwire so a new colour field can't drift.**

**Files:**
- Modify: `lib/studio/scene.ts` (export `colorFieldPaths` / walker from the spike, + `COLOR_REGISTRY` if used)
- Modify: `lib/studio/tokens.ts:85-140` (`usesInLayer`, `extractTokens`)
- Modify: `lib/studio/values.ts:32-93` (`resolveTokens`)
- Test: `tests/studio-tokens.test.ts`, `tests/studio-values.test.ts`, new `tests/studio-color-fields.test.ts`

**Interfaces:**
- Consumes: the spike's proven enumeration technique.
- Produces:
  - `colorFieldsOf(layer: Layer): Array<{ get: () => string; path: string }>` — enumerates a layer's colour STRINGS (each gradient stop is its own entry). Exact name to lock here.
  - `SCENE_COLOR_FIELDS` — the derived source of truth the tripwire checks.
  - `usesInLayer` and `resolveTokens` now iterate `colorFieldsOf` for the colour dimension (non-colour token uses — image slot, qr url slot, text content — stay as they are).

- [ ] **Step 1: Write the tripwire test (failing).** In `tests/studio-color-fields.test.ts`, assert the derived walker finds EXACTLY the known colour fields for each layer type, and pair it with an anti-vacuity witness (a NON-colour field, e.g. `text.content`, is NOT enumerated):

```ts
test("colorFieldsOf enumerates every colour field and no other", () => {
  const shape = buildShapeLayer(/* solid fill + border + shadow */);
  expect(colorFieldsOf(shape).map(f => f.path).sort())
    .toEqual(["border.color", "fill", "shadow.color"]);
  const text = buildTextLayer(/* + shadow + stroke */);
  expect(colorFieldsOf(text).map(f => f.path).sort())
    .toEqual(["color", "shadow.color", "stroke.color"]);
  // anti-vacuity: content is text, not colour
  expect(colorFieldsOf(text).map(f => f.path)).not.toContain("content");
});
```

- [ ] **Step 2: Run it, verify it fails** (`colorFieldsOf` undefined). `bun test tests/studio-color-fields.test.ts` → FAIL.

- [ ] **Step 3: Implement `colorFieldsOf` in `scene.ts`** using the spike's technique. Export it plus `SCENE_COLOR_FIELDS`.

- [ ] **Step 4: Run, verify pass.** `bun test tests/studio-color-fields.test.ts` → PASS.

- [ ] **Step 5: Rewire `usesInLayer` (tokens.ts) to use `colorFieldsOf`** for the colour dimension, keeping the non-colour uses (image slot line ~93, qr url line ~102 first push, text content line ~107 first push) unchanged. Keep `scene.canvas.background` handled in `extractTokens`.

- [ ] **Step 6: Rewire `resolveTokens` (values.ts) to use `colorFieldsOf`** for substitution, keeping non-colour substitution (none — resolveTokens only touches colour + the value map is keyed by token) — verify against the current field list.

- [ ] **Step 7: Run the full colour/token suite + mutation check.** `bun test tests/studio-tokens.test.ts tests/studio-values.test.ts tests/studio-color-fields.test.ts`. Then mutate: add a NEW `hexColor` field to a layer schema WITHOUT touching the walker → the tripwire must go red. Add a walker that misses one field → red. Record both.

- [ ] **Step 8: Commit.**

```bash
git add lib/studio/scene.ts lib/studio/tokens.ts lib/studio/values.ts tests/studio-color-fields.test.ts tests/studio-tokens.test.ts tests/studio-values.test.ts
git commit -m "refactor(studio): la liste des champs-couleur DÉRIVE du schéma, une seule fois (U4 Tâche 2)"
```

---

## Task 3: The editor paints bound colours via sample values

**Fix the core debt: in the browser paint path, resolve colour tokens to `SAMPLE_VALUES` for RENDERING ONLY. `state.scene` stays raw. Assert the editor and export resolve the same.**

**Files:**
- Modify: `components/studio/layer-view.tsx:101-175` (shape fill placeholder → resolved colour; text colour/shadow/stroke; qr fg/bg)
- Modify: `components/studio/canvas.tsx:214` (canvas background)
- Possibly add: a tiny display-resolve helper (reuse `resolveTokens` from `values.ts` with `SAMPLE_VALUES`, filtered to available tokens — mirror `preview-core.ts:67-73`'s merge, minus article values)
- Test: `tests/studio-shape-render.test.ts`, `tests/studio-render.test.ts` (both-paths-agree), new cases in `tests/studio-layer-view*`/`studio-canvas.test.ts` as appropriate

**Interfaces:**
- Consumes: `resolveTokens` (values.ts), `SAMPLE_VALUES` (sample-values.ts), `colorFieldsOf` (Task 2).
- Produces: a browser paint that shows the sample colour for a bound field; NO change to the exported scene or to `state.scene`.

- [ ] **Step 1: Write the §0 both-paths-agree test (failing).** For a scene whose `text.color = "{{category.color}}"`, assert the browser path and the export path paint the SAME resolved colour (`DEFAULT_CATEGORY_COLOR`). Reuse the export render already exercised in `studio-render.test.ts`; for the browser, render `LayerView`/`Canvas` under the U0 DOM harness and read the computed colour.

```ts
test("une couleur liée rend la MÊME valeur d'échantillon dans l'éditeur et à l'export", () => {
  const scene = sceneWith(textLayer({ color: "{{category.color}}" }));
  const exported = /* element.ts path after resolveTokens(scene, SAMPLE_VALUES) */;
  const browser  = /* layer-view paint under dom-harness */;
  expect(browserColorOf(browser, layerId)).toBe(DEFAULT_CATEGORY_COLOR);
  expect(browserColorOf(browser, layerId)).toBe(exportedColorOf(exported, layerId));
});
```

- [ ] **Step 2: Run, verify it fails** (browser currently drops the token → default/black, ≠ sample). Record the actual wrong colour.

- [ ] **Step 3: Implement display-resolve in the browser path.** Before painting, resolve colour fields to sample values (a pure display transform; do NOT mutate `state.scene`). Replace `ShapeContent`'s token-stripe branch (`layer-view.tsx:101-107`) with the resolved colour; feed `TextContent`, `QrContent`, and `canvas.tsx:214` background the resolved colour. Only colour fields (Task 2's `colorFieldsOf`) are resolved — image slots and text CONTENT keep current behaviour.

- [ ] **Step 4: Run, verify pass** for all layer types (text/shape/qr/background), and the both-paths-agree assertion. `bun run test:pure`.

- [ ] **Step 5: Guard editability.** Add a test that a bound colour field's UNDERLYING scene value is still the raw `{{token}}` after a paint (resolution is display-only), and that editing the field still round-trips the token. Mutation: make the resolve mutate `state.scene` → this test goes red.

- [ ] **Step 6: Commit.**

```bash
git add components/studio/layer-view.tsx components/studio/canvas.tsx tests/
git commit -m "fix(studio): une couleur liée se PEINT dans l'éditeur — valeur d'échantillon, et les deux chemins s'accordent (U4 Tâche 3)"
```

---

## Task 4: `parseScene` reports every error

**Files:**
- Modify: `lib/studio/scene.ts:246-261` (`parseScene`)
- Test: `tests/studio-scene.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `parseScene` still throws a `SceneError`, but `.message` now lists ALL Zod issues (each translated as today) PLUS the duplicate-id error, one per line. Signature unchanged — callers keep reading `.message`.

- [ ] **Step 1: Write the failing test.** A scene with THREE distinct problems (e.g. an unknown enum on one layer, a negative `frame.w` on another, and a duplicate id) must surface all three in `.message`:

```ts
test("parseScene rapporte TOUTES les erreurs, pas seulement la première", () => {
  const bad = sceneWithThreeProblems();
  try { parseScene(bad); throw new Error("devrait lever"); }
  catch (e) {
    expect(e).toBeInstanceOf(SceneError);
    const msg = (e as SceneError).message;
    expect(msg).toContain("layers.0.type");       // issue 1
    expect(msg).toContain("layers.1.frame.w");    // issue 2
    expect(msg).toContain("identifiant de calque en double"); // dup-id
  }
});
```

- [ ] **Step 2: Run, verify it fails** (only the first issue present). 

- [ ] **Step 3: Implement.** Map over ALL `parsed.error.issues` (each: `code === "custom" ? issue.message : frenchZodMessages(issue)`, prefixed by `issue.path.join(".") || "racine"`); on success, run the existing dup-id loop and, if it finds one, append its line. Join with `\n`. Keep throwing `SceneError`.

- [ ] **Step 4: Run, verify pass.** Also add: a single-error scene still reads cleanly (no dangling separators); a valid scene still parses. `bun test tests/studio-scene.test.ts`.

- [ ] **Step 5: Regression sweep of consumers.** Run the files that catch `SceneError`: `bun test tests/studio-editor-state.test.ts tests/studio-template*.test.ts tests/studio-preview.test.ts` (preview is DB-lane — run with `bun test`). Confirm reject-on-throw and `.message` display still behave.

- [ ] **Step 6: Commit.**

```bash
git add lib/studio/scene.ts tests/studio-scene.test.ts
git commit -m "fix(studio): parseScene remonte TOUTES les erreurs Zod + le double-id, pas la première seule (U4 Tâche 4)"
```

---

## Task 5: Token picker — legal only, illegal shown disabled with the reason + coverage audit

**Files:**
- Modify: `components/studio/token-picker.tsx:40-94`
- Modify (coverage): `components/studio/property-panel.tsx` (image slot `:522`, qr url `:850`, any colour/text field missing a picker)
- Reference (existing disable-with-reason pattern): `lib/studio/dynamic-text.ts:102-120`
- Test: `tests/studio-token-picker.test.ts`, `tests/studio-property-panel.test.ts`

**Interfaces:**
- Consumes: `CONTEXT_TOKENS`, `TOKEN_KINDS`, `TOKEN_LABELS`.
- Produces: `TokenPicker` shows all `kind`-matching tokens; out-of-context ones are DISABLED with the reason string; a pure helper `pickerRowsFor(context, kind): Array<{ id, label, available, reason? }>` (mirrors `dynamicTextRowsFor`) drives it and is unit-tested without DOM.

- [ ] **Step 1: Write the failing pure-helper test.** `pickerRowsFor(context, "color")` returns every colour token; those not in `CONTEXT_TOKENS[context]` have `available:false` + a non-empty `reason`; those in-context have `available:true`. Anti-vacuity: assert BOTH an available and an unavailable row exist for a context where they differ.

- [ ] **Step 2: Run, verify it fails** (`pickerRowsFor` undefined).

- [ ] **Step 3: Implement `pickerRowsFor`** (pure, in `token-picker.tsx` or a sibling pure module so it's testable without DOM), then render disabled rows with the reason via Base UI. Remember: a disabled Base UI control has `aria-disabled="true"` and NO native `disabled` attribute — assert the accessible state, not the substring `disabled`.

- [ ] **Step 4: DOM test under the U0 harness.** A disabled row does not fire `onPick` when activated; an available row does. 

- [ ] **Step 5: Coverage audit.** Assert a picker is present on: text content, every `ColorField`, image slot, qr url — and name in a comment any field that deliberately has none. Add pickers where missing.

- [ ] **Step 6: Run + mutation.** `bun run test:pure`. Mutate: make `pickerRowsFor` mark every row available → the unavailable-reason test reddens; make the disabled row still call `onPick` → the DOM test reddens.

- [ ] **Step 7: Commit.**

```bash
git add components/studio/token-picker.tsx components/studio/property-panel.tsx tests/
git commit -m "feat(studio): le sélecteur montre les jetons ILLÉGAUX désactivés avec le motif, sur chaque champ liable (U4 Tâche 5)"
```

---

## Task 6: Bindings visible on the canvas (`showBindings` toggle + outlines/labels)

**Files:**
- Modify: `lib/studio/editor-prefs.ts` (`EditorPrefs`, `DEFAULT_PREFS`, `parsePrefs`)
- Modify: `components/studio/canvas-chrome.tsx:179-219` (toggle button)
- Modify: `components/studio/canvas.tsx:207-374` (per-layer outline + label overlay, beside the snap guides)
- Modify: `components/studio/editor-shell.tsx:492-495` (wire the pref + handler)
- Test: `tests/studio-editor-prefs.test.ts`, `tests/studio-canvas.test.ts`

**Interfaces:**
- Consumes: `usesInLayer` (tokens.ts), `TOKEN_LABELS` (token-picker.tsx), the scaled-container coordinate + `1/scale` idiom from the snap guides (`canvas.tsx:350-374`).
- Produces: `EditorPrefs.showBindings: boolean` (default `false`); a per-bound-layer overlay rendered ONLY when `showBindings` is on.

- [ ] **Step 1: `showBindings` pref (failing test first).** In `tests/studio-editor-prefs.test.ts`: `DEFAULT_PREFS.showBindings === false`; `parsePrefs` restores a persisted `true`; a corrupt value falls back to `false` (per-field parser). 

- [ ] **Step 2: Run fail → implement** the three edits (field at `:31`, default at `:48`, `parseBooleanField(obj.showBindings, DEFAULT_PREFS.showBindings)` at `:128`) → pass.

- [ ] **Step 3: Overlay test (failing), under the U0 harness.** With `showBindings` on and two layers (one bound to `{{article.title}}`, one not), assert: exactly ONE accent outline + label renders, the label names the token (`TOKEN_LABELS["article.title"]`), and it is a SIBLING of the snap-guide layer in the scaled container (containment + paint-order, the U1 grid lesson). With `showBindings` off, NO overlay renders (anti-vacuity: the same fixture with the flag on DOES render it).

- [ ] **Step 4: Run fail → implement** the overlay in `canvas.tsx` (iterate `scene.layers`, `usesInLayer(layer)` to detect+name bindings, render outline+label in template coords with `1/scale` thickness/inverse-scale text) → pass. Add the toggle button in `canvas-chrome.tsx` following the rulers/grid idiom, and wire `showBindings` + `onToggleBindings` in `editor-shell.tsx`.

- [ ] **Step 5: Choice-function sweep.** The label-placement/anchor is a choice function — assert continuity/determinism (a layer at two nearby positions places the label without a jump; multiple bound layers get stable, non-overlapping labels). Mutation: point the label at the raw `frame` instead of the painted position on a rotated layer → a test reddens (echo of U2's painted-vs-raw lesson).

- [ ] **Step 6: Commit.**

```bash
git add lib/studio/editor-prefs.ts components/studio/canvas-chrome.tsx components/studio/canvas.tsx components/studio/editor-shell.tsx tests/
git commit -m "feat(studio): « voir les liaisons » — contour d'accent + étiquette de jeton sur les calques liés (U4 Tâche 6)"
```

---

## Self-review

**Spec coverage:** Composant 1 → Task 3; Composant 2 → Tasks 1+2; Composant 3 → Task 4; Composant 4 → Task 5; Composant 5 → Task 6. §0 guard → Task 3 Step 1. Structural guard → Task 2 Step 1/7. Spike/stop-and-report → Task 1. All spec sections mapped.

**Placeholder scan:** Task 1 is a research spike (its "implementation" is genuinely investigative, per the U3 clipPath precedent) — its uncertainty is the point, not a placeholder. All other tasks carry concrete test code, exact file:line targets, and named interfaces.

**Type consistency:** `colorFieldsOf` / `colorFieldPaths` (Task 1 produces the technique, Task 2 locks the name — Task 2 Step 3 must settle ONE name and use it in tokens.ts + values.ts); `pickerRowsFor` (Task 5); `EditorPrefs.showBindings` (Task 6, matching the `rulers/grid` boolean idiom); `SAMPLE_VALUES`/`DEFAULT_CATEGORY_COLOR` (Task 3, from sample-values.ts). Names are consistent across tasks.

**Ordering:** 1 (spike) gates 2 (derivation) gates 3 (colour resolve). 4, 5, 6 independent of each other; 6 uses `usesInLayer` unchanged. Any task's failure to hold its interface is caught by the next reviewer's gate.

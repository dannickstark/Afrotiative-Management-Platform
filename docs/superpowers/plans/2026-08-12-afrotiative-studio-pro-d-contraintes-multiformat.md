# Studio Pro · Chantier D — Contraintes durables & multi-format — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every layer a durable Figma-style constraint (per-axis pin) and a pure `relayout(scene, W, H)` engine so one template adapts across the 8 formats — anchoring that *survives resize*, not a one-shot reposition. Add the inspector widget, per-format overrides, and wire it into the render filmstrip + generation.

**Architecture:** In this product "resize" == "render at another format". So durable anchoring and multi-format are ONE pure function `relayout`. Constraints live on each layer (default Top+Left = a no-op migration); `relayout(scene, targetW, targetH)` applies per-format frame overrides first, else the per-axis pin math, and returns a NEW scene (never mutates). The inspector gets the clickable constraints widget; the render-mode filmstrip and generation consume `relayout`.

**Tech Stack:** Zod v4, Bun test, the U0 DOM harness (`tests/dom-harness.ts`), Satori (export render — unchanged), Base UI. `lib/studio/*` stays client-safe & DB-free.

## Global Constraints

- **Engine unchanged.** No Satori/`element.ts` behaviour change; `relayout` only computes frames, the existing render paths paint them.
- **Pure & non-mutating.** `relayout` and all geometry are pure functions returning new values; `state.scene` is never mutated (U4 lesson).
- **Migration is a no-op.** `constraints` is OPTIONAL; absence ≡ `{h:"left", v:"top"}`. Adding the field must not move any existing template at its home format (`relayout` at home dims is bit-identical to input).
- **`lib/studio/*` client-safe & DB-free** (runnable under `TEST_LANE=pure`; no `@/db`). Fast loop: `bun run test:pure`.
- **Structural over hand-maintained.** `FormatKey`/dims derive from `lib/studio/formats.ts#FORMAT_PRESETS` (never a recopied list); a tripwire if a format lacks dims.
- **Mutation is the only judge.** Load-bearing tests must go red under mutation. Anti-vacuity: negatives paired with positive witnesses.
- **French user-facing copy**, matching existing studio strings.

---

## Task 1: Schema — `constraints?` + `formatOverrides?` + no-op migration

**Files:**
- Modify: `lib/studio/scene.ts` (`layerBase`, `sceneSchema`; export constraint types + `constraintsOf`)
- Test: `tests/studio-scene.test.ts`, new `tests/studio-constraints.test.ts`

**Interfaces:**
- Produces:
  - `HConstraint = "left"|"right"|"leftRight"|"center"|"scale"`, `VConstraint = "top"|"bottom"|"topBottom"|"center"|"scale"`, `LayerConstraints = { h: HConstraint; v: VConstraint }`.
  - `layerBase.constraints?: LayerConstraints` (a `z.object({h: z.enum(...), v: z.enum(...)}).optional()`).
  - `sceneSchema.formatOverrides?: Record<string, Record<string, Frame>>` — `z.record(z.string(), z.record(z.string(), frameSchema)).optional()` (outer key = FormatKey string, inner key = layerId).
  - `export function constraintsOf(layer: Layer): LayerConstraints` → `layer.constraints ?? { h: "left", v: "top" }`.

- [ ] **Step 1: Write the failing test.** In `tests/studio-constraints.test.ts`: `constraintsOf` returns `{left,top}` for a layer with no `constraints`; returns the stored value when present; `parseScene` accepts a scene with a `constraints` field and with a `formatOverrides` map, and REJECTS an invalid enum (`h:"middle"`). Anti-vacuity: a scene WITHOUT constraints still parses (absence is legal).

```ts
test("constraintsOf defaults to top-left, honours stored", () => {
  expect(constraintsOf(textLayer({}))).toEqual({ h: "left", v: "top" });
  expect(constraintsOf(textLayer({ constraints: { h: "leftRight", v: "center" } }))).toEqual({ h: "leftRight", v: "center" });
});
test("parseScene accepts constraints + formatOverrides, rejects bad enum", () => {
  expect(() => parseScene(sceneWith(textLayer({ constraints: { h: "leftRight", v: "top" } })))).not.toThrow();
  expect(() => parseScene({ ...baseScene, formatOverrides: { ig_square: { l1: { x: 0, y: 0, w: 10, h: 10 } } } })).not.toThrow();
  expect(() => parseScene(sceneWith(textLayer({ constraints: { h: "middle", v: "top" } })))).toThrow();
});
```

- [ ] **Step 2: Run, verify it fails** (`constraintsOf` undefined / field unknown). `bun test tests/studio-constraints.test.ts`.

- [ ] **Step 3: Implement.** Add the enums, `constraints?` to `layerBase`, `formatOverrides?` to `sceneSchema` (reuse the existing `frame` schema object for the override value), and `constraintsOf`. Keep `.register()` ordering rules intact (no colour nodes involved here).

- [ ] **Step 4: Run, verify pass** + existing `tests/studio-scene.test.ts` green (dup-id/all-errors untouched).

- [ ] **Step 5: Migration no-op check.** A stored scene with no `constraints`/`formatOverrides` round-trips through `parseScene` unchanged (assert deep-equal). Mutation: making `constraints` required → the no-field scene fails to parse (proves optionality is load-bearing).

- [ ] **Step 6: Commit.**

```bash
git add lib/studio/scene.ts tests/studio-constraints.test.ts tests/studio-scene.test.ts
git commit -m "feat(studio): contraintes par calque + surcharges par format au schéma (défaut top/left = no-op) — chantier D T1"
```

---

## Task 2: The pure `relayout` engine (the core)

**Files:**
- Create: `lib/studio/relayout.ts`
- Test: `tests/studio-relayout.test.ts`

**Interfaces:**
- Consumes: `constraintsOf` (Task 1), `FORMAT_PRESETS`/`FormatKey` (`lib/studio/formats.ts`), `Frame`/`Scene` (`scene.ts`), `MIN_SIZE` clamp (reuse `lib/studio/layer-geometry.ts` if present, else a local `Math.max(1, …)`).
- Produces:
  - `relayoutAxis(pos, size, base, target, mode): { pos, size }` — the per-axis pin math (exported for direct testing).
  - `relayoutFrame(frame, c: LayerConstraints, base:{w,h}, target:{w,h}): Frame`.
  - `relayout(scene, target:{w,h}): Scene` — new scene, `canvas.{width,height}=target`, each layer: `formatOverrides` for this target win, else `relayoutFrame`. (This overload takes raw dims.)
  - `relayoutToFormat(scene, format: FormatKey): Scene` — resolves dims via `FORMAT_PRESETS` and calls `relayout`; passes the FormatKey so overrides are looked up.

- [ ] **Step 1: Write the failing tests — the per-axis truth table first.** `relayoutAxis` on base=1000 → target=500, pos=100, size=200:

```ts
// left: keep left gap
expect(relayoutAxis(100,200,1000,500,"left")).toEqual({ pos:100, size:200 });
// right: keep right gap (1000-300=700 → 500-700-200 = -400)
expect(relayoutAxis(100,200,1000,500,"right")).toEqual({ pos:100+(500-1000), size:200 }); // pos:-400
// leftRight: keep both gaps, stretch (new size = 500-100-700 = -300 → clamp handled at frame level)
expect(relayoutAxis(100,200,1000,500,"leftRight")).toEqual({ pos:100, size:500-100-(1000-300) });
// center: keep centre offset (centre 200, canvas centre 500, offset -300 → new centre 250-300=-50 → pos -150)
expect(relayoutAxis(100,200,1000,500,"center")).toEqual({ pos: 500/2 + (100+100-1000/2) - 100, size:200 });
// scale: proportional
expect(relayoutAxis(100,200,1000,500,"scale")).toEqual({ pos:50, size:100 });
```

Then the properties on the full engine (across the 5×5 × several base→target pairs incl. all 8 `FORMAT_PRESETS`):
- **Identity at home**: `relayout(scene, {w:scene.canvas.width, h:scene.canvas.height})` deep-equals `scene` (bit-for-bit) for ANY constraint set — the migration no-op.
- **left+top preserves the top-left gap**; **leftRight preserves both gaps**; **center preserves the centre offset**; **scale is proportional-exact** — each asserted numerically.
- **Overrides win**: with `formatOverrides.ig_square.l1` set, `relayoutToFormat(scene,"ig_square")` uses the override frame for `l1` and ignores its constraints (anti-vacuity: a DIFFERENT format still uses the constraint).

- [ ] **Step 2: Run, verify failing** (`relayout` undefined).

- [ ] **Step 3: Implement `relayoutAxis`** per the spec table (left/right/leftRight/center/scale), `relayoutFrame` (both axes + min-size clamp), `relayout` (overrides-then-constraints, new scene, no mutation), `relayoutToFormat`.

- [ ] **Step 4: Run, verify pass.** `bun run test:pure` (studio-relayout + studio-constraints + studio-scene).

- [ ] **Step 5: Choice-function sweep + structural guard.** (a) The override-vs-constraint selection is a choice function — assert determinism under override-map key reordering and continuity where applicable. (b) A tripwire: `relayoutToFormat` for every `FORMAT_KEYS` entry produces a scene whose canvas matches `FORMAT_PRESETS[key]` dims — so a format added without dims reddens. Mutation: drop the override branch → the override test reddens; swap two axis formulas → the truth-table reddens.

- [ ] **Step 6: Commit.**

```bash
git add lib/studio/relayout.ts tests/studio-relayout.test.ts
git commit -m "feat(studio): relayout(scene,W,H) — le moteur pur d'ancrage par contraintes, identité au format d'accueil — chantier D T2"
```

---

## Task 3: The text-wrap / `autoFit` / `maxLines` interaction + UI note

**A constrained text layer changes width across formats → its wrapping changes → `maxLines` may clip. Surface it; don't hide it.**

**Files:**
- Modify: `lib/studio/relayout.ts` (add a pure `overflowsMaxLines(layer, target)` predicate) OR a sibling `lib/studio/relayout-warn.ts`
- Modify: `components/studio/geometry-strip.tsx` (the note, next to the existing rotation/snap notes)
- Test: `tests/studio-relayout.test.ts` (render assertion), `tests/studio-geometry-strip.test.ts` (the note)

**Interfaces:**
- Consumes: the render measurement already used in `tests/studio-render.test.ts` (satori/resvg), `relayoutToFormat`.
- Produces: `constrainedTextOverflows(scene, layer, format): boolean` — true when a `text` layer with a width-changing constraint (`leftRight`/`scale`) relaid-out to `format` renders more lines than `maxLines`.

- [ ] **Step 1: Write the failing RENDER test.** A title that fits 1 line at its home (wide) format, constrained `leftRight`, relaid-out to `story` (1080×1920, narrow relative), renders >1 line and — with `maxLines:1` — clips. Assert the rendered line count / clipped state via the export render (`element.ts`/`renderScene`), and that `constrainedTextOverflows` returns `true` for that case and `false` at the home format.

- [ ] **Step 2: Run, verify failing.**

- [ ] **Step 3: Implement `constrainedTextOverflows`** (relayout the layer, measure wrapped lines against `maxLines`; reuse the render/measure util). Wire a discreet `<p>` note in `geometry-strip.tsx` shown ONLY when the selected text layer is width-constrained AND overflows in the *currently previewed* format — same tone/placement as the existing rotation/snap notes.

- [ ] **Step 4: Run, verify pass** (render test + note test). `bun run test:pure` + the render file.

- [ ] **Step 5: Anti-vacuity + mutation.** The note test pairs a positive (overflows → note present) with a negative (fits → no note), asserting the accessible text, not a bare substring. Mutation: make `constrainedTextOverflows` always false → the note test reddens.

- [ ] **Step 6: Commit.**

```bash
git add lib/studio/relayout*.ts components/studio/geometry-strip.tsx tests/
git commit -m "fix(studio): un texte contraint qui déborde maxLines dans un format le DIT — mesuré au rendu — chantier D T3"
```

---

## Task 4: The constraints widget in the inspector

**Files:**
- Create: `components/studio/constraints-field.tsx` (the clickable square + H/V dropdowns)
- Modify: `components/studio/geometry-strip.tsx` (mount it in the reserved spot — the file's own comment marks it: "U5 y ajoutera le widget d'ancrage par côté")
- Modify: `lib/studio/editor-state.ts` if a `setConstraints` action is cleaner than `patch` (check how `patch` handles a nested optional field first; `patch({constraints})` likely suffices)
- Test: `tests/studio-constraints-field.test.ts` (pure row logic), `tests/studio-geometry-strip.test.ts` (DOM via U0 harness)

**Interfaces:**
- Consumes: `constraintsOf` (T1), `LayerConstraints`, the `patch`/`dispatch` already threaded into `GeometryStrip`.
- Produces: `ConstraintsField({ layer, patch })`; a pure `nextConstraintOnEdgeClick(current, axis, edge): LayerConstraints` so the click→state mapping is unit-testable without DOM.

- [ ] **Step 1: Write the failing pure test.** `nextConstraintOnEdgeClick`: clicking the left edge sets `h:"left"`; clicking left THEN right sets `h:"leftRight"`; clicking an already-set single edge again toggles back; centre sets `center`. Cover both axes. Anti-vacuity: two distinct clicks yield two distinct states.

- [ ] **Step 2: Run fail → implement `nextConstraintOnEdgeClick`** (pure) + the `ConstraintsField` component (SVG/box square with clickable edge/centre hit areas + two `Select`s bound to H/V), writing `patch({ constraints })`. Mount in `geometry-strip.tsx`.

- [ ] **Step 3: DOM test under the U0 harness.** Clicking the widget's right edge dispatches a patch setting `h:"right"` (or `leftRight` if left already set); the H/V selects reflect `constraintsOf(layer)`; `Shift`+set applies across a multi-selection. Assert real accessible state, not substrings (Base UI `aria-*`).

- [ ] **Step 4: Run, verify pass.** `bun run test:pure`.

- [ ] **Step 5: Mutation.** Drop the edge→state mapping (return `current`) → the pure test reddens; unbind the Shift-multi path → its test reddens.

- [ ] **Step 6: Commit.**

```bash
git add components/studio/constraints-field.tsx components/studio/geometry-strip.tsx tests/ lib/studio/editor-state.ts
git commit -m "feat(studio): le widget de contraintes — carré cliquable + menus H/V dans la bande de géométrie — chantier D T4"
```

---

## Task 5: Per-format frame overrides (editing in a non-home format)

**Files:**
- Modify: `lib/studio/editor-state.ts` (a `setFrameOverride(format, layerId, frame)` action + reducer, writing `scene.formatOverrides`)
- Modify: `components/studio/render-mode.tsx` and/or the editing surface so that editing a frame while a non-home format is the active preview writes an override, not the home frame
- Test: `tests/studio-editor-state.test.ts`, `tests/studio-relayout.test.ts`

**Interfaces:**
- Consumes: `relayoutToFormat`, `formatOverrides` (T1), the reducer's immutable-update patterns.
- Produces: `setFrameOverride` action; the invariant that editing a frame at the HOME format still edits `layer.frame` (overrides only for non-home formats).

- [ ] **Step 1: Write the failing reducer test.** Dispatching `setFrameOverride("story", "l1", frame)` writes `scene.formatOverrides.story.l1` and leaves `layer.frame` (home) untouched; a subsequent `relayoutToFormat(scene,"story")` uses the override for `l1` and constraints for the others; one undo removes the override (one history entry).

- [ ] **Step 2: Run fail → implement** the action + reducer (immutable nested update; clearing an override when it equals the constraint result is optional, keep simple). Wire the editing surface: when the active previewed format ≠ home, a frame edit routes to `setFrameOverride`.

- [ ] **Step 3: Run, verify pass** + undo/redo round-trips the override (no orphan). `bun run test:pure`.

- [ ] **Step 4: Mutation.** Route the non-home edit to `layer.frame` instead of the override → the "home untouched" test reddens.

- [ ] **Step 5: Commit.**

```bash
git add lib/studio/editor-state.ts components/studio/render-mode.tsx tests/
git commit -m "feat(studio): surcharge de cadre par format — l'échappatoire manuelle quand les contraintes ne suffisent pas — chantier D T5"
```

---

## Task 6: Wire the filmstrip + generation to `relayout`

**Files:**
- Modify: `components/studio/render-mode.tsx` (each format thumbnail renders `relayoutToFormat(scene, key)`)
- Modify: the generation/diffusion render path that produces a channel's format (find via `lib/studio/render.ts` / `preview-core.ts` consumers) so it relayouts the template to the target channel format
- Test: `tests/studio-render-mode.test.ts`, and the generation path's test

**Interfaces:**
- Consumes: `relayoutToFormat` (T2).
- Produces: filmstrip thumbnails that show the REAL adapted layout per format; generation output that adapts one template across formats.

- [ ] **Step 1: Write the failing test.** The render-mode filmstrip for a template with a `leftRight`-constrained banner shows, for `story`, a thumbnail whose banner spans the (narrower) width — i.e. the thumbnail scene is `relayoutToFormat(scene,"story")`, not the raw scene. Assert the relaid frame reaches the thumbnail (via the scene passed to the render), paired with the home thumbnail being identity.

- [ ] **Step 2: Run fail → implement** the filmstrip wiring (pass `relayoutToFormat(scene, key)` to each thumbnail render) and the generation path (relayout to the channel's format before render). Keep §0: the filmstrip thumbnail and the export of the same format agree.

- [ ] **Step 3: Run, verify pass.** `bun run test:pure` + the DB-lane generation test with `bun test`.

- [ ] **Step 4: §0 guard.** A relaid-out format rendered in the filmstrip equals the export of that same relaid-out scene (reuse the U4 both-paths pattern).

- [ ] **Step 5: Commit.**

```bash
git add components/studio/render-mode.tsx lib/studio/*.ts tests/
git commit -m "feat(studio): la bande de vignettes et la génération adaptent UN gabarit à chaque format via relayout — chantier D T6"
```

---

## Self-review

**Spec coverage:** §1 schema → Task 1; §2 relayout engine → Task 2; §4 text-wrap limit → Task 3; §3 inspector widget → Task 4; §1 formatOverrides + §escape-hatch → Task 5; §5 filmstrip+generation → Task 6. Two honesty limits: text-wrap → Task 3; extreme-aspect overrides → Tasks 1+5. Migration no-op → Task 1 Step 5 + Task 2 identity property. All spec sections mapped.

**Placeholder scan:** the per-axis math is spelled out concretely (Task 2 Step 1 truth table). No TBD/TODO. Render-measure util is named by reference to the existing `studio-render.test.ts` mechanism rather than re-specified.

**Type consistency:** `constraintsOf` / `LayerConstraints` / `HConstraint` / `VConstraint` (T1) used verbatim in T2, T4. `relayout` / `relayoutToFormat` / `relayoutFrame` / `relayoutAxis` (T2) consumed by T3, T5, T6. `setFrameOverride` (T5) matches `formatOverrides` shape (T1). `FormatKey`/`FORMAT_PRESETS` from formats.ts throughout. `nextConstraintOnEdgeClick` (T4) settled once.

**Ordering:** T1 (schema) → T2 (engine) → T3 (text case, needs engine) → T4 (widget, needs constraints type) → T5 (overrides, needs engine+schema) → T6 (wiring, needs engine). Each ends with an independently testable deliverable.

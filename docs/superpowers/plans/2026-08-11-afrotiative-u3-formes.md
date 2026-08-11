# U3 — Système de formes — Spec & Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the studio a real shape vocabulary — ellipse, line, and a polygon family — instead of the single rectangle it has today, **after proving the engine can actually draw them**.

**Architecture:** Shapes are described once, in a pure module, and consumed by **both** render paths. The engine work is a `clipPath` spike that either succeeds or changes the plan.

**Tech Stack:** Satori + resvg + sharp · Bun test · React 19 · the U0 DOM harness

**Spec + plan combined**, as U0 and U2 did.

**Programme:** `docs/superpowers/specs/2026-08-10-afrotiative-studio-ux-roadmap.md` — U3 of U1 → U5.

---

## 0. The structural fact this plan is built around, found before writing it

**There are TWO independent shape-painting implementations, and neither knows about the other:**

| Path | File | What it feeds |
|---|---|---|
| Export | `lib/studio/element.ts` → `shapeNode()` | Satori → resvg → the actual PNG |
| Editor | `components/studio/layer-view.tsx` → `ShapeContent()` | the browser canvas the designer looks at |

Both handle exactly one shape today (`rect`, via `borderRadius`). **A task that teaches one path a new shape and not the other ships an editor that disagrees with its own export** — the designer draws an ellipse, the exported image contains a rectangle, and nothing fails.

This is the same shape as plan defects #9 and #10 in U2, which is why it was looked for before this plan was written rather than discovered during it. The roadmap's instruction — *"before writing U3's plan, ask: which earlier decision makes a file I am about to name wrong?"* — is what produced this section.

**Consequence, binding on every task below:** a new shape is not "done" until **both** paths draw it and a **completeness guard** binds `SHAPE_KINDS` to both. U1 already established this pattern once (`SHAPE_KINDS` is consumed by `z.enum` *and* by the gallery guard, so U3 cannot ship a shape no interface inserts); U3 extends the same guard to cover rendering.

## 1. The spike gate — this plan may change shape after Task 1

The roadmap records a reservation, and it is load-bearing:

> La présence de `clipPath` dans la liste vient de la documentation de Satori, pas d'un polygone effectivement rendu par ce projet.

**Nothing in this repo has ever rendered a `clipPath` through Satori.** The rest of this plan assumes it works. Task 1 is a spike that settles it against the real pipeline — Satori → resvg → sharp — not against documentation, and **not** against a browser.

If `clipPath` does not work, **stop and report**. The fallback is stated in Task 1 and changes Tasks 3–4 materially. Do not implement the fallback without checking in: choosing it silently would be the single most expensive mistake available in this sub-project.

## Global Constraints

- **Read the Next.js docs** under `node_modules/next/dist/docs/01-app/` before touching a page or Server Action. This sub-project should need neither.
- **Engine ceiling** (`docs/.../studio-ux-roadmap.md` §« Le plafond du moteur »): flexbox, absolute, transform, border-radius, box-shadow, gradients. **No CSS Grid, no `z-index`, no `calc()`, no `backdrop-filter`, no WOFF2.** Paint order **is** layer array order.
- **A `"use client"` component must never value-import a module reaching `@/db`**, except through a file-level `"use server"` module (see U2's plan for the measured carve-out: 31 such paths repo-wide, 7 in the studio, **0 real violations**). `bun run build` is **not** evidence — trace value imports, and `bun build --target=browser` plus grep for certainty.
- **`tests/publish-due.test.ts` and `tests/wp-publish.test.ts` must stay green AND unmodified.**
- **Do not weaken, convert or delete an existing assertion.**
- **Never two `bun test` invocations at once**; **foreground only**, never backgrounded.
- **NEVER run the full suite** — its count is not reproducible on this repo. Focused files only; re-run a failure alone before concluding anything.
- **Three suite failures are pre-existing:** `tests/pipeline-web-search.test.ts` (a) and (d), `tests/pipeline-pause-resume.test.ts` pause checkpoint (b).
- French user-facing strings; **Base UI** (`render` prop, never `asChild`).
- Commit messages in **French**, prefix `feat(studio):` or `fix(studio):`, ending with:
  `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`

### Method carried from U2, because it is what actually found defects

- **Mutation is the gate.** For every fix and every new behaviour, name the mutation that now fails. If no mutation can redden it, either the code is dead or the test is missing — both are findings. (U2's own author wrote a delta-wrap, then deleted it after a mutation proved it dead.)
- **Sweep every choice function for continuity.** All four of U2's invisible defects were choice functions, each holding every asserted property *at every point tested* while jumping *between* points — up to 2593 px. **List the choice functions you introduce and sweep each.** In U3 the obvious candidate is any "which polygon vertex does this corner radius apply to" or "which shape does this gallery tile insert" mapping.
- **Ask of each test: what would have to be true for this to fail?** Seven assertions in U2 could not fail, including a supposed anti-vacuity guard that was itself vacuous, and two naive-substring traps (`not.toContain("disabled")` matches `disabled:pointer-events-none`; React serialises `height: 0` as `height:0`, never `height:0px`).
- **Do not spend effort on** `expect()`-count monotonicity or `bun run build` as evidence — the U2 review found neither earned its keep.
- **Report any defect in this plan rather than implementing around it.** Eleven were found that way in U1+U2, every one by an implementer who checked rather than transcribed.

---

### Task 1: The `clipPath` spike — settle the reservation before building on it

**Files:** create `tests/studio-render-clippath.test.ts`; touch no production file.

**This task's deliverable is knowledge, not a feature.** It answers one question with evidence: *can this project's real render pipeline draw a non-rectangular shape, and by what mechanism?*

**Verify first:** how `lib/studio/render.ts` invokes Satori and resvg, and what it returns; whether a test can call it without network or database. If rendering requires assets or fonts that a test cannot obtain, say so in your report and spike the narrowest thing that still answers the question.

- [ ] **Step 1: Render a triangle through the real pipeline.** Build the smallest scene that should produce a clearly non-rectangular fill, render it, and **inspect the output pixels** — not the intermediate SVG, and not a browser. A `clipPath: polygon(50% 0, 100% 100%, 0 100%)` on a solid fill either clips or it does not.

  **The property to establish, and it must be a pixel assertion:** a pixel near a corner the polygon excludes (say 5% in from the top-left) is **background**, while a pixel at the centre is **fill**. Asserting "the PNG is non-empty" or "no error was thrown" proves nothing — a `clipPath` silently ignored produces a perfectly valid full rectangle.

- [ ] **Step 2: Try the alternatives, in this order, and record which work.** Even if step 1 succeeds, establish what else does — Tasks 3–4 need to know which mechanisms are available:
  1. `clipPath` with `polygon()`
  2. `borderRadius: "50%"` for an ellipse (cheapest possible ellipse, and likely to work since border-radius is on the supported list)
  3. An inline `<svg>` node, if Satori accepts one
  4. A rotated `div` for a line/diagonal

- [ ] **Step 3: Write the finding down where the next reader will hit it.** Append a dated section to this plan file recording, for each mechanism: works / does not work / works with caveats, **with the evidence**. This is the artefact the roadmap's reservation was waiting for.

- [ ] **Step 4: Commit.** `test(studio): la vérification clipPath — ce que le moteur sait réellement dessiner`

- [ ] **Step 5: STOP AND REPORT.** State plainly which mechanisms work. **If `clipPath` does not work**, do not proceed and do not improvise: the fallback (an SVG-node shape family, or a reduced shape set of ellipse + line only) changes Tasks 3 and 4 materially and is the human's decision.

---

### Task 2: One description of a shape, consumed by both paths

**Files:** create `lib/studio/shapes.ts`; modify `lib/studio/scene.ts`, `lib/studio/element.ts`, `components/studio/layer-view.tsx`; tests.

**Verify first:** `SHAPE_KINDS` at `lib/studio/scene.ts:84` (today `["rect"]`), `shapeNode()` at `lib/studio/element.ts:79`, and `ShapeContent()` at `components/studio/layer-view.tsx:86`. Read §0 above before starting.

**The module.** A pure description of each shape: its kind, its French label, and **the CSS it needs in order to be painted** — expressed once, so that `shapeNode` (Satori) and `ShapeContent` (browser) can each ask for it instead of each carrying its own `switch`. Use only mechanisms Task 1 proved.

**This task must not add a single new shape.** It refactors `rect` onto the shared description and proves the two paths agree, so that Task 3 adds shapes in one place. Shipping the refactor and the new shapes together would make it impossible to tell which broke what.

**Properties:**
- For **every** kind in `SHAPE_KINDS`, both paths produce the shape's declared CSS — asserted by iterating `SHAPE_KINDS` itself, **never a hand-copied list** (U1 shipped exactly that defect, and U2's harness shipped it again).
- `rect` renders **byte-identically to before** on both paths — this is a refactor, and that is how you prove it.
- A kind present in `SHAPE_KINDS` but unhandled by either path is a **test failure**, not a silent fallback to a rectangle.

- [ ] Step 1: failing tests · [ ] Step 2: confirm red · [ ] Step 3: implement · [ ] Step 4: green, incl. `studio-element`/`studio-render` and the layer-view tests · [ ] Step 5: commit

---

### Task 3: Ellipse, line, and the polygon family

**Files:** `lib/studio/shapes.ts`, `lib/studio/scene.ts`, `lib/studio/shape-gallery.ts`, tests.

**Verify first:** Task 2's module, and `SHAPE_GALLERY` at `lib/studio/shape-gallery.ts:35` with the completeness guard U1 built around it.

**The shapes**, subject to Task 1's findings: **ellipse**, **line**, **triangle**, **star**, **hexagon**, **arrow**, **speech bubble**. If a mechanism did not survive Task 1, ship fewer and say which and why — **a shape that renders differently in the editor and the export must not ship at all.**

**Properties:**
- Each new kind is in `SHAPE_KINDS`, insertable from the gallery, and rendered by **both** paths — the guard from Task 2 enforces this, so adding a kind without rendering it fails.
- A **line** has a real height and remains selectable and draggable; decide and document what a "line" is geometrically (a thin rectangle? a rotated one?) rather than leaving it implicit.
- `radius` still applies where it means something, and is ignored — **not misapplied** — where it does not.
- Every shape survives a **rotation**, a **resize to `minSize`**, and a **non-uniform aspect** without becoming degenerate. Test the extremes; U2's defects all lived at extremes.

- [ ] Step 1: failing tests · [ ] Step 2: confirm red · [ ] Step 3: implement · [ ] Step 4: green · [ ] Step 5: commit

---

### Task 4: Shadows on shapes, and per-corner radius

**Files:** `lib/studio/scene.ts`, `lib/studio/shapes.ts`, `lib/studio/element.ts`, `components/studio/layer-view.tsx`, `components/studio/property-panel.tsx`, tests.

**Verify first:** how `box-shadow` is already used (U1's artboard shadow was **clipped** by an `overflow-hidden` container — a green test over an unmet property, and the same trap is available here), and the existing `radius` field.

**Per-corner radius** (`borderRadius: "8px 24px 8px 24px"`) and a **shadow** on shape layers. Both are on the engine's supported list, so this task is about the model and the controls, not about whether it can draw.

**Properties:**
- A per-corner radius round-trips through `parseScene` and renders on both paths.
- A **scalar** `radius` still parses — existing scenes must not break. State the migration explicitly.
- The shadow is **visible**, not merely present in the markup: assert against the composition, the way U2 Task 6's band test does with a real containment check.
- Radius on a clipped polygon: decide whether it applies, is ignored, or is hidden in the UI, and **say so in the interface** rather than letting the control do nothing (U2's precedent: `snap-rotation-note`, `safe-areas-none`).

- [ ] Step 1: failing tests · [ ] Step 2: confirm red · [ ] Step 3: implement · [ ] Step 4: green · [ ] Step 5: commit

---

### Task 5: The accessibility defect U2 deferred

**Files:** `components/studio/mode-switch.tsx`, tests.

`role="radiogroup"` sits above children that are not `radio` — they carry `aria-pressed`. A real accessibility bug, **older than U2**, deferred by U2's final review with the ruling *"acceptable for merge, carry to U3"*.

Fix it coherently: either the children become real radios, or the container stops claiming to be a radiogroup. **Assert the resulting role/state pair**, and check the keyboard behaviour matches whatever you choose — a radiogroup implies arrow-key navigation, and claiming the role without it is the same defect in a new coat.

- [ ] Step 1: failing test · [ ] Step 2: confirm red · [ ] Step 3: implement · [ ] Step 4: green · [ ] Step 5: commit

---

## Self-Review

**Coverage:** the roadmap's U3 line asks for ellipse, line, polygon family via `clipPath`, per-corner radius and shadows on shapes → Tasks 3 and 4, gated by Task 1's spike. Its explicit instruction to *"commence par la vérification `clipPath`"* → Task 1, with a stop-and-report. U2's deferred a11y item → Task 5.

**Placeholder scan:** none. Task 1 deliberately has an unknown outcome; that is its purpose, and the branch point is stated rather than assumed away.

**Type consistency:** `SHAPE_KINDS` is the single list, already consumed by `z.enum` and the gallery guard; Task 2 extends the same guard to both render paths rather than introducing a second list.

**The risk this plan carries:** Task 2 is a pure refactor with no user-visible result, and there is a standing temptation to fold it into Task 3. Don't. The two render paths have been silently independent since V1, and merging the refactor with the feature would hide which of the two caused any divergence — which is precisely the failure §0 exists to prevent.

# U2 — Surface de précision — Spec & Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make placement in the studio precise instead of approximate — snapping with smart guides, multi-selection with align and distribute, the three gesture modifiers every design tool has, the safe-area bands, and a fix for the resize drift on rotated layers.

**Architecture:** Almost all of this is **pure geometry** plus a thin overlay. The snap engine, the align/distribute maths, the gesture modifiers and the rotated-resize fix are all functions from frames and a pointer delta to frames — testable with object literals, no DOM. Only the guide overlay and the bands are rendering. Multi-selection is the one change with a real ripple, and it comes before the features that need it.

**Tech Stack:** Bun test · React 19 · the U0 DOM harness (`tests/dom-harness.ts`) for interaction seams · existing `hooks/use-layer-drag.ts` pure core

**Spec + plan combined**, as `2026-08-10-afrotiative-d2-d3-meta.md` and U0 did: the design decisions were settled in the 2026-08-10 workshop and recorded in the roadmap, so a separate spec would restate them.

**Programme:** `docs/superpowers/specs/2026-08-10-afrotiative-studio-ux-roadmap.md` — U2 of U1 → U5.

---

## A note on this plan's form, and why it differs

U1's plan carried literal test code, and **six of those snippets were defective** — two would have passed vacuously, one compared a hand-copied mirror instead of the real schema, one referenced a `data-testid` that never existed, and two called helpers that were never defined. Every one was caught by an implementer writing the test, not by me writing the plan.

So this plan states **the property each test must establish** and **the exact signature to verify first**, rather than fabricating code. Implementers: you are expected to write the assertions yourself and to read the real source before asserting against it. If a property here is untestable as stated, say so rather than inventing something adjacent.

## What U1 already shipped, so you don't rebuild it

- `EditorPrefs` (`lib/studio/editor-prefs.ts`) — pure, per-field fallback, never throws. Already carries `rulers`, `grid`, `safeAreas`, `sectionsOpen`, `recentShapes`, `lastOpenPanel`.
- Rulers and grid are **rendered** (`components/studio/canvas-chrome.tsx`), off by default, persisted. `RULER_SIZE` is exported and the scale computation is ruler-aware.
- The **safe-area toggle and its persistence** exist; `safeAreaDefaultFor(format)` derives from orientation and is tested for all eight formats. **U2 draws the bands.**
- The pinned geometry strip (`components/studio/geometry-strip.tsx`) was built **with room for U2's align/distribute row** — put it there rather than inventing a new surface.
- Shared field primitives live in `components/studio/property-fields.tsx`.
- A DOM harness exists: `installDom`, `mount`, `click`, `pressKey`, `flush` in `tests/dom-harness.ts`. Note that a test needing the real Base UI popover must run under `bun test --isolate` — see U0's report for why, and follow `tests/studio-interactions.test.ts`'s loud-skip pattern rather than assuming isolation.

## Global Constraints

- **Read the Next.js docs** under `node_modules/next/dist/docs/01-app/` before touching a page or Server Action — `AGENTS.md` requires it.
- **A `"use client"` component must never *value*-import a module reaching `@/db`** (`lib/studio/bindings.ts` does). `import type` is fine. Only `bun run build` catches a violation; run one when you change imports.
- **`tests/publish-due.test.ts` and `tests/wp-publish.test.ts` must stay green and unmodified.**
- **Never install DOM globals in `test-setup.ts` or `bunfig.toml`** — opt-in per file only.
- **Do not weaken, convert or delete an existing test.** `renderToStaticMarkup` tests stay; add interaction tests beside them.
- French user-facing strings; **Base UI** (`render` prop, never `asChild`).
- **Never two `bun test` invocations at once** (`test-setup.ts:38-40`); **foreground only**, never backgrounded or monitored.
- **A full-suite count is not reproducible on this repo.** Run focused files; if one fails, re-run it alone before concluding anything. Fixtures with a future deadline must be cleaned in an `afterAll` that runs even on failure.
- **Three suite failures are pre-existing:** `tests/pipeline-web-search.test.ts` (a) and (d), `tests/pipeline-pause-resume.test.ts` pause checkpoint (b).
- Commit messages in **French**, prefix `feat(studio):` or `fix(studio):`, ending with:
  `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`

---

### Task 1: The rotated-resize drift — reproduce it, then fix it

**Files:** `hooks/use-layer-drag.ts`, `tests/studio-drag.test.ts`

**Verify these first, before writing anything:** `computeResizedFrame(start, handle, delta, minSize = 1)` at `hooks/use-layer-drag.ts:26`; the `HandleId` union at `:16`; how `screenDelta` produces its delta inside `createGestureEngine` at `:114`; and how `components/studio/canvas.tsx:141-180` renders the handles **inside** a `transform: rotate(Ndeg)` container.

**The defect.** `computeResizedFrame` applies an axis-aligned screen-space delta directly to `x/y/w/h`. The handles are rendered inside a rotated container, so on a rotated layer the east handle no longer points along +x on screen. Dragging it therefore changes the wrong dimension by the wrong amount, and the layer also translates when it shouldn't. Nobody reported it because rotation is rare today.

**Step 1 is a failing test, and it is the point of this task.** Establish the drift before changing any behaviour: for a layer at rotation 90°, dragging the `e` handle by a screen delta of `(0, +d)` should widen it by `d` (because +y on screen is the layer's local +x at 90°).

**Amended 2026-08-11 — this paragraph originally also demanded "and its centre should stay put", which contradicts the "opposite edge stays fixed on screen" property listed below.** Task 1's implementer derived the conflict and kept the well-founded half. For a one-sided drag the anchored edge is what a designer expects to hold; since rotation is about the centre, holding the west edge while the width grows *requires* the centre to move. Centre-stays-put is the property of **Alt-resize-from-centre**, which is Task 2's, not this one's. Assert against the current function and watch it fail. **If it does not fail, stop and report** — my analysis would then be wrong, and the rest of this task must not be built on it.

**The fix.** Rotate the delta into the layer's local frame before applying it, then compensate the frame's `x`/`y` so the **unmoved edges stay unmoved on screen** — rotation is about the centre, so changing `w` moves both edges unless compensated. The contract must change: pass `rotation` in. Update every caller and the existing `tests/studio-drag.test.ts` cases — updating them for a legitimate signature change is correct; weakening an assertion is not.

**Properties to establish:** at rotation 0 the behaviour is **byte-identical to today** (regression guard for every existing case); at 90/180/270 a single-axis drag changes only the intended dimension; the opposite edge stays fixed on screen for a one-sided handle; `minSize` still clamps; and a corner handle at an arbitrary angle (say 37°) produces a frame whose rotated corners match the expected screen positions within a small epsilon.

- [ ] Step 1: Write the failing test proving the drift · [ ] Step 2: Run it, confirm it fails for the stated reason · [ ] Step 3: Fix the geometry and update callers · [ ] Step 4: Run `tests/studio-drag.test.ts` and `tests/studio-canvas.test.ts` · [ ] Step 5: Commit

---

### Task 2: The three gesture modifiers

**Files:** `hooks/use-layer-drag.ts`, `tests/studio-drag.test.ts`

**Verify first:** Task 1's new `computeResizedFrame` signature, and `computeRotationDeg(center, start, current, startDeg)` at `:53` — note its comment explaining that the angle is scale-invariant, which is why it needs no scale conversion.

Add, as pure options rather than new functions where possible:

- **Shift constrains resize to the layer's aspect ratio.** For a corner handle, the dominant axis wins; for a side handle, decide and document whether Shift does anything at all (in most tools it does not).
- **Shift snaps rotation to 15° increments.**
- **Alt resizes from the centre** — both opposite edges move symmetrically.

**Properties:** each modifier off reproduces today's behaviour exactly; Shift-resize preserves `w/h` ratio within epsilon across all eight handles; Shift-rotate yields only multiples of 15; Alt-resize keeps the centre fixed; Shift and Alt **combined** behave sensibly (state which you chose and why).

> **Amendment, 2026-08-11 — the eight-handle contradiction was mine.** The bullet above tells the
> implementer to decide whether Shift does anything on a *side* handle, then the properties line demands
> the ratio hold "across all eight handles". Those cannot both bind: if a side handle ignores Shift, its
> ratio is free by construction.
>
> **The delivered behaviour is Shift on CORNERS ONLY** (`lockAspectRatio && isCorner`), verified against
> the built function rather than read off a comment: on a side handle the returned frame is
> *byte-identical* to the unmodified drag, and on a corner the ratio is preserved exactly. The
> properties line's "all eight handles" is therefore **struck** — read it as "across all four corner
> handles; side handles ignore Shift".
>
> Two notes on how this amendment itself went wrong, because the failure is instructive. Its first
> version asserted the opposite — "Shift constrains all eight, side handles included" — which I wrote
> from memory of my own plan instead of from the source, in the same breath as telling the implementer
> its side-handle decision stood. The implementer refused to reconcile the two and escalated rather than
> guess, which was right. **A plan amendment is a durable claim about delivered behaviour and must be
> checked against the code like any other.**
>
> The open question that remains is a matter of taste, not correctness, and is *not* settled by evidence:
> whether Shift should also scale from an edge. Corners-only is what ships. The justification originally
> given — "in most tools it does not" — was never verified and the Task 1+2 reviewer disputed it; neither
> side had checked, so **no claim about other tools' behaviour is recorded here.** The geometric argument
> that does hold: a side handle carries one degree of freedom, so constraining it forces a dimension the
> user is not dragging to move. Revisit only on a real user complaint.
>
> Two further corrections from the same review, both about claims rather than code:
>
> - **Alt is centre-fixed with the handle under the cursor**, so the frame grows by twice the pointer
>   delta. Nothing in this plan specified the factor; the first implementation chose half, which quietly
>   repealed Task 1's direct-manipulation invariant. Figma, Sketch, Illustrator and Photoshop all keep
>   the handle on the cursor. **The doubling is now the specified behaviour.**
> - The aspect-lock rule must be **continuous in the pointer position**. The first implementation picked
>   a dominant axis by `|Lx| >= |Ly|`, which disagrees with itself at the 45° line whenever the ratio is
>   not 1:1 — a 0.002 px pointer move flipped the frame by up to 198 px, invisible to every pointwise
>   assertion. The fix projects the cursor onto the ratio-locked diagonal, which is linear in the delta
>   and therefore continuous by construction. **A continuity property test is required**, not optional:
>   two deltas 0.001 apart must not produce frames more than ~0.01 px apart. This is the second time in
>   this programme that a set of individually-true pointwise properties admitted a defect between them.

- [ ] Step 1: failing tests · [ ] Step 2: confirm red · [ ] Step 3: implement · [ ] Step 4: green, plus `tests/studio-interactions.test.ts` · [ ] Step 5: commit

---

### Task 3: Multi-selection

**Files:** `lib/studio/editor-state.ts`, `components/studio/canvas.tsx`, `components/studio/layer-panel.tsx`, `components/studio/property-panel.tsx`, `components/studio/editor-shell.tsx`, plus their tests

**Verify first:** `EditorState.selectedId` at `lib/studio/editor-state.ts:31`, the `select(id)` action at `:64`, and every place `selectedId` is read — `grep -rn "selectedId" components lib app tests` before you start, because this is the task with a real ripple.

**The model.** Replace `selectedId: string | null` with **`selectedIds: string[]`**, and expose a derived helper for the common single-selection case so consumers that only make sense with one layer stay simple. Selection gestures: click replaces; **Shift-click** (or Cmd/Ctrl-click — pick one, document it) adds and removes; clicking empty canvas clears.

**Deliberate scope limits.** No rubber-band marquee selection in U2 — it is a separate interaction with its own edge cases, and the roadmap does not ask for it. No group/ungroup — the engine has no grouping and paint order *is* array order.

**Properties:** an empty selection, a single selection and a multi selection each round-trip through the reducer; undo/redo restores the selection that existed; deleting a selected layer removes it from `selectedIds` without orphaning the others; the property panel shows per-type sections **only** for a single selection and says something honest in French for a multi selection; the layer panel highlights every selected row.

Keep the existing static-markup tests passing; add interaction tests via the U0 harness for Shift-click add and remove.

- [ ] Step 1: failing tests · [ ] Step 2: confirm red · [ ] Step 3: implement, migrating every `selectedId` reader · [ ] Step 4: green across `studio-editor-state`, `studio-canvas`, `studio-layer-panel`, `studio-property-panel`, `studio-editor-shell`, `studio-interactions` · [ ] Step 5: commit

---

### Task 4: Align and distribute

**Files:** create `lib/studio/align.ts`; modify `components/studio/geometry-strip.tsx`, `lib/studio/editor-state.ts`; tests

**Verify first:** Task 3's `selectedIds`, and the room U1 left in `geometry-strip.tsx` for this row.

> **Amendment, 2026-08-11 — PLAN DEFECT #9, mine: this task's file list would have hidden the feature
> from its own primary use case.** "Modify `components/studio/geometry-strip.tsx`" is where the row
> belongs for a *single* selection, but Task 3 made `PropertyPanel` return early for a multi selection
> (`property-panel.tsx:679`, `if (selectedIds.length > 1)`), and `GeometryStrip` renders only *after*
> that return. So a literal reading puts align/distribute exclusively on the single-selection path —
> invisible whenever more than one layer is selected, which is what aligning is *for*. The defect was
> created by Task 3 and inherited by this task's file list; neither task's text mentions it.
>
> **Delivered instead:** `geometry-strip.tsx` exports both `GeometryStrip` (which carries the row as its
> third row, for artboard-relative alignment of one layer) and a standalone `AlignRow`, which
> `PropertyPanel` also renders above the multi-selection message. Both placements are pinned by tests,
> and U1's existing "no geometry-strip for a multi selection" assertion stays true and unmodified.
>
> **"Distribute produces equal gaps within epsilon" needed qualifying, found by writing the missing
> test.** The property holds in the **distribution order** — the input's positional sort — and is
> observable by re-measuring positions only *while distribution preserves that order*. It can fail to:
> when the frames' widths sum far exceeds the span, the equal gap goes so negative that a frame is placed
> to the **left of its predecessor** and the positional order inverts. Concretely `A{x:0,w:10}
> B{x:5,w:1000} C{x:20,w:10}` distributes to `x = 0, −485, 20`; gaps in distribution order are −495 and
> −495, while gaps re-measured by position are **−515 and 10**. The outer frames stay pinned either way.
> This is the exact scope of the guarantee, not a calculation error, and both measurements are now
> asserted side by side so the distinction cannot be lost. The overlapping-frames case already in the
> suite keeps its order, which is why it sees equal gaps under both measurements and why the limit was
> invisible until this input class was tested.
>
> **Also under-specified here, and resolved:** "locked layers are excluded and the rest still align" did
> not say excluded *from what*. Locked layers are now excluded from the **bounding box** as well as from
> the moved set — a layer you cannot move must not decide where the others land — and it is the
> **participant count**, not `selectedIds.length`, that chooses artboard-relative versus
> bounding-box-relative alignment. Both are pinned by tests that produce visibly different results under
> the alternative reading.

**Pure module.** Functions from a list of frames to a list of frames: align left / horizontal-centre / right / top / middle / bottom; distribute horizontally and vertically with equal gaps. Alignment is relative to the **selection's bounding box** for a multi selection; with a **single** selection, align relative to the **artboard** (that is what a designer expects, and it makes the row useful before multi-select is even used).

**Properties:** aligning an already-aligned set is a no-op (idempotent); align-left sets every `x` equal to the bounding box's left; distribute with fewer than three frames is a no-op; distribute produces equal gaps within epsilon; rotation is **not** considered (state that explicitly — bounding boxes here are the unrotated frames, and say so in the UI's tooltip if it matters); locked layers are excluded and the rest still align.

The reducer needs one action applying a batch of frame changes as **a single undo entry** — not one per layer.

- [ ] Step 1: failing tests · [ ] Step 2: confirm red · [ ] Step 3: implement · [ ] Step 4: green · [ ] Step 5: commit

---

### Task 5: Snapping and smart guides

**Files:** create `lib/studio/snap.ts`; modify `hooks/use-layer-drag.ts`, `components/studio/canvas.tsx`; tests

**Verify first:** the `DragPreview` type at `hooks/use-layer-drag.ts:80` and how `onPreviewChange` feeds the canvas — guides must ride that existing preview channel rather than a second one.

> **Added 2026-08-11, from the Task 1+2 review.** Three places this task will fight the existing code
> unless you look before you write:
>
> 1. **Use Task 2's exported handle→anchor mapping.** Which point a handle drags and which it holds
>    fixed is now exported from `hooks/use-layer-drag.ts` rather than living inline as ternaries. Snapping
>    needs exactly that mapping to know which edge to snap during a resize. Do not re-derive it — two
>    copies will drift, and the review that prompted this note had to reconstruct the functions by hand
>    to check them.
> 2. **Decide the precedence between snapping and the modifiers, and test it.** Shift's ratio lock and
>    Alt's centre-fixed resize both constrain the frame; a snap that fires afterwards can break either.
>    State the order — modifier constrains, then snap projects along the remaining freedom, or snap wins
>    and the ratio bends — and assert it. Task 2's plan text already demands the ratio hold "within
>    epsilon"; if a snap can violate that, one of the two properties needs qualifying **here**, in the
>    plan, not in a comment.
> 3. **Say what snaps on a rotated layer.** The snap engine works in artboard space, but a rotated
>    layer's on-screen bounding box is not its frame, so "snap the left edge" is ambiguous the moment
>    `rotation !== 0`. Pick one — the unrotated frame's edges, which is cheap and matches Task 4's
>    explicitly rotation-blind bounding boxes — and write it down rather than leaving it to be
>    discovered.

**Pure snap engine.** Given the moving frame, the candidate frames (visible, unlocked siblings), the artboard size and a threshold in **screen** pixels (so it feels the same at every zoom — convert using the current scale), return the adjusted frame plus the guides that fired.

**Candidates:** sibling edges (left/right/top/bottom) and centres; the artboard's edges, centre and **thirds**; and **equal spacing** — when the moving layer sits between two siblings, snap to make the gaps equal.

**Properties:** with no candidate within threshold the frame is returned unchanged and no guide fires; a candidate just inside the threshold snaps exactly and reports one guide; two competing candidates resolve deterministically (state the rule); the threshold is in screen pixels, so the same drag at zoom 0.3 and 1.0 snaps at the same on-screen distance — this is the property most likely to be got wrong, so test it explicitly; snapping never resizes during a move, and never moves during a resize.

Guides render as thin lines with the existing preview overlay, and disappear on gesture end.

- [ ] Step 1: failing tests · [ ] Step 2: confirm red · [ ] Step 3: implement · [ ] Step 4: green, plus `studio-drag` and `studio-canvas` · [ ] Step 5: commit

---

### Task 6: The safe-area bands

**Files:** `components/studio/canvas-chrome.tsx`, `lib/studio/formats.ts` (or a new `lib/studio/safe-areas.ts`), tests

**Verify first:** `safeAreaDefaultFor(format)` and the existing toggle U1 shipped, and `FORMAT_PRESETS` at `lib/studio/formats.ts:4`.

**The bands.** Per format, the regions platform chrome covers — top and bottom on `story` and `ig_portrait` especially. Define them as **fractions of the format's height/width** in one table with a source comment per entry, because these are platform facts and a future reader must be able to check them. If you cannot establish a figure, say so and leave that format without bands rather than inventing one.

Render inside the artboard, above the layers (U1's grid learned this the hard way: `Canvas` paints last unless you order or `z-index` it), `pointer-events-none`, with a short French label.

**Properties:** bands render only when the pref is on; the pref's default per format matches `safeAreaDefaultFor`; a format with no defined bands renders none rather than a zero-height artefact; and — the lesson from U1's grid — a **composition** test proving the bands are visible above the artboard, not merely present in the markup.

- [ ] Step 1: failing tests · [ ] Step 2: confirm red · [ ] Step 3: implement · [ ] Step 4: green · [ ] Step 5: commit

---

## Self-Review

**Coverage of the roadmap's U2 line:** snapping and smart guides → Task 5; rulers and grid → already shipped by U1, nothing owed; safe areas → Task 6; the three gesture modifiers → Task 2; multi-selection with align and distribute → Tasks 3 and 4; the rotated-resize drift with a reproducing test first → Task 1.

**Ordering:** Task 1 before 2 (2 builds on the changed signature). Task 3 before 4 (align needs a multi selection to align). Task 5 after 1 and 2 so it composes with the corrected gesture maths. Task 6 is independent and last because it is the smallest.

**Deliberate omissions, so nobody adds them mid-task:** no marquee selection, no grouping, no z-index reordering beyond what the layer panel already does, no rulers/grid rework.

**The risk this plan carries:** Task 3 touches every `selectedId` reader, so its diff is wide and its test churn real. That is sequential work — do not attempt Tasks 3 and 4 in parallel.

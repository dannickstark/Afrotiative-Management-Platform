# Studio Pro · Chantier B — Interactions pros — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the editor real zoom+pan, the missing keyboard shortcuts (undo/redo, copy/paste/duplicate, select-all, escape, group/ungroup), a floating contextual toolbar, and a right-click menu — the interaction pro-ness the audit found missing.

**Architecture:** A central window-level keymap (`resolveShortcut`, pure) with a focus-guard drives editor commands; an in-session clipboard + `addLayers` reducer action powers copy/paste/duplicate; `scale = fitScale × zoomFactor` (`EditorPrefs.zoom`, finally used) with a pure `zoomModel` (clamp + zoom-to-cursor) powers the zoom-slot + shortcuts + `⌘`-wheel + space-pan; group/ungroup is a flat `groupId` on `layerBase` (no recursion) with pure selection/bounds helpers; a floating toolbar and a shadcn context-menu surface the actions.

**Tech Stack:** Next.js 16.3, Bun test, the U0 DOM harness, `EditorState` reducer (`lib/studio/editor-state.ts`), shadcn `dropdown-menu`/`popover`/`command` (context-menu to be added), Playwright (controller-driven visual verification).

## Global Constraints

- **Focus-guard is load-bearing:** the keymap must NOT fire when focus is in an input/textarea/contenteditable (else editing a number would delete/select). Tested + mutation-checked.
- **One history entry per gesture** (duplicate, paste, group, ungroup). Undo restores exactly.
- **Nothing mutates the scene outside the reducer.** All pure helpers return new values.
- **Migration no-op:** `groupId?` optional; a scene without it renders identically.
- **`lib/studio/*` client-safe & DB-free.** Pure-first; mutation is the judge; anti-vacuity; no naïve-substring / Base-UI `aria-*` traps.
- **Don't regress chantiers A (shell/responsive/zoom-slot) or D (constraints/relayout).** Constraints stay per-layer; grouping does NOT change them.
- **Visual proof is Playwright** (controller) for zoom/pan + the floating toolbar. **Implementers must NOT attempt browser/Playwright — commit + report; the controller verifies.**

---

## Task 1: Central keymap — `resolveShortcut` + undo/redo/select-all/escape

**Files:**
- Create: `lib/studio/keymap.ts` (pure)
- Create: `hooks/use-editor-keymap.ts` (window listener + focus-guard)
- Modify: `components/studio/editor-shell.tsx` (mount the keymap; it already has a window keydown for `⌘/`), `components/studio/canvas.tsx` (migrate `handleKeyDown` Delete/nudge into the keymap)
- Modify: `lib/studio/editor-state.ts` (add `selectAll` action/creator if cleaner than `select(allIds)`)
- Test: `tests/studio-keymap.test.ts`, `tests/studio-interactions.test.ts`

**Interfaces:**
- Produces: `type EditorCommand = { kind: "undo" | "redo" | "selectAll" | "deselect" | "delete" | "nudge"; ... }` (extend in later tasks); `resolveShortcut(e: {key,metaKey,ctrlKey,shiftKey}, ctx: { hasSelection: boolean; isEditingText: boolean }): EditorCommand | null`; `isEditingText(target: EventTarget|null): boolean` (input/textarea/contenteditable check).

- [ ] **Step 1: Write the failing pure test.** `resolveShortcut`: `⌘Z`→undo, `⌘⇧Z`→redo, `⌘A`→selectAll, `Escape`→deselect, `Delete`→delete, arrows→nudge; returns `null` when `isEditingText` is true for ALL of them (the focus-guard). Anti-vacuity: two distinct chords → two distinct commands; the SAME chord with `isEditingText:true` → null.

```ts
expect(resolveShortcut({key:"z",metaKey:true}, {hasSelection:true,isEditingText:false})).toEqual({kind:"undo"});
expect(resolveShortcut({key:"z",metaKey:true,shiftKey:true}, C)).toEqual({kind:"redo"});
expect(resolveShortcut({key:"a",metaKey:true}, C)).toEqual({kind:"selectAll"});
expect(resolveShortcut({key:"a",metaKey:true}, {...C,isEditingText:true})).toBeNull(); // focus-guard
```

- [ ] **Step 2: Run fail → implement** `keymap.ts` (pure) + `isEditingText`.
- [ ] **Step 3: Wire `use-editor-keymap`** — window `keydown`, computes `isEditingText(e.target)`, calls `resolveShortcut`, dispatches the mapped `EditorAction` (undo/redo/`select(allIds)`/`clearSelection()`/delete/nudge). Mount in `EditorShell`; remove the now-duplicated Delete/nudge from `canvas.tsx#handleKeyDown` (or have it delegate).
- [ ] **Step 4: DOM test (U0 harness)** — a real `⌘Z` keydown on `window` dispatches undo; a `⌘A` selects all layers; `Escape` clears; a `⌘Z` while an inspector `<input>` is focused does NOT dispatch (focus-guard). Mutation: drop the `isEditingText` guard → the focused-input test reddens.
- [ ] **Step 5: Run + commit.** `bun run test:pure`; keep interactions green. `git commit -m "feat(studio): keymap central — ⌘Z/redo/⌘A/Échap + garde du focus (chantier B T1)"`

---

## Task 2: In-session clipboard — copy / paste / duplicate

**Files:**
- Modify: `lib/studio/editor-state.ts` (add `addLayers` action; find the existing id-gen used by `addLayer`/`createLayer`/`buildShapeLayer` and reuse it)
- Create: `lib/studio/clipboard.ts` (module clipboard + `cloneLayersWithNewIds(layers, offset)`)
- Modify: `lib/studio/keymap.ts` (add `copy`/`paste`/`duplicate` commands), `hooks/use-editor-keymap.ts` (wire them)
- Test: `tests/studio-clipboard.test.ts`, `tests/studio-editor-state.test.ts`

**Interfaces:**
- Consumes: the keymap (T1), the reducer id-gen.
- Produces: `addLayers(layers: Layer[]): EditorAction` (batch, ONE history entry, appends at top of paint order); `cloneLayersWithNewIds(layers, offset:{dx,dy}): Layer[]` (fresh unique ids, frame offset, and a fresh shared `groupId` per source group so a duplicated group stays grouped — coordinate with T5's field, or leave groupId untouched until T5 and note it); a module clipboard.

- [ ] **Step 1: Write the failing test.** `cloneLayersWithNewIds` gives every clone a NEW unique id (≠ source, unique among clones) and offsets the frame; `addLayers` appends N layers in ONE history entry (undo removes all N); duplicate = copy+paste-in-place-offset selects the new layers. Anti-vacuity: paste of 0 clipboard = no-op.
- [ ] **Step 2: Run fail → implement** clipboard module + `addLayers` reducer case + the clone helper (reuse the reducer's id-gen — do NOT invent a second id scheme).
- [ ] **Step 3: Wire `⌘C`/`⌘V`/`⌘D`** through the keymap: copy snapshots the (group-expanded) selection; paste adds clones + selects them; `⌘D` = one-gesture duplicate.
- [ ] **Step 4: DOM/reducer test** — `⌘D` on a selected layer yields a 2nd layer, undo returns to 1 (one entry); `⌘C` then `⌘V` pastes offset; cross-"template" (new scene) paste works from the module clipboard. Mutation: reuse the source id in the clone → the unique-id test reddens.
- [ ] **Step 5: Run + commit.** `git commit -m "feat(studio): presse-papiers en session — copier/coller/dupliquer ⌘C/V/D, une entrée d'historique (chantier B T2)"`

---

## Task 3: Real zoom

**Files:**
- Create: `lib/studio/zoom.ts` (pure `zoomModel`)
- Modify: `components/studio/editor-shell.tsx` (`scale = fitScale × zoomFactor`; the `zoom-slot` becomes live), `components/studio/canvas-chrome.tsx` (the `zoom-chip` reads the same source), `lib/studio/editor-prefs.ts`/`hooks/use-editor-prefs.ts` (`zoom` factor already exists — persist the numeric factor), `lib/studio/keymap.ts` (`⇧0/1/2` commands)
- Test: `tests/studio-zoom.test.ts`, `tests/studio-editor-shell.test.ts`

**Interfaces:**
- Produces: `clampZoom(factor: number): number` (e.g. 0.1–8); `ZOOM_STEPS`; `nextZoom(factor, dir)`; `zoomPresetScale(kind: "fit"|"100"|"selection", fitScale, selectionBounds?, viewport?)`. `scale = fitScale × factor` (factor `"fit"` ⇒ recompute fit).

- [ ] **Step 1: Failing pure test** — `clampZoom` bounds; `nextZoom` steps through `ZOOM_STEPS`; `zoomPresetScale("100",...)` = 1/fit-relative so the artboard renders at 100%; `"selection"` frames the selection bbox in the viewport. Choice function — sweep steps + clamp edges.
- [ ] **Step 2: Run fail → implement** `zoom.ts`; make `editor-shell`'s `scale` = `fitScale × factor`; wire the `zoom-slot` (%, −/+ buttons, a dropdown Fit/100%/Selection/50-200 using `dropdown-menu`); reconcile the `zoom-chip` to read the same `scale`.
- [ ] **Step 3: Shortcuts** — `⇧0` 100%, `⇧1` fit, `⇧2` zoom-to-selection via the keymap.
- [ ] **Step 4: DOM test** — clicking + in the slot raises `scale` (the inner container's `transform: scale()` grows); Fit resets; the slot % and the chip % agree. Mutation: unbind the factor from `scale` → the zoom-in test reddens.
- [ ] **Step 5: Controller does Playwright** (zoom in/out/fit/selection visibly). Commit. `git commit -m "feat(studio): vrai zoom — scale=ajustement×facteur, contrôles du slot, ⇧0/1/2 (chantier B T3)"`

---

## Task 4: Pan + wheel-zoom-to-cursor

**Files:**
- Modify: `components/studio/canvas.tsx` / the `overflow-auto` scroll container (space-drag pan, `⌘/Ctrl`-wheel), `lib/studio/zoom.ts` (`zoomAtCursor`)
- Test: `tests/studio-zoom.test.ts`, `tests/studio-interactions.test.ts`

**Interfaces:**
- Produces: `zoomAtCursor(prevScale, nextScale, cursor:{x,y}, scroll:{x,y}, viewport): { scale, scroll:{x,y} }` — the pure choice function that keeps the canvas point under the cursor fixed while zooming.

- [ ] **Step 1: Failing pure test** — `zoomAtCursor`: the canvas coordinate under the cursor before == after (fixed point) across a zoom change; continuity (a tiny scale delta → tiny scroll delta, no jump). This is the U2-style choice-function sweep — assert the fixed point EXACTLY and continuity across a range.
- [ ] **Step 2: Run fail → implement** `zoomAtCursor`; wire `⌘/Ctrl`-wheel on the canvas to zoom-at-cursor (adjust scroll); plain wheel = pan (native scroll); `Space`-hold changes cursor to grab and drag pans (adjust scrollLeft/Top); trackpad pinch = zoom-at-cursor.
- [ ] **Step 3: DOM test** — a `⌘`-wheel event zooms and keeps the pointed point fixed (assert scroll adjusted); `Space`+drag changes scroll without moving layers. Mutation: drop the scroll adjustment in `zoomAtCursor` → the fixed-point test reddens (the point drifts).
- [ ] **Step 4: Controller Playwright** (⌘-scroll zoom-to-cursor + space-pan). Commit. `git commit -m "feat(studio): pan (Espace-glisser) + zoom molette centré curseur (chantier B T4)"`

---

## Task 5: Group / ungroup — flat `groupId`

**Files:**
- Modify: `lib/studio/scene.ts` (`groupId?: string` on `layerBase`; no-op migration), `lib/studio/editor-state.ts` (`setGroup` action)
- Create: `lib/studio/groups.ts` (pure `expandSelectionToGroups`, `groupBounds`, `nextGroupId`)
- Modify: `components/studio/canvas.tsx` (member-click selects the group), `components/studio/layer-panel.tsx` (group node), `lib/studio/keymap.ts` (`⌘G`/`⌘⇧G`)
- Test: `tests/studio-groups.test.ts`, `tests/studio-scene.test.ts`, `tests/studio-editor-state.test.ts`, `tests/studio-layer-panel.test.ts`

**Interfaces:**
- Produces: `layer.groupId?: string`; `setGroup(ids, groupId: string | null): EditorAction` (one history entry); `expandSelectionToGroups(ids, scene): string[]` (adds all co-`groupId` members); `groupBounds(layers): Frame`.

- [ ] **Step 1: Failing tests.** Schema: `groupId?` optional, absent = no-op (round-trips deep-equal; required → a no-field scene fails, proving optionality). `expandSelectionToGroups`: selecting one member returns all co-group members; a lone layer returns itself. `setGroup(ids, id)` assigns; `setGroup(members, null)` ungroups; both one history entry. `groupBounds` = members' bbox.
- [ ] **Step 2: Run fail → implement** the schema field, `setGroup`, and the pure helpers.
- [ ] **Step 3: Wire selection + drag + panel** — a click on a member dispatches `select(expandSelectionToGroups([id], scene))`; group-drag already moves multi-selection (verify a whole group moves together); the layer panel renders a collapsible group node grouping members; `⌘G`/`⌘⇧G` via keymap. State the constraints-untouched invariant (D) in a comment + a test that grouping doesn't change any layer's `constraints`.
- [ ] **Step 4: Mutation** — `expandSelectionToGroups` returns only the clicked id → the "select a member selects the group" test reddens; drop the one-history-entry on `setGroup` → the undo test reddens.
- [ ] **Step 5: Run + commit.** `git commit -m "feat(studio): groupe/dégroupe — modèle groupId plat, sélection+glisser de groupe, ⌘G/⌘⇧G (chantier B T5)"`

---

## Task 6: Floating contextual toolbar

**Files:**
- Create: `lib/studio/toolbar-actions.ts` (pure `toolbarActionsFor`), `components/studio/floating-toolbar.tsx`
- Modify: `components/studio/canvas.tsx` (render the toolbar anchored above the selection, in the scaled container, hidden during drag/resize)
- Test: `tests/studio-floating-toolbar.test.ts`

**Interfaces:**
- Consumes: `groupBounds` (T5) for multi/group anchoring; the reducer actions + clipboard.
- Produces: `toolbarActionsFor(selection: Layer[]): ToolbarAction[]` — per-type quick actions (text→font/size/colour/bold; shape→fill/border; image→replace/fit; qr→slot) + common (duplicate/delete/lock/order/group). A `FloatingToolbar` anchored above the selection bbox, `1/scale`-compensated, `pointer-events` only on itself.

- [ ] **Step 1: Failing pure test** — `toolbarActionsFor` returns the right action set per type and the common actions; a multi-selection returns only the common set; empty selection → `[]`. Anti-vacuity: a text layer's set ≠ a shape layer's set.
- [ ] **Step 2: Run fail → implement** `toolbarActionsFor` + `FloatingToolbar` anchored above `groupBounds(selection)` in the scaled container (like U4's binding overlay: template coords, `1/scale` sizing), hidden while `preview` (drag/resize) is active.
- [ ] **Step 3: DOM test (U0 harness)** — a selected text layer shows the text toolbar above it (a SIBLING in the scaled container, not obscuring, `pointer-events-none` container with interactive buttons); clicking "duplicate" dispatches; no toolbar while dragging. Assert composition (U1 lesson). Mutation: return the same set for all types → the per-type test reddens.
- [ ] **Step 4: Controller Playwright.** Commit. `git commit -m "feat(studio): barre contextuelle flottante — actions rapides par type au-dessus de la sélection (chantier B T6)"`

---

## Task 7: Right-click context menu

**Files:**
- Create: `components/ui/context-menu.tsx` (the shadcn/Base-UI context-menu primitive), `components/studio/canvas-context-menu.tsx`
- Modify: `components/studio/canvas.tsx` (wrap the canvas/layers; right-click selects the target first)
- Test: `tests/studio-context-menu.test.ts`

**Interfaces:**
- Consumes: the reducer actions (reorder/lock/hide/delete), clipboard (T2), group (T5).
- Produces: a context menu on a layer body + canvas: Copier/Coller/Dupliquer, Supprimer, Avancer/Reculer (`reorderLayer`), Verrouiller/Masquer (`toggleLocked`/`toggleVisible`), Grouper/Dégrouper. Right-click selects the target first.

- [ ] **Step 1: Add the `context-menu` primitive** (Base UI / shadcn form used by the repo — mirror `dropdown-menu.tsx`'s structure). Failing test: the menu items map to the right actions; a right-click on a layer selects it then opens the menu with its actions; right-click on empty canvas shows paste/select-all only.
- [ ] **Step 2: Run fail → implement** the primitive + `canvas-context-menu.tsx`; wire on the canvas. Right-click selects the target (U3 lesson: a right-click on a LOCKED layer — pointer-events:none — falls through to the canvas; state + test it).
- [ ] **Step 3: DOM test (U0 harness)** — right-click a layer → it's selected, menu shows Dupliquer/Supprimer/Grouper etc.; clicking Dupliquer dispatches; assert accessible state (Base-UI `aria-*`, not substrings). Mutation: point a menu item at the wrong action → the test reddens.
- [ ] **Step 4: Run + commit.** `git commit -m "feat(studio): menu clic-droit — copier/dupliquer/ordre/verrou/grouper, sélection à la cible (chantier B T7)"`

---

## Self-review

**Spec coverage:** §1 zoom → T3, pan → T4; §2 keymap → T1; §3 clipboard → T2; §4 floating toolbar → T6; §5 context menu → T7; §6 group/ungroup → T5. Focus-guard → T1. Constraints-untouched invariant → T5 Step 3. All spec sections mapped.

**Placeholder scan:** no TBD/TODO; each pure function has concrete test intent + the wiring names real files/actions. The id-gen reuse (T2) points at the existing reducer mechanism rather than inventing one — the implementer must locate it (`createLayer`/`buildShapeLayer`).

**Type consistency:** `resolveShortcut`/`EditorCommand`/`isEditingText` (T1) extended by T2/T3 (copy/paste/duplicate, `⇧0/1/2`) and T5 (`⌘G`); `zoomModel`/`clampZoom`/`zoomAtCursor` (T3/T4); `addLayers`/`cloneLayersWithNewIds` (T2); `groupId`/`setGroup`/`expandSelectionToGroups`/`groupBounds` (T5) consumed by T6; `toolbarActionsFor` (T6). Names consistent across tasks.

**Ordering:** T1 (keymap) is the socle T2/T3/T5 extend; T2 (clipboard) independent of zoom; T3 (zoom) → T4 (pan needs the zoom model); T5 (group) → T6 (toolbar anchors on group bounds) → T7 (menu reuses clipboard+group). Each ends with an independently testable + (for visual tasks) screenshot-verifiable deliverable.

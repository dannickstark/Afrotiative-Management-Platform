# U0 — Harnais DOM — Spec & Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give this repo a DOM test harness, then use it to close the five interaction seams U1 shipped uncovered — so that a mutation in a click handler or an effect dependency stops leaving the suite green.

**Architecture:** `jsdom` and `@types/jsdom` are already dependencies and unused. React 19 exports `act`, and `react-dom/client` provides `createRoot`. So the harness needs **zero new dependencies**: one opt-in module that installs jsdom globals for the calling file, mounts a component, fires real events, and tears down.

**Tech Stack:** Bun test · jsdom 30 · React 19 `act` · `react-dom/client`

**Spec + plan combined** in this one document, following `2026-08-10-afrotiative-d2-d3-meta.md`'s precedent: the design question here is small and settled (see §1), so a separate spec would be ceremony.

**Programme:** `docs/superpowers/specs/2026-08-10-afrotiative-studio-ux-roadmap.md` — this is the "installer un harnais DOM" item its U1 debt table names as a serious candidate before U2.

---

## 1. Why opt-in, and not a global preload

`bunfig.toml` preloads `test-setup.ts` for every test file. Installing `window`/`document` there would be the shortest path and the wrong one: it flips `typeof window === "undefined"` across the whole codebase. Concretely, `hooks/use-editor-prefs.ts` guards its `localStorage` read on exactly that check, `lib/studio/config.ts` and the R2/WordPress config helpers branch on server-ness, and Next's own server components assume no DOM. A global DOM would silently change which branch ~1300 existing tests exercise.

So: **a file opts in explicitly**, gets a DOM for its duration, and returns the process to its previous state afterwards. Files that don't opt in are untouched.

## 2. What the harness must do

- Install `window`, `document`, `navigator`, `HTMLElement`, `Node`, `Event`, `KeyboardEvent`, `MouseEvent`, `IntersectionObserver` (a stub — `render-mode.tsx`'s filmstrip needs it) and `localStorage` onto `globalThis`, and restore/delete them on teardown.
- Mount a React element into a detached container and return the container plus an unmount.
- Wrap mount, unmount and every event dispatch in React 19's `act` so effects flush.
- Fire genuine events — a real `click` that bubbles, a real `keydown` with modifiers — not a direct handler call. **Calling a handler directly is what the five uncovered seams already fail to catch**; the point of this harness is that the wiring is exercised.

## 3. The five seams to close (spec §2's whole purpose)

From U1's final review, each currently mutation-survivable:

| Seam | File | What a test must prove |
|---|---|---|
| Images `onPick` | `components/studio/panels/images-panel.tsx` | clicking an asset dispatches the assignment to the selected image layer |
| Styles tile `onClick` | `components/studio/panels/texte-panel.tsx` | clicking a preset inserts an unbound text layer |
| Token row `onClick` | `components/studio/panels/texte-panel.tsx` | clicking an available row inserts a bound layer; clicking an `aria-disabled` row inserts nothing |
| `⌘/` keydown registration | `components/studio/editor-shell.tsx` | the listener is actually attached and the shortcut toggles the panel |
| scale effect's `prefs.rulers` dep | `components/studio/editor-shell.tsx` | toggling rulers re-runs the scale computation |

## Global Constraints

- **Read the Next.js docs** under `node_modules/next/dist/docs/01-app/` before touching a page or Server Action — `AGENTS.md` requires it. This sub-project should need neither.
- **Never install DOM globals in `test-setup.ts` or `bunfig.toml`.** Opt-in only — §1 is the reason, and a violation silently changes ~1300 tests.
- **No new dependencies.** `jsdom`, `@types/jsdom`, React 19's `act` and `react-dom/client` are all present.
- **`tests/publish-due.test.ts` and `tests/wp-publish.test.ts` must stay green and unmodified.**
- **Do not weaken or delete an existing assertion.** Where a `renderToStaticMarkup` test already covers static output, **leave it** and add the interaction test beside it — static-markup tests are faster and still catch what they were written for.
- **Never run two `bun test` invocations at once** (`test-setup.ts:38-40`); **foreground only**, never backgrounded or monitored.
- **A full-suite count is not reproducible on this repo.** Run focused files; if one fails, re-run it alone before concluding anything.
- **Three suite failures are pre-existing:** `tests/pipeline-web-search.test.ts` (a) and (d), `tests/pipeline-pause-resume.test.ts` pause checkpoint (b).
- Commit messages in **French**, prefix `test(studio):` for this sub-project, ending with:
  `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`

---

### Task 1: The harness itself

**Files:** create `tests/dom-harness.ts`, `tests/dom-harness.test.ts`

**Interfaces produced:**

```ts
// tests/dom-harness.ts
export function installDom(): () => void;          // returns teardown; restores prior globals exactly
export type Mounted = { container: HTMLElement; unmount: () => void };
export async function mount(element: React.ReactElement): Promise<Mounted>;
export async function click(el: Element): Promise<void>;                     // real bubbling MouseEvent, wrapped in act
export async function pressKey(init: KeyboardEventInit): Promise<void>;      // dispatched on document, wrapped in act
export async function flush(): Promise<void>;                                // act(async () => {}) — lets effects settle
```

- [ ] **Step 1: Write the failing tests**

```ts
// tests/dom-harness.test.ts
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { installDom, mount, click, pressKey, flush } from "./dom-harness";
import * as React from "react";

let teardown: () => void;
beforeAll(() => { teardown = installDom(); });
afterAll(() => { teardown(); });

describe("the harness itself", () => {
  it("gives a document and cleans up after itself", () => {
    expect(typeof globalThis.document).toBe("object");
  });

  it("mounts a component and runs its effects", async () => {
    const seen: string[] = [];
    function Probe() {
      React.useEffect(() => { seen.push("effect"); }, []);
      return React.createElement("p", null, "bonjour");
    }
    const { container, unmount } = await mount(React.createElement(Probe));
    expect(container.textContent).toBe("bonjour");
    expect(seen).toEqual(["effect"]);   // the point: effects actually ran
    unmount();
  });

  it("fires a REAL click that reaches an onClick prop", async () => {
    let clicks = 0;
    function Probe() {
      return React.createElement("button", { onClick: () => { clicks += 1; } }, "ok");
    }
    const { container, unmount } = await mount(React.createElement(Probe));
    await click(container.querySelector("button")!);
    expect(clicks).toBe(1);   // would fail if the harness called the prop directly instead of dispatching
    unmount();
  });

  it("fires a keydown with modifiers that reaches a document listener", async () => {
    const hits: string[] = [];
    function Probe() {
      React.useEffect(() => {
        const h = (e: KeyboardEvent) => { if (e.key === "/" && e.metaKey) hits.push("shortcut"); };
        document.addEventListener("keydown", h);
        return () => document.removeEventListener("keydown", h);
      }, []);
      return null;
    }
    const { unmount } = await mount(React.createElement(Probe));
    await pressKey({ key: "/", metaKey: true });
    expect(hits).toEqual(["shortcut"]);
    unmount();
  });

  it("does NOT leak globals to a file that never opted in", () => {
    const t = installDom();
    t();
    // after teardown the DOM globals are gone or restored to their pre-install value
    expect(typeof (globalThis as Record<string, unknown>).document === "object" && teardown !== undefined).toBe(true);
  });
});
```

> **Note for the implementer.** That last test as written is muddled — this file has a DOM installed for its whole duration via `beforeAll`, so it cannot cleanly observe teardown-to-undefined. **Rewrite it** so it proves the real property: `installDom()` followed by its teardown restores `globalThis` to exactly the keys it had before (compare a snapshot of the relevant key set, or run the check in a file that does *not* install in `beforeAll`). Say in your report what you changed and why. Five of U1's plan snippets were defective; assume this one is too rather than trusting it.

- [ ] **Step 2: Run and confirm failure.** Run: `bun test tests/dom-harness.test.ts` — FAIL, module absent.

- [ ] **Step 3: Implement `tests/dom-harness.ts`.** Snapshot the globals you overwrite so teardown restores rather than blindly deletes. Stub `IntersectionObserver` with a constructor recording its callback and no-op `observe`/`unobserve`/`disconnect` — `render-mode.tsx` needs it to exist, and a later task may want to trigger it.

- [ ] **Step 4: Run and confirm passing.** Run: `bun test tests/dom-harness.test.ts`, then `bun test tests/studio-editor-prefs.test.ts` to confirm a non-opting file is unaffected.

- [ ] **Step 5: Commit.**

```bash
git add tests/dom-harness.ts tests/dom-harness.test.ts
git commit   # test(studio): harnais DOM optionnel, sans nouvelle dépendance
```

---

### Task 2: Close the five seams

**Files:** create `tests/studio-interactions.test.ts`; modify none of the components unless a seam turns out to be genuinely broken — in which case **stop and report** before changing behaviour.

**Interfaces consumed:** Task 1's harness; the real `editorReducer` / `initEditorState` from `lib/studio/editor-state.ts`; the real panels and `EditorShell`.

Read §3's table. One test per seam, each driving the **real** component through a **real** event.

- [ ] **Step 1: Write the failing tests** — one `describe` per seam. Each must assert an observable consequence, not that a function was called:
  - Images: mount `ImagesPanel` with a scene whose selected layer is an image, click an asset tile, assert the scene's image layer now references that asset. Then with a text layer selected, assert the picker trigger carries a real `disabled` attribute and clicking dispatches nothing.
  - Styles: mount `TextePanel`, click the « Titre » preset, assert one text layer was added whose content contains no `{{`.
  - Token rows: click « Titre de l'article », assert a layer bound to `{{article.title}}`; click an `aria-disabled` row, assert the layer count is unchanged.
  - `⌘/`: mount `EditorShell` with a panel open, `pressKey({ key: "/", metaKey: true })`, assert the panel collapses; press again, assert it restores the **same** panel.
  - Rulers/scale: mount `EditorShell`, record the artboard's rendered size, toggle rulers, assert the size changed — the property that `prefs.rulers` is in the effect's dependency list.

- [ ] **Step 2: Run and confirm which fail and why.** Run: `bun test tests/studio-interactions.test.ts`. **Expect some to pass immediately** — the seams are uncovered, not necessarily broken. A seam that passes on the first run is still worth the test: it is now protected. **A seam that fails is a real bug U1 shipped** — report it, do not silently fix the component.

- [ ] **Step 3: Make the tests correct.** If a test fails because the test is wrong, fix the test. If it fails because the component is wrong, **stop and report** with the evidence.

- [ ] **Step 4: Run and confirm passing.** Run: `bun test tests/studio-interactions.test.ts tests/studio-texte-panel.test.ts tests/studio-editor-shell.test.ts` — the existing static tests must stay green and unmodified.

- [ ] **Step 5: Commit.**

```bash
git add tests/studio-interactions.test.ts
git commit   # test(studio): ferme les cinq coutures d'interaction laissées par U1
```

---

## Self-Review

**Coverage:** §1's opt-in rationale → Task 1's Step 3 and the Global Constraint forbidding a global install. §2's harness capabilities → Task 1's interface and tests. §3's five seams → Task 2, one `describe` each.

**Placeholder scan:** none. Task 1's last test is deliberately marked as defective with instructions to rewrite it — that is a warning, not a placeholder.

**Type consistency:** `installDom`, `mount`, `click`, `pressKey`, `flush` and `Mounted` are named identically in Task 1's interface, its tests, and Task 2's consumption.

**Risk this plan carries:** a DOM harness invites converting existing `renderToStaticMarkup` tests wholesale. Don't. Those are faster and still correct for static output; the Global Constraints forbid weakening them, and the value here is the five seams, not uniformity.

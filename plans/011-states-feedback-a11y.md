# Plan 011: States & feedback — empty states, loading skeletons, responsive tables, a11y

> **Executor instructions**: Follow step by step; run each verification. STOP conditions halt you. This plan has independent parts (A–E) — you may land them in separate commits. Update this plan's row in `plans/README.md` when done.
>
> **Drift check (run first)**: `git diff --stat d0fd009..HEAD -- components app` for the Scope files — on change, re-verify.

## Status
- **Priority**: P1 · **Effort**: M · **Risk**: LOW · **Depends on**: none · **Category**: ui/a11y
- **Planned at**: commit `d0fd009`, 2026-08-12

## Why this matters

The emptiest, most-templated moments are the first-run experience (no feeds/members/runs → a flat gray
"Aucun…") and route transitions (one dashboard-shaped skeleton flashes on every route). Fixing these plus
responsive tables and icon-button labels is what separates "polished product" from "starter template."

## Current state
- **Empty states:** `components/dashboard/empty-state.tsx` exists (icon + title + hint) but is used only by the dashboard lists. Table empties are bare: `components/settings/feeds-table.tsx:94` "Aucune source configurée.", `members-table.tsx:53`, `taxonomy-tables.tsx:96`, `runs-view.tsx:138`.
- **Loading:** exactly one `app/(app)/loading.tsx` — dashboard-shaped (title skeleton + 4 stat cards + 2 lists). App Router bubbles it, so Queue/Settings/Studio flash a stat-card skeleton that matches nothing.
- **Tables:** `feeds-table.tsx:76` etc. render `<Table>` with no `overflow-x-auto` wrapper; `<main>` is `overflow-hidden` (`app/(app)/layout.tsx:41`) → wide tables clip on narrow viewports.
- **A11y:** exactly one `sr-only` in the app; `components/article/image-panel.tsx:313` is an icon-only Button with no `aria-label`. `StatusBadge` (`components/status-badge.tsx`) uses `bg-token/15 text-token border-token/30` + a text label (not color-only — good), but low-chroma statuses' contrast is unverified.

**Convention:** French copy; lucide icons; `Skeleton` from `@/components/ui/skeleton`.

## Commands
| Purpose | Command | Expected |
|---|---|---|
| Typecheck | `bun run typecheck` | no new errors |
| Empty-state test | `bun test tests/empty-state.test.ts` | pass |
| Pure lane | `bun run test:pure` | pass |

## Scope
**In scope:** promote `components/dashboard/empty-state.tsx` → shared (`components/shell/empty-state.tsx`) with an optional `action` slot and `icon` prop; adopt it in the table empties; add per-route `loading.tsx`; wrap tables in `overflow-x-auto`; add `aria-label`s to icon-only buttons; measure status-badge contrast.
**Out of scope:** `components/studio/**` and `app/(app)/studio/**` (owned by a separate process — no studio loading skeletons, no studio a11y sweep); redesigning the tables' columns; changing data queries.

## Steps
### Part A — Shared EmptyState with an action
1. Move `empty-state.tsx` to `components/shell/empty-state.tsx` (or keep the path and generalize). Extend props: `{ icon?: ReactNode; title: string; hint?: string; action?: ReactNode }`. Update the two dashboard importers.
2. Add `tests/empty-state.test.ts` (SSR): renders title; renders hint; renders action node; default icon. Register in `PURE_FILES`.
**Verify**: `bun test tests/empty-state.test.ts` → pass; `bun run typecheck` → green.

### Part B — Adopt in table empties (with CTAs)
For `feeds-table.tsx`, `members-table.tsx`, `taxonomy-tables.tsx`, `runs-view.tsx`: replace the bare "Aucun…" cell/paragraph with the shared `EmptyState`, passing the page's existing add-action as `action` where one exists (e.g. "Ajouter une source"). Keep the `runs-view` distinction between "no runs" and "no match".
**Verify**: `bun run dev` → empty tables show a real empty state with a CTA; `bun run typecheck` → green.

### Part C — Per-route loading skeletons (NON-studio routes only)
Add `loading.tsx` to the non-studio routes whose shape differs from the dashboard: `app/(app)/queue/`, `published/`, `runs/`, `settings/` (a generic table skeleton), and `article/[id]/` (an editor skeleton). Each renders `Skeleton`s roughly matching that page (a table skeleton = a title bar + N full-width rows). Keep the dashboard's existing one. **Do NOT add `app/(app)/studio/**/loading.tsx`** — the studio routes are owned by a separate process.
**Verify**: `bun run dev`, navigate between the non-studio routes → the skeleton resembles the destination, not stat cards.

### Part D — Responsive tables
Wrap each data `<Table>` in `<div className="overflow-x-auto">` (feeds, members, taxonomy, queue, published, runs). Reconsider the `overflow-hidden` on `<main>` (`app/(app)/layout.tsx:41`) — if removing it breaks the fixed-header scroll model (documented in `app/layout.tsx`), keep it and rely on the per-table `overflow-x-auto` wrapper instead.
**Verify**: resize `bun run dev` to a narrow width → tables scroll horizontally instead of clipping.

### Part E — a11y labels + contrast check (excluding `components/studio/**`)
1. Add `aria-label` (French) to every icon-only Button lacking one **outside `components/studio/**`** — start with `components/article/image-panel.tsx:313`; grep `size="icon"` across `components` (excluding `components/studio`) and add labels where the accessible name isn't already provided by a tooltip/`title`. Leave studio icon buttons to the studio process.
2. Measure `StatusBadge` text/background contrast for each status in light and dark (the `/15` fill + same-hue text). Where a status fails WCAG AA for its label size, bump text lightness or fill opacity in `components/status-badge.tsx`. This is an *investigate-then-fix* step — only change tokens that actually fail.
**Verify**: `grep -rn 'size="icon"' components` → each result has an `aria-label` or a labelled tooltip; record the contrast findings in the commit message.

## Test plan
- `tests/empty-state.test.ts` (pure): title/hint/action/icon rendering.
- Keep existing settings/queue tests green after adopting EmptyState (they assert content).
- Loading/responsive/a11y are visual/manual — verify in `bun run dev`; no unit test required.

## Done criteria (ALL)
- [ ] Shared `EmptyState` with an `action` slot, used by dashboard AND the table empties
- [ ] Per-route `loading.tsx` for queue/published/runs/settings/article (NOT studio)
- [ ] Data tables wrapped in `overflow-x-auto` (no clipping on narrow width)
- [ ] Every non-studio `size="icon"` button has an accessible name; `image-panel.tsx:313` fixed
- [ ] Status-badge contrast checked; failing tokens adjusted (or recorded as passing)
- [ ] `tests/empty-state.test.ts` passes, registered in `PURE_FILES`; `test:pure` + typecheck green
- [ ] `plans/README.md` row 011 → DONE

## STOP conditions
- If removing `overflow-hidden` from `<main>` reintroduces the scrolling-header bug documented in `app/layout.tsx`, STOP that sub-change and use per-table wrappers only.

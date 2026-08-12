# Plan 008: One shared `PageHeader`, adopted across every page

> **Executor instructions**: Follow step by step; run each verification. STOP conditions halt you. Update this plan's row in `plans/README.md` when done.
>
> **Drift check (run first)**: `git diff --stat d0fd009..HEAD -- components app` for the files listed in Scope — on change, re-verify.

## Status
- **Priority**: P1 · **Effort**: M · **Risk**: LOW · **Depends on**: plan 007 (type scale) · **Category**: ui
- **Planned at**: commit `d0fd009`, 2026-08-12

## Why this matters

The same title-plus-action row (`flex items-center justify-between` + `<h1 className="text-xl font-semibold">`)
is hand-rolled in ~15 files, and they've already drifted (some have a count, some an action, some neither;
page rhythm alternates `space-y-6`/`space-y-4`). That mechanical duplication is the root of the
"every page looks hand-assembled" feel. One `PageHeader` component fixes the flat type scale, the spacing
drift, and the inconsistent action placement in a single place — and gives the serif title a home.

## Current state
- Example of the repeated pattern — `app/(app)/dashboard/page.tsx:24`: `<h1 className="text-xl font-semibold">Tableau de bord</h1>`.
- ~12 in-scope sites (from audit): `components/queue/queue-view.tsx:15`, `components/published/published-view.tsx:17`,
  `components/pipeline/runs-view.tsx:97`, `components/settings/{feeds-table,members-table,social-channels,pipeline-settings-form,integration-cards,taxonomy-tables}.tsx`, and the dashboard.
- **EXCLUDED (owned by the studio process — do NOT touch):** `components/studio/{asset-library,manual-generate,templates-table}.tsx`. The studio list pages keep their own headers; the studio process will adopt `PageHeader` there if it wants.
- No `PageHeader`/`page-header` component exists (grep confirms).
- App header (`app/(app)/layout.tsx:31-40`) holds only breadcrumbs + bell; the page title lives in the body.

**Convention:** feature components import primitives from `@/components/ui/*`; French copy; the page body
root is a `div` with `space-y-*`. Match the existing import style.

## Commands
| Purpose | Command | Expected |
|---|---|---|
| Typecheck | `bun run typecheck` | no new errors |
| Component test | `bun test tests/page-header.test.ts` | pass |
| Pure lane | `bun run test:pure` | pass incl. new file |
| Regression | `bun test tests/settings-rbac.test.ts tests/diffusion-settings-ui.test.ts` | pass |

## Scope
**In scope:** create `components/shell/page-header.tsx` + `tests/page-header.test.ts` (register in `PURE_FILES`);
convert the ~12 non-studio title rows to use it (list above). Do this **incrementally** — one file per step is fine.
**Out of scope:** `components/studio/**` (owned by a separate process — leave studio headers alone); changing what actions/counts each page shows (preserve current content, only reshape the container); the app-layout header; any data/logic.

## Steps
### Step 1: Build the component (TDD)
Create `components/shell/page-header.tsx`:
```tsx
import type { ReactNode } from "react";

export function PageHeader({ title, description, actions }: { title: string; description?: string; actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div className="space-y-1">
        <h1 className="font-heading text-2xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}
```
Create `tests/page-header.test.ts` (SSR render like `tests/diffusion-settings-ui.test.ts`): renders the
title; renders description when given; renders actions node; is safe with no description/actions. Register
`"page-header.test.ts"` in `PURE_FILES`.
**Verify**: `bun test tests/page-header.test.ts` → pass; `bun run typecheck` → no new errors.

### Step 2: Adopt on the dashboard (reference conversion)
Replace `app/(app)/dashboard/page.tsx:24`’s `<h1>` with `<PageHeader title="Tableau de bord" description="Vue d'ensemble de la production éditoriale." />`. Keep the page root `space-y-6`.
**Verify**: `bun run typecheck` → green; `bun run dev` → dashboard title is serif, larger, with a subtitle.

### Step 3: Convert the remaining ~11 non-studio sites, one at a time
For each file in Scope (NOT `components/studio/**`), replace its ad-hoc title row with `<PageHeader …>`,
moving any existing right-side Button/count into the `actions` slot. Preserve the page's existing action(s)
and any count (render the count as a small `text-muted-foreground` span inside `actions`, or fold it into
`description`). Standardize each page body root to `space-y-6`.
**Verify after each**: `bun run typecheck` → green. After all: `bun run dev` and click through pages — titles are consistent.

### Step 4: Regression
**Verify**: `bun test tests/settings-rbac.test.ts tests/diffusion-settings-ui.test.ts` → pass; `bun run test:pure` → pass; `grep -rn 'text-xl font-semibold' components app | grep -i 'h1' | grep -v '/studio/'` → no non-studio page-title matches remain.

## Test plan
- `tests/page-header.test.ts` (pure): title/description/actions rendering. Model after `tests/diffusion-settings-ui.test.ts`.
- Existing settings/queue UI tests must stay green (they assert content, which is preserved).

## Done criteria (ALL)
- [ ] `components/shell/page-header.tsx` exists with the props `{ title, description?, actions? }`
- [ ] All ~11 non-studio title rows use `PageHeader`; no non-studio page-level `<h1 className="text-xl font-semibold">` remains (studio pages intentionally untouched)
- [ ] `tests/page-header.test.ts` passes, registered in `PURE_FILES`
- [ ] `bun run test:pure`, `bun run typecheck`, and the regression tests → green
- [ ] `plans/README.md` row 008 → DONE

## STOP conditions
- If a page's header is structurally entangled with a filter bar or tabs (not a plain title row), STOP and report that page; convert only the title portion, leave the rest.
- If moving a count/action into `actions` changes behavior (e.g. an action that depended on layout position), STOP and report.

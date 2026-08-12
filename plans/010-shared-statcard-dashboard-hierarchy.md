# Plan 010: Shared `StatCard` primitive + dashboard hierarchy

> **Executor instructions**: Follow step by step; run each verification. STOP conditions halt you. Update this plan's row in `plans/README.md` when done.
>
> **Drift check (run first)**: `git diff --stat d0fd009..HEAD -- components/dashboard/summary-cards.tsx components/pipeline/run-trends.tsx` — on change, re-verify.

## Status
- **Priority**: P1 · **Effort**: M · **Risk**: LOW · **Depends on**: plan 007 · **Category**: ui
- **Planned at**: commit `d0fd009`, 2026-08-12

## Why this matters

Two divergent stat-tile implementations already exist (dashboard `text-2xl` in a `Card` vs pipeline
`text-xl` in a bordered `div`), so metrics look different depending on the page. And the dashboard is the
canonical "four identical muted cards" AI-dashboard layout with no hierarchy between the metric that needs
action and the rest. One shared `StatCard` primitive + a dominant primary metric makes the dashboard feel
designed instead of templated, and unifies KPIs app-wide.

## Current state
- `components/dashboard/summary-cards.tsx:11-23` — 4 identical `Card`s, `text-2xl font-semibold` value, `text-sm text-muted-foreground` label; accent/alert applied via `text-[var(--accent-brand)]`/`text-[var(--status-error)]`.
- `components/pipeline/run-trends.tsx:71-79` — `StatTile({label,value})`: bordered `div`, `text-xl font-semibold` value, `text-xs` label. Same concept, different look.

**Convention:** shadcn `Card`; French labels; status/accent via the `*-brand`/`status-*` tokens (see plan 009 for utilities).

## Commands
| Purpose | Command | Expected |
|---|---|---|
| Typecheck | `bun run typecheck` | no new errors |
| Component test | `bun test tests/stat-card.test.ts` | pass |
| Pure lane | `bun run test:pure` | pass incl. new file |
| Dashboard test | `bun test tests/*dashboard* 2>/dev/null || true` | pass if any |

## Scope
**In scope:** create `components/ui/stat-card.tsx` (or `components/shell/stat-card.tsx`) + `tests/stat-card.test.ts` (register in `PURE_FILES`); refactor `summary-cards.tsx` and `run-trends.tsx`’s `StatTile` to use it; give the dashboard's primary metric ("En attente de revue") visual dominance.
**Out of scope:** adding charts/sparklines (nice-to-have, not required); changing the dashboard data queries.

## Steps
### Step 1: Build `StatCard` (TDD)
Create `components/ui/stat-card.tsx`:
```tsx
import { Card, CardContent } from "@/components/ui/card";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function StatCard({ label, value, sub, tone = "default", icon, emphasis = false }: {
  label: string; value: ReactNode; sub?: ReactNode;
  tone?: "default" | "accent" | "alert"; icon?: ReactNode; emphasis?: boolean;
}) {
  const valueTone = tone === "alert" ? "text-[var(--status-error)]" : tone === "accent" ? "text-accent-brand" : "";
  return (
    <Card className={cn(emphasis && "ring-1 ring-accent-brand/30")}>
      <CardContent className="pt-6">
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted-foreground">{label}</p>
          {icon && <span className="text-muted-foreground">{icon}</span>}
        </div>
        <div className={cn("mt-2 font-semibold tabular-nums", emphasis ? "text-3xl" : "text-2xl", valueTone)}>{value}</div>
        {sub && <p className="mt-1 text-xs text-muted-foreground">{sub}</p>}
      </CardContent>
    </Card>
  );
}
```
Create `tests/stat-card.test.ts` (SSR render): renders label+value; applies alert/accent tone class; renders sub; emphasis adds the ring. Register in `PURE_FILES`.
**Verify**: `bun test tests/stat-card.test.ts` → pass; `bun run typecheck` → green.

### Step 2: Refactor the dashboard summary cards
Rewrite `components/dashboard/summary-cards.tsx` to map its 4 cards through `StatCard`. Set `emphasis` + `tone="accent"` on "En attente de revue" when `pendingCount > 0`, `tone="alert"` on "Exécutions en échec (24 h)" when > 0. Add a lucide icon per card (e.g. `Inbox`, `AlertTriangle`, `Newspaper`, `Clock`).
**Verify**: `bun run typecheck` → green; `bun run dev` → the "needs review" metric visibly dominates.

### Step 3: Unify the pipeline `StatTile`
Replace `run-trends.tsx`’s local `StatTile` with `StatCard` (or have `StatTile` delegate to it). Keep its current values/labels.
**Verify**: `bun run typecheck` → green; `grep -rn "text-xl font-semibold text-foreground" components/pipeline/run-trends.tsx` → gone.

### Step 4: Gate
**Verify**: `bun run test:pure` → pass; `bun run typecheck` → green.

## Test plan
- `tests/stat-card.test.ts` (pure): label/value/sub render, tone classes, emphasis ring. Model after existing SSR component tests.
- Keep any dashboard/run-trends tests green.

## Done criteria (ALL)
- [ ] `StatCard` exists and is used by BOTH `summary-cards.tsx` and `run-trends.tsx`
- [ ] Dashboard primary metric has visual emphasis (larger/accent/ring)
- [ ] `tests/stat-card.test.ts` passes, registered in `PURE_FILES`; `test:pure` + typecheck green
- [ ] `plans/README.md` row 010 → DONE

## STOP conditions
- If `run-trends.tsx`’s `StatTile` is consumed with props that don't map cleanly to `StatCard`, STOP and report — adapt `StatCard`’s API rather than forcing a lossy change.

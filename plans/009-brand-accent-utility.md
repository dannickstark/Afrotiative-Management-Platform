# Plan 009: Make the brand accent a real, consistent utility

> **Executor instructions**: Follow step by step; run each verification. STOP conditions halt you. Update this plan's row in `plans/README.md` when done.
>
> **Drift check (run first)**: `git diff --stat d0fd009..HEAD -- app/globals.css components/ui/button.tsx` — on change, re-verify.

## Status
- **Priority**: P1 · **Effort**: S · **Risk**: LOW · **Depends on**: none · **Category**: ui
- **Planned at**: commit `d0fd009`, 2026-08-12

## Why this matters

The warm terracotta accent is defined and even mapped to a token (`--color-accent-brand`, so `bg-accent-brand`
already works), but every consumer hand-writes the verbose arbitrary form `bg-[var(--accent-brand)]`
(~14 scattered sites), and most surfaces just fall back to neutral shadcn styling. Because the accent is
painful to type and not a default, the brand thread barely shows. The design intent is "accent = actions
only" (`globals.css:143`), so the cleanest fix is to make the **primary Button** carry the accent by
default and replace the arbitrary strings with the mapped utility.

## Current state
- `app/globals.css:142-146` — `--accent-brand` / `--accent-brand-foreground` defined; mapped in `@theme inline:43-44` → `bg-accent-brand` / `text-accent-brand-foreground` utilities exist but are unused.
- Arbitrary-string consumers include `components/shell/app-sidebar.tsx:66`, `components/shell/nav-main.tsx:75`, `components/login-form.tsx:50`, `components/dashboard/summary-cards.tsx:17`, `components/article/tags-input.tsx:53,88`, and ~8 more.
- `components/ui/button.tsx` — the shadcn Button; its `default` variant uses `bg-primary` today.

**Convention:** accent is "actions only" — apply it to primary CTAs, active nav, and focus, NOT to backgrounds/surfaces.

## Commands
| Purpose | Command | Expected |
|---|---|---|
| Typecheck | `bun run typecheck` | no new errors |
| UI regression | `bun test tests/diffusion-settings-ui.test.ts` | pass |
| Grep sweep | `grep -rn "\[var(--accent-brand)\]" components` | only intentional non-utility spots remain |

## Scope
**In scope:** `app/globals.css` (optional: alias `--primary` to the brand accent, OR leave primary and just adopt the utility); `components/ui/button.tsx` if you make the accent the default CTA; the ~14 arbitrary-string sites → `bg-accent-brand text-accent-brand-foreground`.
**Out of scope:** `components/studio/**` entirely (owned by a separate process — exclude it from the accent sweep, `grep -rn "var(--accent-brand" components | grep -v "/studio/"`); status colors; using the accent as a surface/background (against intent); the canvas hex constants in `components/studio/*` (legitimate render values).

## Steps
### Step 1: Decide the accent's home (pick ONE, default = A)
- **A (recommended):** keep shadcn's `--primary` as-is and simply **replace** each `bg-[var(--accent-brand)] text-[var(--accent-brand-foreground)]` with `bg-accent-brand text-accent-brand-foreground`. Lower blast radius, honors "actions only".
- **B (bolder):** point `--primary`/`--primary-foreground` at the brand accent in `globals.css` so the shadcn `default` Button is branded everywhere automatically. Only if the team wants the accent to be THE primary color; re-check contrast on all default buttons.
Record which you chose in the commit message.
**Verify**: `bun run typecheck` → green.

### Step 2: Sweep the arbitrary strings → utilities
Replace the arbitrary `bg-[var(--accent-brand)]`/`text-[var(--accent-brand-foreground)]` pairs with `bg-accent-brand`/`text-accent-brand-foreground` across the ~14 sites (grep to find them). Leave non-background uses (e.g. a `text-[var(--accent-brand)]` accent number in `summary-cards.tsx`) as `text-accent-brand` where a mapped utility exists.
**Verify**: `grep -rn "var(--accent-brand" components` → only spots without a mapped-utility equivalent remain; `bun run typecheck` → green.

### Step 3: Active nav + focus (optional, high polish)
In `components/shell/nav-main.tsx`, ensure the active item uses `text-accent-brand`/an accent left-border rather than default. Keep it subtle.
**Verify**: `bun run dev` → active nav item reads as branded; primary buttons are terracotta.

## Test plan
No new unit test (styling). Keep `tests/diffusion-settings-ui.test.ts` and any snapshot green. Visual verification of buttons + active nav.

## Done criteria (ALL)
- [ ] Primary CTAs render in the terracotta accent (via utility or default variant)
- [ ] `grep -rn "\[var(--accent-brand)\]" components | grep -v "/studio/"` shows no remaining arbitrary background strings (outside studio) that have a mapped-utility equivalent
- [ ] `bun run typecheck` + `bun test tests/diffusion-settings-ui.test.ts` → green
- [ ] `plans/README.md` row 009 → DONE

## STOP conditions
- If choosing option B drops contrast below AA on any default button (white text on the accent), STOP and stay with option A.

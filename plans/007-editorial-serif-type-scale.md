# Plan 007: Wire the editorial serif and define a type scale

> **Executor instructions**: Follow step by step; run each verification. STOP conditions halt you. Update this plan's row in `plans/README.md` when done.
>
> **Drift check (run first)**: `git diff --stat d0fd009..HEAD -- app/globals.css app/layout.tsx` — on change, re-verify excerpts.

## Status
- **Priority**: P1 · **Effort**: S · **Risk**: LOW · **Depends on**: none · **Category**: ui
- **Planned at**: commit `d0fd009`, 2026-08-12
- Unblocks the visual consistency in plans 008, 010, 012.

## Why this matters

This is the single highest-leverage change for the "no soul / generic SaaS" problem. The brand loads an
editorial serif (Lora) as `--font-editorial`, but `--font-heading` is aliased straight to the sans, so
**every heading renders in Inter** and the serif appears only in article body prose. A French *editorial*
platform reads as a generic admin because its one distinctive typographic asset never appears in the
chrome. Pointing headings at the serif and establishing a real type scale instantly brands every screen.

## Current state
- `app/layout.tsx:9-11` — `Lora` is loaded as `--font-editorial`, `Inter` as `--font-sans`.
- `app/globals.css:11-12`:
  ```css
  --font-heading: var(--font-sans);   /* ← headings resolve to Inter */
  --font-sans: var(--font-sans);
  --font-editorial: var(--font-editorial);
  ```
- Page titles are hand-rolled `text-xl font-semibold` in ~15 places (see plan 008) — all Inter today.

**Convention:** Tailwind v4 CSS-first; tokens live in `@theme inline` in `app/globals.css`. A mapped
`--font-*` token produces a `font-*` utility (e.g. `--font-editorial` → `font-editorial`).

## Commands
| Purpose | Command | Expected |
|---|---|---|
| Typecheck | `bun run typecheck` | no new errors |
| Build sanity | `bun run dev` then load `/login` | title renders in serif |

## Scope
**In scope:** `app/globals.css` (repoint `--font-heading`, optionally add a couple of heading utilities).
**Out of scope:** touching all 15 page titles individually — that happens via the shared `PageHeader` in
plan 008. This plan only makes the serif available and correct; 008 applies it broadly.

## Steps
### Step 1: Point headings at the editorial serif
In `app/globals.css`, change:
```css
--font-heading: var(--font-editorial);
```
This makes `font-heading` a serif utility.
**Verify**: `bun run typecheck` → no new errors.

### Step 2: Apply the serif to the one shared heading surface that already exists
So the change is visible immediately (before plan 008 lands), apply `font-heading` to the login title and
the sidebar wordmark:
- `components/login-form.tsx` `CardTitle` → add `className="font-heading"`.
- `components/shell/app-sidebar.tsx` wordmark span (`Afrotiative`) → add `font-heading`.
(Plan 012 will supersede both with the full brand treatment; this is the interim proof.)
**Verify**: `bun run dev`, load `/login` → the title is in Lora (serif); the sidebar wordmark is serif.

### Step 3: Document the intended type scale in a comment
Add a short comment block in `globals.css` near the font tokens describing the intended scale so plan 008
can implement it consistently:
```
/* Type scale (apply via PageHeader — plan 008):
   display: font-heading text-3xl/tight font-semibold  (page hero, dashboard)
   h1:      font-heading text-2xl font-semibold          (page title)
   h2:      font-heading text-lg font-semibold            (section)
   body:    text-sm; caption: text-xs text-muted-foreground */
```
**Verify**: comment present; `bun run typecheck` → green.

## Test plan
No unit test (pure CSS/token change). Verification is visual: `/login` title and sidebar wordmark render in the serif. Optionally, if a snapshot/CSS test exists, keep it green.

## Done criteria (ALL)
- [ ] `--font-heading` resolves to the editorial serif in `app/globals.css`
- [ ] Login title + sidebar wordmark render in the serif (visual check)
- [ ] `bun run typecheck` → no new errors
- [ ] `plans/README.md` row 007 → DONE

## STOP conditions
- If the serif's metrics make existing headings look broken at their current sizes, don't fight it here — note it for plan 008 (which sets sizes) and keep this change minimal.

# Plan 012: Brand identity — monogram, wordmark, editorial split-screen login

> **Executor instructions**: Follow step by step; run each verification. This plan encodes decided brand direction — do not invent alternatives. STOP conditions halt you. Update this plan's row in `plans/README.md` when done.
>
> **Drift check (run first)**: `git diff --stat d0fd009..HEAD -- components/login-form.tsx "app/(auth)/login/page.tsx" components/shell/app-sidebar.tsx` — on change, re-verify.

## Status
- **Priority**: P1 · **Effort**: M · **Risk**: LOW · **Depends on**: plans 007 (serif) + 009 (accent) · **Category**: ui/design
- **Planned at**: commit `d0fd009`, 2026-08-12

## Decided brand direction (2026-08-12 — do not deviate)
- **Mood:** bold contemporary **pan-African editorial** — warm, confident, modern.
- **Identity:** a clean **monogram (“A”) + Lora wordmark**, designed in-repo (NO external logo asset).
- **Color:** **keep** the existing terracotta `--accent-brand`; apply it consistently. No new palette.
- **Login:** **editorial split-screen** — brand panel + form.

## Why this matters

The two most-seen "starter template" tells are the placeholder single-letter "A" logo (unchanged shadcn
`sidebar-07` lockup) and the bare centered login card. Both are the first thing users see. Replacing them
with a real (if simple) editorial identity is the highest emotional payoff for the "no soul" complaint,
and it's cheap because the tokens and serif already exist (plans 007/009).

## Current state
- `components/shell/app-sidebar.tsx:65-73` — logo is a `size-8` rounded square with the literal letter `A` and an Inter wordmark "Afrotiative / Back-office".
- `components/login-form.tsx` — a `max-w-sm` `Card` with `CardTitle` "Console éditoriale Afrotiative", two inputs, one accent button. No logo/serif/imagery.
- `app/(auth)/login/page.tsx` — renders `<LoginForm/>` centered on the page.
- Tokens available: `--accent-brand` (terracotta), `--font-heading`→Lora (after plan 007), `font-editorial`.

**Convention:** French copy; shadcn primitives; brand accent = "actions/brand moments only".

## Commands
| Purpose | Command | Expected |
|---|---|---|
| Typecheck | `bun run typecheck` | no new errors |
| Login test | `bun test tests/login.test.ts` | pass (logic unchanged) |
| Brand test | `bun test tests/brand-mark.test.ts` | pass |
| Visual | `bun run dev` → `/login`, then any page | branded login + real wordmark in sidebar |

## Scope
**In scope:** new `components/shell/brand-mark.tsx` (monogram + wordmark, reusable); `components/login-form.tsx` + `app/(auth)/login/page.tsx` (split-screen); `components/shell/app-sidebar.tsx` (use `BrandMark`); `tests/brand-mark.test.ts`.
**Out of scope:** login auth logic (`signIn`, error handling in `login-form.tsx` — preserve exactly); adding raster imagery assets (use a CSS color field/gradient + wordmark, not an image file); the dashboard hero (optional stretch, not required here).

## Steps
### Step 1: Build `BrandMark` (TDD)
Create `components/shell/brand-mark.tsx` — a reusable lockup with a size/variant prop:
```tsx
export function BrandMark({ variant = "full", className }: { variant?: "full" | "mark"; className?: string }) {
  return (
    <span className={className} style={{ display: "inline-flex", alignItems: "center", gap: "0.5rem" }}>
      <span className="grid size-8 place-items-center rounded-md bg-accent-brand text-accent-brand-foreground font-heading text-lg font-semibold leading-none">A</span>
      {variant === "full" && (
        <span className="grid leading-tight">
          <span className="font-heading text-base font-semibold tracking-tight">Afrotiative</span>
          <span className="text-xs text-muted-foreground">Console éditoriale</span>
        </span>
      )}
    </span>
  );
}
```
(The monogram is the "A" in the serif on the terracotta chip — a real, intentional mark rather than the default square. Swap in an SVG later if a designer provides one.)
Create `tests/brand-mark.test.ts` (SSR): full variant renders "Afrotiative" + tagline; mark variant renders only the monogram. Register in `PURE_FILES`.
**Verify**: `bun test tests/brand-mark.test.ts` → pass; `bun run typecheck` → green.

### Step 2: Use `BrandMark` in the sidebar
Replace the `app-sidebar.tsx:66-72` lockup with `<BrandMark variant="full" />` (collapse to `variant="mark"` when the sidebar is in icon mode, mirroring the existing collapse logic).
**Verify**: `bun run dev` → sidebar shows the serif wordmark; icon mode shows just the monogram.

### Step 3: Editorial split-screen login
Rewrite the login **layout** (not the form logic). In `app/(auth)/login/page.tsx`, make a two-column full-height layout:
- **Left (brand panel, hidden on small screens):** `bg-accent-brand text-accent-brand-foreground`, a large `BrandMark` (or the wordmark at display size in `font-heading`), and a short editorial tagline in French (e.g. "L'actualité africaine, orchestrée."). A subtle darker-terracotta radial/linear gradient for depth — CSS only, no image asset.
- **Right (form):** the existing `LoginForm` centered, with the `BrandMark variant="mark"` above it for small screens where the left panel is hidden.
```tsx
// app/(auth)/login/page.tsx (shape)
<div className="grid min-h-svh lg:grid-cols-2">
  <aside className="hidden lg:flex flex-col justify-between bg-accent-brand text-accent-brand-foreground p-10">
    <BrandMark variant="full" className="[&_*]:text-accent-brand-foreground" />
    <p className="font-heading text-3xl font-semibold leading-tight max-w-sm">L'actualité africaine, orchestrée.</p>
    <p className="text-sm opacity-80">Console éditoriale interne</p>
  </aside>
  <main className="flex items-center justify-center p-6">
    <div className="w-full max-w-sm space-y-6">
      <BrandMark variant="mark" className="lg:hidden" />
      <LoginForm />
    </div>
  </main>
</div>
```
In `components/login-form.tsx`: keep ALL logic; drop the now-redundant card chrome if desired (the page provides the frame), set the title in `font-heading`, keep the accent button. Do not change `signIn`, error handling, or the `role="alert"` message.
**Verify**: `bun test tests/login.test.ts` → pass (logic untouched); `bun run dev` → `/login` is a branded split-screen; narrow width shows the monogram + form.

### Step 4: Gate
**Verify**: `bun run test:pure` → pass; `bun run typecheck` → green.

## Test plan
- `tests/brand-mark.test.ts` (pure): variants render expected text/mark.
- `tests/login.test.ts` must stay green — proof the auth logic is untouched.
- Visual verification of the split-screen and sidebar wordmark.

## Done criteria (ALL)
- [x] `BrandMark` exists and is used by BOTH the sidebar and the login page
- [x] The literal placeholder "A" square in `app-sidebar.tsx` is gone (replaced by `BrandMark`)
- [x] `/login` is an editorial split-screen; login logic/tests unchanged (`tests/login.test.ts` green)
- [x] `tests/brand-mark.test.ts` passes, registered in `PURE_FILES`; `test:pure` + typecheck green
- [x] `plans/README.md` row 012 → DONE

## STOP conditions
- If a real logo/brand kit is provided before this runs, STOP and wire that asset into `BrandMark` instead of the typographic monogram (the split-screen and adoption points stay the same).
- Do NOT alter any `signIn`/auth-error code in `login-form.tsx`. If the split-screen refactor tempts a logic change, STOP and keep logic identical.

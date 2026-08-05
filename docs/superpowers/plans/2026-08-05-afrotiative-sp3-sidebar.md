# SP3 — Adopt shadcn `sidebar-08` as the app shell — Plan

**Goal:** Replace the hand-rolled `components/shell/sidebar.tsx` + `topbar.tsx` with the shadcn `sidebar-08` block, preserving role-filtered nav, the pending-review badge, theme toggle, and adding a proper user footer (name/role/avatar/logout). Keep the app on the **base-nova (Base UI)** preset.

**Branch:** `feat/pipeline-v2`. **Tech:** Next.js 16, shadcn on Base UI (`components.json` style `base-nova`, shadcn CLI 4.16.1), Tailwind, next-themes.

## Global constraints
- **Base UI, not Radix.** The generated `sidebar.tsx` MUST be the base-nova variant. After running the CLI, `git diff` the pre-existing `components/ui/{sheet,tooltip,separator,skeleton,button}.tsx` — if the CLI silently swapped any to `@radix-ui/*` imports, revert those files to their committed Base UI versions (they already exist and work). The new `sidebar.tsx` must compose against the existing Base UI primitives; if it ships Radix `data-[state=open]` selectors that don't match Base UI's `data-*` attributes, adapt them (Base UI uses `data-slot` + `data-starting-style`/`data-ending-style`/etc — see `components/ui/sheet.tsx`).
- French UI copy. Preserve exact role-filtering behavior from `components/shell/nav-items.ts` (roles per item) and the `pendingCount` badge on `/queue`.
- No behavior regressions: every current nav link works, active-state highlighting works, dark/light theme works, mobile (sheet) + desktop collapse work.

## Current state (from exploration)
- Shell: `app/(app)/layout.tsx` → `requireUser()` + a pending-count query → renders `<Sidebar role pendingCount>` + `<Topbar user>` + `<main>`.
- `components/shell/nav-items.ts` — `NAV_ITEMS`: `/dashboard` (all), `/queue` (all, badge=pending), `/calendar` (all), `/published` (all), `/runs` (admin,editor), `/settings/feeds` "Réglages" (admin,editor). Source of truth for nav — keep this array, feed it into the new sidebar.
- `components/shell/topbar.tsx` — role badge, user name, `ThemeToggle`. No avatar/logout menu.
- `lib/session.ts` `requireUser()` → `SessionUser = {id,name,email,role,banned}` — **no `image`**; `db/schema.ts:21` has `user.image`. Add `image: string | null` to `SessionUser` + select it.
- Sidebar CSS vars (`--sidebar*`) already defined in `app/globals.css` (light+dark) → sidebar picks them up for free. Brand accent optional via `var(--accent-brand)`.
- Logout: check `lib/auth-client.ts` (better-auth client) for `signOut`; the NavUser menu's logout calls it then routes to `/login`.

## Steps

### 1. Install the block
`npx shadcn@latest add sidebar-08` (non-interactive if it prompts: accept overwrites only for NEW files). Inspect everything it added (`git status`): expect `components/ui/sidebar.tsx`, `hooks/use-mobile.ts(x)`, possibly demo `components/app-sidebar.tsx`/`nav-*.tsx`. Then the Base-UI diff-check above. Report exactly what it generated + any reverts.

### 2. Build `AppSidebar` (`components/shell/app-sidebar.tsx`)
A `Sidebar` composed from our data (not the demo's hardcoded content):
- Header: app name/logo ("Afrotiative" / a short mark).
- Content: a `SidebarGroup` + `SidebarMenu` mapping the ROLE-FILTERED `NAV_ITEMS` to `SidebarMenuItem`/`SidebarMenuButton` (asChild + `next/link`), active state via `usePathname()`, the `/queue` item shows a `SidebarMenuBadge` with `pendingCount` when > 0.
- Footer: `NavUser` (`components/shell/nav-user.tsx`) — avatar (image or initials fallback), name, role label (`ROLE_LABEL`), a dropdown (Base UI `DropdownMenu`) with theme toggle + **Se déconnecter** (logout → `/login`).
- Props: `{ role, pendingCount, user }` passed from the server layout.

### 3. Rewire `app/(app)/layout.tsx`
```
<SidebarProvider>
  <AppSidebar role={user.role} pendingCount={pendingCount} user={user} />
  <SidebarInset>
    <header> <SidebarTrigger /> ...page chrome... </header>
    <main>{children}</main>
  </SidebarInset>
</SidebarProvider>
```
Keep `requireUser()` + the pending-count query. Move `ThemeToggle` into the NavUser menu or the inset header (pick one; don't duplicate).

### 4. Widen `SessionUser`
Add `image: string | null` in `lib/session.ts` and select `user.image`. Fallback to initials in the avatar when null.

### 5. Retire old shell
Delete `components/shell/sidebar.tsx` and `components/shell/topbar.tsx` once nothing imports them (grep to confirm). Keep `nav-items.ts` (reused) and `theme-toggle.tsx` (reused in NavUser).

## Verify (no automated UI test harness — manual + typecheck)
- `bun run typecheck` → 0 errors. `bun test` → full suite still green (this is a UI-shell change; tests shouldn't break).
- `bun run dev`, log in, and confirm (screenshot via the run/browser tooling if available): sidebar renders with all role-appropriate links, active highlight, pending badge, collapse-to-icon on desktop, mobile sheet opens, theme toggle works, user footer shows name/role/avatar, logout returns to `/login`. Log in as `editor@` to confirm `/runs`+`/settings` hidden appropriately vs `admin@`.
- Report the manual verification result + a screenshot if captured.

Commit: `feat(shell): adopt shadcn sidebar-08 app shell`.

## Risks / notes
- If `sidebar-08`'s generated `sidebar.tsx` is Radix-flavored and hard to adapt, STOP and report — do not hand-port a large primitive silently; we'll decide (adapt vs. use sidebar-07/simpler variant).
- Don't touch the `/settings/*` secondary tab-nav (`settings-nav.tsx`) — orthogonal.

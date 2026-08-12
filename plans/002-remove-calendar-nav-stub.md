# Plan 002: Remove the dead "Calendrier" nav stub before launch

> **Executor instructions**: Follow step by step; run each verification. STOP conditions halt you. Update this plan's row in `plans/README.md` when done.
>
> **Drift check (run first)**: `git diff --stat d0fd009..HEAD -- components/shell/nav-items.ts "app/(app)/calendar"` — on any change, re-verify the excerpts below before proceeding.

## Status
- **Priority**: P0 · **Effort**: S · **Risk**: LOW · **Depends on**: none · **Category**: tech-debt
- **Planned at**: commit `d0fd009`, 2026-08-12

## Why this matters

"Calendrier" is a first-class sidebar item shown to **every role**, and it links to a page whose entire
body is: `Calendrier éditorial — disponible dans une prochaine version (SP3).` A visible top-level menu
item that opens a "not built yet" message is a day-one embarrassment and a support-ticket generator. No
spec actually defines an editorial calendar (the "(SP3)" reference is wrong — SP3 was the sidebar work),
so there is nothing to finish here for launch; remove the entry until a real calendar is scoped.

## Current state
- `components/shell/nav-items.ts:47` — inside the "redaction" section, ungated:
  ```ts
  { href: "/dashboard", label: "Tableau de bord", icon: LayoutDashboard },
  { href: "/queue", label: "File de revue", icon: Inbox, badgeKey: "pending" },
  { href: "/calendar", label: "Calendrier", icon: Calendar },      // ← remove
  { href: "/published", label: "Articles publiés", icon: Newspaper },
  ```
- `app/(app)/calendar/page.tsx` — the stub page (2 lines).
- Breadcrumbs and `ROUTE_LABELS` derive from `NAV_SECTIONS`, so removing the nav entry keeps them consistent automatically.

**Convention:** the sidebar is data-driven from `NAV_SECTIONS`; there is no other registration of routes.

## Commands
| Purpose | Command | Expected |
|---|---|---|
| Typecheck | `bun run typecheck` | no new errors |
| Nav test | `bun test tests/nav-sections.test.ts tests/shell-nav.test.ts` | pass (adjust if they assert the calendar entry) |
| Pure lane | `bun run test:pure` | pass |

## Scope
**In scope:** `components/shell/nav-items.ts` (remove the `/calendar` item; drop the now-unused `Calendar` lucide import if nothing else uses it); `app/(app)/calendar/` (delete the stub route directory); any nav test that asserts the calendar entry.
**Out of scope:** other nav items; the breadcrumb/`ROUTE_LABELS` machinery (it derives automatically).

## Steps
### Step 1: Remove the nav entry
Delete the `/calendar` item from the "redaction" section in `components/shell/nav-items.ts`. If `Calendar` from `lucide-react` is now unused in the file, remove it from the import.
**Verify**: `bun run typecheck` → no new errors; `grep -n "/calendar" components/shell/nav-items.ts` → no matches.

### Step 2: Delete the stub route
Delete the directory `app/(app)/calendar/`.
**Verify**: `test ! -e "app/(app)/calendar/page.tsx" && echo gone` → prints `gone`.

### Step 3: Fix any test that referenced it
Run the nav tests. If one asserts the presence/labels of nav items and included "Calendrier", update that assertion to match the new list.
**Verify**: `bun test tests/nav-sections.test.ts tests/shell-nav.test.ts` → pass.

### Step 4: Full gate
**Verify**: `bun run test:pure` → pass; `bun run typecheck` → no new errors.

## Test plan
No new test. If `tests/nav-sections.test.ts` enumerates expected items, update it to drop "Calendrier". Otherwise no test change.

## Done criteria (ALL)
- [ ] `grep -rn "/calendar" components app` → no matches (nav or route)
- [ ] `app/(app)/calendar/` deleted
- [ ] `bun test tests/nav-sections.test.ts tests/shell-nav.test.ts` and `bun run test:pure` → pass
- [ ] `bun run typecheck` → no new errors
- [ ] Only in-scope files modified
- [ ] `plans/README.md` row 002 → DONE

## STOP conditions
- If any code outside tests imports from `app/(app)/calendar/` or links to `/calendar` beyond the nav item, STOP and report (don't chase a wider refactor).
- If the team actually wants an editorial calendar for launch, STOP — this becomes a build, not a removal; scope a spec instead.

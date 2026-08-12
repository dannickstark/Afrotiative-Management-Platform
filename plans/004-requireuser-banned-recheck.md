# Plan 004: `requireUser` re-checks `banned` on every request

> **Executor instructions**: Follow step by step; run each verification. STOP conditions halt you. Update this plan's row in `plans/README.md` when done.
>
> **Drift check (run first)**: `git diff --stat d0fd009..HEAD -- lib/session.ts lib/actions/team-actions.ts` — on change, re-verify excerpts.

## Status
- **Priority**: P0 · **Effort**: S · **Risk**: LOW · **Depends on**: none · **Category**: security
- **Planned at**: commit `d0fd009`, 2026-08-12

## Why this matters

`requireUser()` is the single chokepoint every authenticated page and server action flows through, but it
never checks `banned`. Today the only thing that logs out a banned user is an explicit session-row delete
inside `disableMember` (`lib/actions/team-actions.ts`), whose own comment notes: "a ban only blocks future
sign-ins — `getSession()` doesn't re-check `banned`." So any ban applied another way — the better-auth
admin API directly, or a future code path that sets `banned=true` without purging sessions — leaves the
user with full access for up to the 7-day session lifetime (`lib/auth.ts:19`). Enforcing `banned` at the
chokepoint is defense-in-depth that doesn't depend on every ban caller remembering to revoke sessions.

## Current state
- `lib/session.ts`:
  ```ts
  export type SessionUser = { id: string; name: string; email: string; role: Role; banned: boolean; image: string | null };
  export async function requireUser(): Promise<SessionUser> {
    const s = await getSession();
    if (!s?.user) redirect("/login");
    return s.user as unknown as SessionUser;   // ← never checks banned
  }
  ```
- `lib/actions/team-actions.ts:66-75` — compensates today by deleting session rows in `disableMember`
  (keep this; it's still the right thing to force immediate logout).

**Convention:** `requireUser` uses `redirect("/login")` from `next/navigation` for the unauthenticated
case; reuse the same redirect for banned so the behavior is uniform.

## Commands
| Purpose | Command | Expected |
|---|---|---|
| Typecheck | `bun run typecheck` | no new errors |
| Team/session tests | `bun test tests/settings-rbac.test.ts` | pass |
| Pure lane | `bun run test:pure` | pass |

## Scope
**In scope:** `lib/session.ts` (add the banned check), and a test asserting the behavior (a pure test on
a small extracted predicate is preferred — see Step 2).
**Out of scope:** `lib/actions/team-actions.ts` (keep the explicit session purge), `lib/auth.ts`, the better-auth config.

## Steps
### Step 1: Enforce `banned` in `requireUser`
In `lib/session.ts`, after resolving the user and before returning, redirect banned users:
```ts
export async function requireUser(): Promise<SessionUser> {
  const s = await getSession();
  if (!s?.user) redirect("/login");
  const user = s.user as unknown as SessionUser;
  if (user.banned) redirect("/login");   // defense-in-depth — plan 004
  return user;
}
```
**Verify**: `bun run typecheck` → no new errors.

### Step 2: Add a pure, testable predicate + test (recommended)
`requireUser` itself calls `next/headers`/`redirect` and isn't unit-testable directly. Extract the
decision into a pure helper in the same file and test it:
```ts
export function isSessionUsable(user: { banned: boolean } | null | undefined): boolean {
  return !!user && !user.banned;
}
```
Have `requireUser` use it (`if (!isSessionUsable(s?.user as …)) redirect("/login")`). Create
`tests/session-guard.test.ts` (DB-free → pure lane): `isSessionUsable(null) === false`,
`isSessionUsable({banned:true}) === false`, `isSessionUsable({banned:false}) === true`. Register
`"session-guard.test.ts"` in `PURE_FILES` (`scripts/test-fast.ts`).
**Verify**: `bun test tests/session-guard.test.ts` → pass; appears in `bun run test:pure`.

### Step 3: Regression
**Verify**: `bun test tests/settings-rbac.test.ts` → pass; `bun run typecheck` → no new errors.

## Test plan
- `tests/session-guard.test.ts` (pure): the three `isSessionUsable` cases above.
- Confirm existing RBAC/team tests still pass (banned users being redirected must not break member-management tests, which operate on data rows, not live sessions).

## Done criteria (ALL)
- [ ] `requireUser` redirects to `/login` when `user.banned` is true
- [ ] `tests/session-guard.test.ts` exists, passes, and is registered in `PURE_FILES`
- [ ] `bun test tests/settings-rbac.test.ts`, `bun run test:pure`, `bun run typecheck` → green
- [ ] `lib/actions/team-actions.ts` session-purge is unchanged
- [ ] Only in-scope files modified
- [ ] `plans/README.md` row 004 → DONE

## STOP conditions
- If `getSession()`/better-auth already exposes a banned-enforcement option that's simply unset, STOP and report it — configuring it may be cleaner than a manual check (but the manual check is a fine, explicit default).
- If redirecting banned users breaks the admin's ability to *view* a banned member in the team page, STOP — that page reads member rows via a query, not `requireUser` on the banned user, so it should be unaffected; if it isn't, report the coupling.

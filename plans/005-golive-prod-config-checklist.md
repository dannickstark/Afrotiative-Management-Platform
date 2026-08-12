# Plan 005: Production auth/config verification before go-live

> **Executor instructions**: This is a verification + small-config plan, not a feature build. Perform each check and record the result. Where a value is wrong, fix the deployment env (not committed code) and note it. STOP conditions halt you. Update this plan's row in `plans/README.md` when done.

## Status
- **Priority**: P0 · **Effort**: S · **Risk**: LOW · **Depends on**: none · **Category**: dx/security
- **Planned at**: commit `d0fd009`, 2026-08-12

## Why this matters

better-auth derives secure-cookie and CSRF-origin behavior from `BETTER_AUTH_URL`. `lib/auth.ts` relies
on defaults (no explicit `advanced.useSecureCookies` / `trustedOrigins`), and `.env.example:11` ships
`BETTER_AUTH_URL=http://localhost:3000`. If production is deployed with a non-https or wrong-origin value,
session cookies may not get `Secure`/`SameSite` handling and CSRF-origin checks won't match — a real
auth-hardening gap on launch day. This plan confirms the production environment is correct and, if the
team prefers explicitness over defaults, makes the cookie/origin settings explicit in code.

## Current state
- `lib/auth.ts:8-20` — `betterAuth({ … emailAndPassword: { enabled: true, disableSignUp: true }, plugins: [adminPlugin({…})], session: { expiresIn: 60*60*24*7 } })`. No `baseURL`, `advanced`, or `trustedOrigins` set → all derive from env/defaults.
- `.env.example` (non-secret keys): `BETTER_AUTH_URL`, `BETTER_AUTH_SECRET`, plus provider/DB/WP keys.
- Deploy target: Railway single instance (`railway.json`).

## Checklist (perform and record each)
1. **`BETTER_AUTH_URL` in production** is the exact public **https** origin (e.g. `https://console.afrotiative.…`), no trailing slash, no `localhost`.
   **Verify**: inspect the Railway service variables (operator action). Record the value's scheme (must be `https`).
2. **`BETTER_AUTH_SECRET`** is set in production to a strong, unique value (not the `.env.example` placeholder, not shared with dev). If it was ever committed or shared, **rotate** it.
   **Verify**: confirm it's set and distinct; note "rotated on <date>" if changed.
3. **All trigger secrets present & strong** in prod: `PIPELINE_TRIGGER_SECRET`, `PUBLISH_TRIGGER_SECRET`, `CREDENTIALS_ENCRYPTION_KEY`. Confirm they exist and were never committed (`.gitignore` covers `.env*`; only `.env.example` is tracked — confirm with `git ls-files | grep -E "^\.env"`).
   **Verify**: `git ls-files | grep -E '^\.env'` → returns only `.env.example`.
4. **Secure cookies (optional hardening):** if the team wants this explicit rather than default-derived, set in `lib/auth.ts`:
   ```ts
   advanced: { useSecureCookies: true },
   trustedOrigins: [process.env.BETTER_AUTH_URL!],
   ```
   Only do this if `BETTER_AUTH_URL` is guaranteed https in every non-local deploy (otherwise local dev over http breaks). If unsure, leave defaults and just verify #1.
   **Verify**: `bun run typecheck` → no new errors; local `bun run dev` still logs in over http (if you added the explicit block, confirm dev still works or gate it on `NODE_ENV === "production"`).
5. **Error detail leakage:** confirm production isn't shipping stack traces to clients (Next.js hides them in production builds by default; verify no custom error boundary echoes `error.message` from server errors to the UI). Spot-check `app/(app)/error.tsx` and `app/(app)/settings/error.tsx`.

## Scope
**In scope:** deployment environment variables (operator); optionally `lib/auth.ts` for step 4.
**Out of scope:** the auth plugin behavior, session lifetime, any DB change.

## Done criteria (ALL)
- [ ] `BETTER_AUTH_URL` confirmed https + correct origin in production (recorded)
- [ ] `git ls-files | grep -E '^\.env'` returns only `.env.example`
- [ ] Trigger/encryption secrets confirmed present in prod and not committed; any exposed secret rotated
- [ ] (If step 4 applied) `bun run typecheck` green and dev login still works
- [ ] `plans/README.md` row 005 → DONE, with the recorded values (scheme only, never the secret values)

## STOP conditions
- **Never write a secret value into any file, commit, or this plan.** Reference only the variable name and whether it is set/valid. If a check requires reading a secret, do it in the deploy dashboard, not in the repo.
- If `BETTER_AUTH_URL` cannot be confirmed https in production, STOP and report to the operator — do not enable `useSecureCookies` blindly (it can lock users out if the origin is wrong).

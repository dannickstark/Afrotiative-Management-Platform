# Plan 006: Small security hardening bundle

> **Executor instructions**: Three independent, small hardening fixes. Do them in order; each has its own verification. STOP conditions halt you. Update this plan's row in `plans/README.md` when done.
>
> **Drift check (run first)**: `git diff --stat d0fd009..HEAD -- app/api/pipeline/run/route.ts app/api/publish/due/route.ts "app/api/studio/asset-fonts/[id]/route.ts" lib/sanitize.ts lib/url-guard.ts` — on change, re-verify excerpts.

## Status
- **Priority**: P1 · **Effort**: S · **Risk**: LOW · **Depends on**: none · **Category**: security
- **Planned at**: commit `d0fd009`, 2026-08-12

## Why this matters

Three residual, low-severity items worth closing before launch: a timing side-channel on the two
internet-reachable cron secrets, an unauthenticated font proxy that fetches a DB-stored URL without the
SSRF guard, and a stale sanitizer comment that is now actively wrong (a future maintainer could "fix" the
wrong layer). None are critical; all are cheap.

## Part A — Constant-time comparison on cron trigger secrets (SEC-03)

### Current state
- `app/api/pipeline/run/route.ts:5-8`:
  ```ts
  const secret = getPipelineConfig().triggerSecret;
  const auth = req.headers.get("authorization");
  if (!secret || auth !== `Bearer ${secret}`) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  ```
- `app/api/publish/due/route.ts:8-9` — same `!==` pattern with `PUBLISH_TRIGGER_SECRET`.
`!==` short-circuits on the first differing byte — a timing side-channel on the secret.

### Steps
1. Add a tiny helper (new file `lib/timing-safe.ts`) that compares two strings in constant time:
   ```ts
   import { timingSafeEqual } from "node:crypto";
   export function safeEqual(a: string, b: string): boolean {
     const ab = Buffer.from(a); const bb = Buffer.from(b);
     if (ab.length !== bb.length) return false;   // length is not secret
     return timingSafeEqual(ab, bb);
   }
   ```
2. In both routes, replace `auth !== \`Bearer ${secret}\`` with `!auth || !safeEqual(auth, \`Bearer ${secret}\`)`, keeping the `!secret` fail-closed guard first (so an unset secret is still always 401).
3. Add `tests/timing-safe.test.ts` (DB-free → register in `PURE_FILES`): equal strings → true; different-length → false; same-length different → false. No secret values in the test.
**Verify**: `bun test tests/timing-safe.test.ts` → pass; `bun run typecheck` → no new errors.

## Part B — Guard the unauthenticated font proxy (SEC-04)

### Current state
- `app/api/studio/asset-fonts/[id]/route.ts:35` — `upstream = await fetch(row.url);` where `row.url` comes
  from `render_assets`; the route is deliberately public/unauthenticated. The write side is
  `template:manage`-gated, so today `row.url` is operator-controlled, but an unauthenticated endpoint that
  fetches a DB-stored URL should still validate it.

### Steps
1. Before the fetch, validate `row.url` with the existing guard:
   ```ts
   import { isSafePublicHttpUrl } from "@/lib/url-guard";
   // …
   if (!isSafePublicHttpUrl(row.url)) return new Response(null, { status: 404 });
   ```
   (404, matching the route's other "not a usable asset" responses.) If the team wants stricter, additionally assert `row.url` starts with the expected R2 public prefix — but the guard alone closes the SSRF surface.
**Verify**: `bun run typecheck` → no new errors; if `tests/` has a font-route test, `bun test` it → pass.

## Part C — Fix the stale sanitizer comment (CORR-01)

### Current state
- `lib/sanitize.ts:24-27` — the comment claims the pipeline's AI `bodyHtml` is "NOT yet sanitized … deferred to SP4 Task 6." But `lib/pipeline/stages.ts` (and `lib/pipeline/regenerate.ts`) now call `sanitizeArticleHtml` before every DB write. The comment is actively wrong.

### Steps
1. Replace the stale NOTE with an accurate one, e.g.:
   ```
   NOTE: applied on BOTH write paths — the human-edit save (saveDraft, below) and the pipeline's
   AI-generated bodyHtml (lib/pipeline/stages.ts + lib/pipeline/regenerate.ts sanitize at write time).
   ```
   Verify the claim before writing it: `grep -rn "sanitizeArticleHtml" lib/pipeline` should show the calls.
**Verify**: `grep -rn "sanitizeArticleHtml" lib/pipeline` → shows calls in `stages.ts`/`regenerate.ts`; comment updated to match.

## Commands
| Purpose | Command | Expected |
|---|---|---|
| Typecheck | `bun run typecheck` | no new errors |
| New tests | `bun test tests/timing-safe.test.ts` | pass |
| Pure lane | `bun run test:pure` | pass incl. new file |

## Scope
**In scope:** `lib/timing-safe.ts` (create), `app/api/pipeline/run/route.ts`, `app/api/publish/due/route.ts`, `app/api/studio/asset-fonts/[id]/route.ts`, `lib/sanitize.ts` (comment only), `tests/timing-safe.test.ts` (create), `scripts/test-fast.ts` (register).
**Out of scope:** any change to what the secrets/URLs actually are; the sanitizer's runtime behavior (Part C is comment-only).

## Done criteria (ALL)
- [ ] Both cron routes compare via `safeEqual`; `!secret` still returns 401 first
- [ ] Font proxy validates `row.url` via `isSafePublicHttpUrl` before fetch
- [ ] `lib/sanitize.ts` comment matches reality (verified by grep)
- [ ] `tests/timing-safe.test.ts` passes, registered in `PURE_FILES`; `bun run test:pure` + `bun run typecheck` green
- [ ] Only in-scope files modified
- [ ] `plans/README.md` row 006 → DONE

## STOP conditions
- If either cron route already changed to use a different auth mechanism since `d0fd009`, STOP and report.
- Never place a secret value in the test or anywhere else. If verifying Part A tempts you to hardcode the real secret, use dummy strings only.

# Afrotiative — Go-Live Readiness & UI/UX Plans

Advisor plan set produced by `/improve` (deep audit, 2026-08-12), stamped against commit `d0fd009`.
Read-only audit → self-contained handoff plans. Each plan is written for an executor with **zero
context**; follow it top-to-bottom, run every verification command, update the status row here when done.

**Repo verification commands** (used as gates in every plan):
- Typecheck: `bun run typecheck` — exits 0 (⚠️ one **pre-existing** unrelated error exists at
  `app/api/studio/asset-fonts/[id]/route.ts` re `RouteContext`; it is not introduced by any plan here.
  Treat "no NEW errors" as the gate.)
- Fast test lane (no DB): `bun run test:pure` — all pass. New DB-free test files MUST be registered in
  the `PURE_FILES` allowlist in `scripts/test-fast.ts` or they silently run in the slow DB lane.
- Single file: `bun test tests/<file>.test.ts`
- Full suite `bun test` is slow and **infra-flaky** (shared Neon DB + R2); ~15 nondeterministic failures
  are pre-existing and unrelated. Use `test:pure` + targeted files for a green/red signal.

**Conventions to match:** French UI copy; shadcn/ui + Tailwind v4 (CSS tokens in `app/globals.css`);
Drizzle query builder (no raw SQL from input); server actions begin with `requireUser()` +
`requirePermission()`; conventional-commit messages (`feat(scope): …`, `fix(scope): …`).

## Brand direction (decided 2026-08-12, drives plans 012+)

- **Mood:** bold contemporary **pan-African editorial** — warm, confident, modern.
- **Identity:** a clean **monogram + Lora wordmark** (no external logo asset); designed in-repo.
- **Color:** **keep** the existing warm terracotta/amber tokens — the fix is to *apply them consistently*, not add new colors.
- **Login:** **editorial split-screen** (brand panel + form).

## Priority & execution order

| # | Plan | Category | Priority | Effort | Depends on | Status |
|---|------|----------|----------|--------|------------|--------|
| 001 | Gate deferred diffusion channels (no fake "sent") | bug | **P0** | S | none | DONE |
| 002 | Remove dead Calendar nav stub | tech-debt | **P0** | S | none | DONE |
| 003 | SSRF guard on RSS ingest extraction | security | **P0** | S | none | DONE |
| 004 | `requireUser` re-checks `banned` | security | **P0** | S | none | DONE |
| 005 | Go-live production-config checklist (auth/cookies) | dx/security | **P0** | S | none | IN-REPO ✅ / OPERATOR PENDING |
| 006 | Security hardening bundle (cron compare, font proxy, stale comment) | security | P1 | S | none | TODO |
| 007 | Wire the editorial serif + define a type scale | ui | P1 | S | none | TODO |
| 008 | Shared `PageHeader` adopted across all pages | ui | P1 | M | 007 | TODO |
| 009 | Brand accent as a real default utility | ui | P1 | S | none | TODO |
| 010 | Shared `StatCard`/`Metric` + dashboard hierarchy | ui | P1 | M | 007 | TODO |
| 011 | States & feedback (EmptyState, loading skeletons, responsive tables, a11y) | ui/a11y | P1 | M | none | TODO |
| 012 | Brand identity & editorial login (monogram, wordmark, split-screen) | ui/design | P1 | M | 007,009 | TODO |
| 013 | WhatsApp diffusion adapter (D4) — design/spike | direction | P2 | L | 001 | TODO |

**Dependency notes:** 007 (type scale) unblocks the visual consistency in 008/010/012 — do it first among the UI plans. 001 must land before 013 (the adapter replaces the gated stub). 003/004/005 are independent and can go in any order.

**Go-live cut line (recommended):** 001–005 before launch (all S-effort, launch-safety/quality). 006 + the UI craft set (007–011) and brand (012) are high-value but not launch-blocking. 013 is post-launch scope.

## EXCLUDED — the Studio/canvas is owned by a separate process

A separate Claude session is actively working the Studio visual editor / canvas. To avoid collisions,
this plan set does **not** touch `lib/studio/**`, `components/studio/**`, the studio routes
(`app/(app)/studio/**`), `db/studio-templates.ts`, or the studio-UX roadmap doc. Consequently:

- **Removed** (owned by the studio process): Studio U4 (binding visibility), Studio U5 (multi-format),
  the studio-UX roadmap status-drift doc fix, and the social-template **seeding** in `db/studio-templates.ts`.
- **Scoped away from studio:** plan **008** (PageHeader) does NOT convert the studio list pages
  (`asset-library`, `manual-generate`, `templates-table`); plan **009** (accent utility) excludes
  `components/studio/**`; plan **011** (states) does NOT add a studio route `loading.tsx` and its a11y
  sweep excludes `components/studio/**`; plan **001** keeps the `available` field on the diffusion
  registry (`lib/diffusion/channels.ts`), not the shared `lib/studio` types.
- Plan **013** (WhatsApp) is diffusion, not studio — but its go-live prerequisite of a seeded
  `wa_square`/`story`/`x_landscape` social template lives in `db/studio-templates.ts` and is therefore
  **owned by the studio process**; coordinate before enabling any real WhatsApp send.

## Considered and rejected (do not re-audit)

- WhatsApp/X/TikTok **stub adapters** are by-design for the D1 socle — the *bug* is only that the UI reports success (fixed by 001), not that the stubs exist. X/TikTok have **external blockers** (paid API tier / app audit) so a real adapter is out of scope now; only WhatsApp (013) is buildable.
- `mock`/degraded-AI fallback paths in `lib/pipeline`/`lib/ai` are intentional and flag `aiDegraded` — not stubs.
- Empty `catch {}` blocks in `lib/pipeline/run.ts` are annotated telemetry-only (best-effort), not swallowed critical errors.
- The 2026-08-08 schedule-builder spec was never built but is explicitly **superseded** by the delivered 2026-08-12 planification-conviviale — settled, not a gap.

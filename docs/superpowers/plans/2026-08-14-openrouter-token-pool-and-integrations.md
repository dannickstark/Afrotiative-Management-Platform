# OpenRouter Token Pool + Integrations Page — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** DB-stored, encrypted, admin+editor-managed OpenRouter tokens with automatic rotation/fallback (on quota errors AND flaky short responses, with per-token cooldown) across all OpenRouter calls — effective without a restart; plus an integrations page that lists all integrations and hosts the token manager.

**Architecture:** A new `openrouterTokens` table (encrypted via the existing `lib/diffusion/crypto.ts`), a server-only pool loader, and one shared runner `runWithOpenRouterPool` that rotates tokens and is wired into the 3 duplicated OpenRouter call loops. The env `OPENROUTER_API_KEY` stays as a final pool fallback. UI + RBAC (`llmTokens:manage`) live on the expanded integrations page.

**Tech Stack:** Next.js (customized — AGENTS.md), Drizzle/Postgres, Vercel AI SDK (`ai@7.0.51`, `@ai-sdk/openai-compatible@3.0.22`), `node:crypto` (AES-256-GCM already in `lib/diffusion/crypto.ts`), bun test, Zod.

**Spec:** `docs/superpowers/specs/2026-08-14-openrouter-token-pool-and-integrations-design.md` (read it — the plan argues from it).

## Global Constraints

- No new runtime dependency.
- **Secrets:** token values encrypted at rest via `encryptSecret`/`decryptSecret` (`lib/diffusion/crypto.ts`); NEVER returned to the client (masked reads expose only id/label/status, never ciphertext or plaintext); write-only `type="password" autoComplete="off"` inputs; decrypt server-side only at call time; no token value in logs.
- **RBAC:** token management = new `llmTokens:manage` capability (admin+editor). Do NOT widen `pipeline:configure`. Every token server action calls `requireUser()` + `requirePermission(role, "llmTokens", "manage")`.
- **Degradation contract unchanged:** token exhaustion falls through ALL tokens → next `llmOrder` provider → mock (`via:"mock"` → `aiDegraded`), exactly as today.
- **Runtime effect:** adding a token takes effect on the next run with NO restart (per-run async pool read).
- Best-effort signals: a stats-update or single-token failure must NEVER crash an LLM call (never-throw around `markTokenResult`).
- `CREDENTIALS_ENCRYPTION_KEY` unset → add-token disabled (typed error), pool uses only the env token.
- **Testing:** repo has NO React component testing — test pure logic + server helpers with `bun test`; browser-verify UI. **Do NOT add new test files to `scripts/test-fast.ts` PURE_FILES** (the `--pure` runner's worker grouping is fragile w.r.t. the studio-render DOM tests; adding files breaks `studio-render-clippath` with `window is not defined`). Verify each new test with `bun test <file>` and confirm `bun run test:pure` stays 0 fail (baseline ~1759).
- `bunx tsc --noEmit` clean; French UI copy; customized Next.js — read `node_modules/next/dist/docs/` before touching any Next API (server actions, RSC, route handlers). Commit after each task. Branch: `feat/openrouter-token-pool-and-integrations`.

---

### Task 1: Schema — `openrouterTokens` table + `openrouterMinContentChars` + migration

**Files:**
- Modify: `db/schema.ts` (add the table + the pipelineSettings column)
- Create: `db/migrations/0019_*.sql` (generated)
- Modify: `lib/queries/settings.ts` (`getPipelineSettings` seed/read includes the new column)
- Test: `tests/openrouter-tokens-schema.test.ts` (settings default) — DB lane

**Interfaces:**
- Produces: `openrouterTokens` table with columns per spec B1; `pipelineSettings.openrouterMinContentChars` (integer, not null, default 400); `getPipelineSettings()` returns `openrouterMinContentChars`.

- [ ] **Step 1: Read** `db/schema.ts:308-325` (pipelineSettings), the `socialChannelSettings` table (430-462) for the credentials/jsonb precedent, and `lib/queries/settings.ts:63-77` (lazy-seed).
- [ ] **Step 2: Add the table** in `db/schema.ts` (place near pipelineSettings). Columns exactly per spec B1: `id` uuid pk `defaultRandom()`, `label` text notNull, `tokenCiphertext` text notNull, `active` boolean notNull default true, `sortOrder` integer notNull default 0, `cooldownUntil` timestamp (mode/tz per the file's convention) null, `lastStatus` text null, `lastUsedAt` timestamp null, `lastError` text null, `createdBy` uuid null references users.id, `createdAt`/`updatedAt` timestamp notNull defaultNow(). Add `index("openrouter_tokens_active_order_idx").on(t.active, t.sortOrder)`. Match the file's column-helper style exactly.
- [ ] **Step 3: Add** `openrouterMinContentChars: integer("openrouter_min_content_chars").notNull().default(400)` to `pipelineSettings`.
- [ ] **Step 4: Generate migration**: `bun run db:generate`. Confirm a new `db/migrations/0019_*.sql` appears with the CREATE TABLE + ALTER TABLE. Do NOT hand-edit it beyond confirming correctness.
- [ ] **Step 5: Update** `getPipelineSettings()` in `lib/queries/settings.ts` — add `openrouterMinContentChars` to the select AND to the lazy-seed insert `.values({...})` (default 400), matching how the other columns are seeded.
- [ ] **Step 6: Write test** `tests/openrouter-tokens-schema.test.ts`: `getPipelineSettings()` returns `openrouterMinContentChars` (400 by default on a fresh seed). This touches the DB → DB lane (do NOT add to PURE_FILES).
- [ ] **Step 7: Run** `bun test tests/openrouter-tokens-schema.test.ts` (needs DB) + `bunx tsc --noEmit`. If the DB isn't reachable in this env, at minimum `tsc` must be clean and the migration must generate; note DB-run status in the report.
- [ ] **Step 8: Commit** `feat(db): openrouterTokens table + openrouterMinContentChars setting`.

---

### Task 2: Pure helpers — error classifier + content length + flaky predicates

**Files:**
- Create: `lib/ai/openrouter-errors.ts` (`classifyOpenRouterError`)
- Create: `lib/ai/plain-text.ts` (`plainTextLen`)
- Test: `tests/openrouter-errors.test.ts`, `tests/plain-text.test.ts`

**Interfaces:**
- Produces: `classifyOpenRouterError(err: unknown): "rate_limited" | "auth_failed" | "error"`; `plainTextLen(html: string): number` (strip tags, collapse whitespace, trim, return length).

- [ ] **Step 1: Write failing tests** `tests/openrouter-errors.test.ts`:
```ts
import { describe, it, expect } from "bun:test";
import { classifyOpenRouterError } from "@/lib/ai/openrouter-errors";
describe("classifyOpenRouterError", () => {
  it("429 → rate_limited", () => expect(classifyOpenRouterError({ statusCode: 429, message: "x" })).toBe("rate_limited"));
  it("quota message → rate_limited", () => expect(classifyOpenRouterError({ message: "You exceeded your quota" })).toBe("rate_limited"));
  it("no endpoints message → rate_limited", () => expect(classifyOpenRouterError({ message: "No endpoints found" })).toBe("rate_limited"));
  it("401 → auth_failed", () => expect(classifyOpenRouterError({ statusCode: 401, message: "bad key" })).toBe("auth_failed"));
  it("403 → auth_failed", () => expect(classifyOpenRouterError({ statusCode: 403 })).toBe("auth_failed"));
  it("500/unknown → error", () => expect(classifyOpenRouterError({ statusCode: 500, message: "boom" })).toBe("error"));
  it("plain throw → error", () => expect(classifyOpenRouterError(new Error("weird"))).toBe("error"));
});
```
and `tests/plain-text.test.ts`:
```ts
import { describe, it, expect } from "bun:test";
import { plainTextLen } from "@/lib/ai/plain-text";
describe("plainTextLen", () => {
  it("strips tags + counts text", () => expect(plainTextLen("<h2>Hi</h2><p>there</p>")).toBe(7)); // "Hithere" -> adjust to your whitespace rule
  it("collapses whitespace", () => expect(plainTextLen("<p>a   b</p>")).toBe(3)); // "a b"
  it("empty/whitespace-only → 0", () => expect(plainTextLen("<p>   </p>")).toBe(0));
});
```
(Adjust the exact expected numbers to your whitespace rule — decide it now: replace tags with a space, collapse runs of whitespace to one, trim, count `.length`. Make the tests assert THAT rule precisely.)
- [ ] **Step 2: Run** both — expect FAIL.
- [ ] **Step 3: Implement.** `plainTextLen`: `html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().length`. `classifyOpenRouterError`: read `statusCode` via `APICallError.isInstance(err) ? err.statusCode : (err as any)?.statusCode`; read message via `err?.message ?? String(err)`; apply the spec B4 rules (429 or /rate.?limit|quota|exhaust|insufficient|no endpoints/i → rate_limited; 401/403 → auth_failed; else error). Import `APICallError` from `ai`.
- [ ] **Step 4: Run** both — PASS. `bunx tsc --noEmit` clean.
- [ ] **Step 5: Commit** `feat(ai): openrouter error classifier + plainTextLen`.

---

### Task 3: Token pool loader — `lib/ai/token-pool.ts`

**Files:**
- Create: `lib/ai/token-pool.ts`
- Test: `tests/openrouter-token-pool.test.ts` (DB lane)

**Interfaces:**
- Consumes: `openrouterTokens` (T1), `decryptSecret` (`lib/diffusion/crypto.ts`), `getPipelineConfig`.
- Produces:
  - `type PooledToken = { id: string | null; label: string; token: string };`
  - `async function getOpenRouterTokenPool(cfg = getPipelineConfig()): Promise<PooledToken[]>`
  - `async function markTokenResult(id: string | null, status: string, cooldownMs?: number): Promise<void>` (never throws; `id:null` no-op)

- [ ] **Step 1: Read** `lib/diffusion/crypto.ts` (`decryptSecret`, error types) and `lib/diffusion/settings-core.ts:358-366` (`getDecryptedCredentials` server-only pattern) to mirror the decrypt-server-side discipline. Read `db/index.ts` for the db client import.
- [ ] **Step 2: Write failing tests** `tests/openrouter-token-pool.test.ts` (DB lane — seeds rows then asserts): active+non-cooldown tokens returned in sortOrder; a token with `cooldownUntil` in the future is EXCLUDED; a token with `cooldownUntil` in the past is INCLUDED; `active:false` excluded; the env token (`cfg.openrouter.apiKey`) is appended last with `id:null` when set; a row whose ciphertext fails to decrypt is skipped (not thrown); `markTokenResult(null,...)` is a no-op; `markTokenResult(id,"rate_limited",1000)` sets `cooldownUntil ~ now+1s` and `lastStatus`. Use the repo's DB-test setup (see any `*-queries.test.ts` for seeding/cleanup conventions).
- [ ] **Step 3: Run** — FAIL.
- [ ] **Step 4: Implement.** Server-only module (NO `"use server"`). `getOpenRouterTokenPool`: `db.select().from(openrouterTokens).where(and(eq(active,true), or(isNull(cooldownUntil), lte(cooldownUntil, new Date())))).orderBy(asc(sortOrder), asc(createdAt))`; map each → `{ id, label, token: decryptSecret(row.tokenCiphertext) }` inside a try/catch that skips + `console.warn`s a decrypt failure; then if `cfg.openrouter?.apiKey` push `{ id:null, label:"environnement", token: cfg.openrouter.apiKey }` (dedupe: skip if a DB token's plaintext equals it). `markTokenResult`: wrap the whole body in try/catch (never throw); for `id:null` return; else `db.update(openrouterTokens).set({ lastStatus:status, lastUsedAt:new Date(), lastError:..., cooldownUntil: cooldownMs? new Date(Date.now()+cooldownMs): <unchanged> }).where(eq(id,...))`. NOTE: `Date.now()`/`new Date()` are fine in runtime code (the ban is only in Workflow scripts).
- [ ] **Step 5: Run** the DB test (if DB reachable) + `bunx tsc --noEmit`. Report DB-run status.
- [ ] **Step 6: Commit** `feat(ai): openrouter token pool loader + markTokenResult`.

---

### Task 4: Shared runner + model factory — `lib/ai/with-token-pool.ts`, `lib/ai/providers.ts`

**Files:**
- Create: `lib/ai/with-token-pool.ts`
- Modify: `lib/ai/providers.ts` (per-key model builder)
- Test: `tests/with-token-pool.test.ts` (pure — inject fake pool + op)

**Interfaces:**
- Consumes: `getOpenRouterTokenPool`/`markTokenResult` (T3), `classifyOpenRouterError` (T2).
- Produces:
  - `lib/ai/providers.ts`: `export function buildOpenRouterModel(cfg, apiKey: string)` returning the same
    `createOpenAICompatible({...apiKey})(cfg.openrouter.model)` the existing `case "openrouter"` builds.
  - `runWithOpenRouterPool<T>(op: (apiKey: string) => Promise<T>, isFlaky: (r: T) => boolean, deps?): Promise<{ ok: true; value: T } | { ok: false }>` — `deps` allows injecting `{ loadPool, mark }` for tests (default to the real T3 fns). Constants `RATE_LIMIT_COOLDOWN_MS` (env `OPENROUTER_RATE_COOLDOWN_MIN`, default 60) and `AUTH_COOLDOWN_MS` (default 24h).

- [ ] **Step 1: Read** `lib/ai/providers.ts` (`case "openrouter"`, `buildModel`) and the spec B5/B6.
- [ ] **Step 2: Write failing tests** `tests/with-token-pool.test.ts` using injected `deps` (fake `loadPool` returning `PooledToken[]`, spy `mark`):
  - first token op succeeds + not flaky → `{ok:true}`, `mark(id,"ok")` called, second token NOT tried.
  - first op returns flaky, second ok → returns second's value; `mark(id1,"flaky")` (no cooldown) then `mark(id2,"ok")`.
  - first op throws a 429-shaped error, second ok → `mark(id1,"rate_limited", RATE_LIMIT_COOLDOWN_MS)`, returns second.
  - first op throws 401 → `mark(id1,"auth_failed", AUTH_COOLDOWN_MS)`, continues.
  - all tokens flaky/throw → `{ok:false}`.
  - empty pool → `{ok:false}` (op never called).
- [ ] **Step 3: Run** — FAIL.
- [ ] **Step 4: Implement** per spec B5 (loop pool; try op; isFlaky→mark flaky+continue; catch→classify→mark+cooldown+continue; return on first good; `{ok:false}` when exhausted). Add `buildOpenRouterModel` to providers.ts and have the existing `case "openrouter"` delegate to it (`buildOpenRouterModel(cfg, cfg.openrouter.apiKey)`) so behavior is unchanged for non-pool callers.
- [ ] **Step 5: Run** `bun test tests/with-token-pool.test.ts` + `bunx tsc --noEmit`.
- [ ] **Step 6: Commit** `feat(ai): runWithOpenRouterPool rotation runner + per-key model factory`.

---

### Task 5: Wire the runner into the 3 OpenRouter call sites

**Files:**
- Modify: `lib/ai/generate-article.ts`, `lib/ai/improve-article.ts`, `lib/diffusion/caption.ts`
- Test: `tests/openrouter-flaky-wiring.test.ts` (pure — the isFlaky predicates + a seam assertion)

**Interfaces:**
- Consumes: `runWithOpenRouterPool` (T4), `buildOpenRouterModel` (T4), `plainTextLen` (T2), `getPipelineSettings` (T1, for `openrouterMinContentChars`).

- [ ] **Step 1: Read** all three files' provider loops (`generate-article.ts:50-70`, `improve-article.ts:22-40`, `caption.ts:171-186`).
- [ ] **Step 2: Write failing test** `tests/openrouter-flaky-wiring.test.ts` for the extracted `isFlaky` predicate(s): export `articleIsFlaky(bodyHtml, minChars)` from generate-article (or a small shared module) and assert: body with plain-text length < minChars → true; ≥ minChars → false. (The full rotation is covered by T4; here just lock the article flaky rule.)
- [ ] **Step 3: Run** — FAIL.
- [ ] **Step 4: Implement.** For each file, replace the OpenRouter branch of the provider loop so that when `name === "openrouter"` the call goes through `runWithOpenRouterPool(apiKey => <generateObject/generateText with buildOpenRouterModel(cfg, apiKey)>, isFlaky)`. On `{ok:true}` use the value (and, for article, the existing sanitize/return); on `{ok:false}` continue to the next `llmOrder` provider. Keep the non-openrouter providers on the existing single-key path (omniroute etc.). Preserve the final mock fallback + `via` values. `isFlaky`:
  - article: `(draft) => plainTextLen(draft.bodyHtml) < settings.openrouterMinContentChars` (load settings once at the top; the file already may read settings — reuse).
  - improve/caption: `(text) => text.trim().length === 0`.
  Keep it DRY where the three edits are identical in shape; a tiny shared `openrouterAttempt` helper is fine but not required.
- [ ] **Step 5: Run** `bun test tests/openrouter-flaky-wiring.test.ts` + the existing `tests/ai-*.test.ts`, `tests/diffusion-caption.test.ts` (they must still pass — the openrouter path now routes through the pool; if they mock the provider, ensure the pool's env-token path still exercises them, or adjust the seam). `bunx tsc --noEmit` clean; `bun run test:pure` 0 fail.
- [ ] **Step 6: Commit** `feat(ai): route all OpenRouter calls through the token pool with flaky detection`.

---

### Task 6: RBAC + token server actions + masked read

**Files:**
- Modify: `lib/rbac.ts` (add `llmTokens` resource)
- Create: `lib/actions/openrouter-token-actions.ts` (add/delete/toggle/test)
- Create: `lib/queries/openrouter-tokens.ts` (`getOpenRouterTokensMasked`)
- Test: `tests/openrouter-token-actions.test.ts` (RBAC + masking) — DB lane

**Interfaces:**
- Consumes: crypto (`encryptSecret`), `openrouterTokens` (T1), `requireUser`/`requirePermission`.
- Produces:
  - `lib/rbac.ts`: `llmTokens: { journalist: [], editor: ["manage"], admin: ["manage"] }`.
  - `getOpenRouterTokensMasked(): Promise<{ id; label; active; lastStatus; cooldownUntil; lastUsedAt }[]>` — NEVER ciphertext/plaintext.
  - Server actions (all `requirePermission(role,"llmTokens","manage")`): `addOpenRouterToken(input: {label; token})`, `deleteOpenRouterToken(id)`, `setOpenRouterTokenActive(id, active)`, `testOpenRouterToken(id)`.

- [ ] **Step 1: Read** `lib/rbac.ts:5-41`, `lib/actions/diffusion-settings-actions.ts` (the credentials-action + RBAC pattern), `lib/diffusion/settings-core.ts` (`omitCredentials` masking), `lib/session.ts` (`requireUser`).
- [ ] **Step 2: Write failing tests** `tests/openrouter-token-actions.test.ts` (DB lane): `can("editor","llmTokens","manage")` true, `can("journalist",...)` false; `addOpenRouterToken` as journalist throws PermissionError; as editor inserts an encrypted row (ciphertext ≠ plaintext); `getOpenRouterTokensMasked` returns the row WITHOUT any token field (assert no property holds the plaintext or ciphertext); `setOpenRouterTokenActive`/`deleteOpenRouterToken` work + are gated. Mock the session/role the way existing action tests do.
- [ ] **Step 3: Run** — FAIL.
- [ ] **Step 4: Implement.** rbac.ts: add the `llmTokens` resource row + include it in the resource type. Actions file (`"use server"`): each action `const user = await requireUser(); requirePermission(user.role, "llmTokens", "manage");` then the DB op. `addOpenRouterToken`: validate label/token non-empty; if crypto key unset → throw a typed user-facing error ("Clé de chiffrement non configurée"); `encryptSecret(token)`; insert with `createdBy: user.id`, `sortOrder` = current max+1. `testOpenRouterToken`: load row, `decryptSecret`, `GET {cfg.openrouter.baseUrl}/models` with `Authorization: Bearer`, update `lastStatus` ok/auth_failed. Masked read in queries file. `revalidatePath('/settings/integrations')` after mutations.
- [ ] **Step 5: Run** the DB test (if reachable) + `bunx tsc --noEmit`; report DB-run status.
- [ ] **Step 6: Commit** `feat(settings): openrouter token RBAC + server actions + masked read`.

---

### Task 7: Token manager UI

**Files:**
- Create: `components/settings/openrouter-tokens-panel.tsx`
- Test: `tests/openrouter-tokens-panel.test.ts` (pure helper if any; else covered by browser-verify)

**Interfaces:** Consumes T6 actions + masked read. Rendered by T9 inside the OpenRouter integration card.

- [ ] **Step 1: Read** `components/settings/social-channel-form.tsx` (write-only password input, masking, `useTransition`, toast) as the exact template.
- [ ] **Step 2: Implement** `OpenRouterTokensPanel({ tokens }: { tokens: MaskedToken[] })` (client component): a list showing per token — label, status badge (actif / en pause jusqu'à {heure} / dernier: {lastStatus}), lastUsedAt; a disable/enable toggle + delete (ConfirmDialog) + optional "Tester" button (each in its own `useTransition`, calling the T6 actions, toast on result, `router.refresh()`); and an add form (label input + write-only `type="password" autoComplete="off"` token input, cleared after save; disabled with a hint if the crypto key is unconfigured — surface that state from a prop or the add action's error). French copy. If a small pure helper emerges (e.g. cooldown-label formatting), extract + unit-test it; otherwise rely on browser-verify.
- [ ] **Step 3: Run** `bunx tsc --noEmit`; `bun run test:pure` 0 fail.
- [ ] **Step 4: Commit** `feat(settings): OpenRouter token manager UI`. (Browser-verify happens in T9 when it's mounted.)

---

### Task 8: Integrations registry — list all + status + test

**Files:**
- Modify: `components/settings/integration-cards.tsx` (registry 5 → all)
- Modify: `lib/queries/settings.ts` (`getIntegrationStatus`)
- Modify: `lib/actions/integration-actions.ts` (`testIntegration` for new ones)
- Test: `tests/integration-status.test.ts` (pure mapping if extractable) — DB/pure per what it touches

**Interfaces:** Produces the expanded status list the cards render.

- [ ] **Step 1: Read** `components/settings/integration-cards.tsx` (INTEGRATIONS list + card render), `lib/queries/settings.ts:40-57` (`getIntegrationStatus`), `lib/actions/integration-actions.ts` (`testIntegration`), `lib/config/pipeline-config.ts`, `lib/search/index.ts`, `lib/studio/config.ts` (R2), `lib/wp/config.ts`, `lib/email/resend.ts`.
- [ ] **Step 2: Implement.** Extend `INTEGRATIONS` to: openrouter, omniroute, anthropic, openai, google, jina, firecrawl, brave, exa, embeddings, r2, resend, wordpress — each with a `kind` (llm/extract/search/embeddings/storage/email/cms) and `management: "env" | "tokens"` (`openrouter` = tokens, rest = env). Extend `getIntegrationStatus()` to report `configured` for each (from getPipelineConfig / search config / getStudioConfig / getWpConfig / resend env), plus for openrouter a token-pool summary from `getOpenRouterTokensMasked()` (count active / in-cooldown). Extend `testIntegration` for the new names: LLM providers → the existing `GET {baseUrl}/models` style where a base URL + key exist (anthropic/openai/google via their endpoints OR key-presence if no free probe); brave/exa/r2/resend/embeddings → key-presence. Keep all tests FREE. Cards: `env` cards render « défini via l'environnement » + status + Test; the `openrouter` card renders the token panel (wired in T9).
- [ ] **Step 3: Test** — if you can extract a pure status-mapping fn, unit-test it (`tests/integration-status.test.ts`, e.g. given a fake cfg, the configured booleans are correct). Otherwise rely on tsc + browser-verify. Do NOT add to PURE_FILES if it touches the DB.
- [ ] **Step 4: Run** `bunx tsc --noEmit`; `bun run test:pure` 0 fail.
- [ ] **Step 5: Commit** `feat(settings): integrations page lists all integrations with status/test`.

---

### Task 9: Editor access to the integrations page + mount the token manager

**Files:**
- Modify: `app/(app)/settings/integrations/page.tsx` (guard: allow editor read; pass tokens to the OpenRouter card)
- Modify: `components/shell/nav-items.ts` (integrations visible to editor)
- Modify: `components/settings/settings-nav.ts` (role filter includes editor for integrations)
- Modify: `components/settings/integration-cards.tsx` (render `OpenRouterTokensPanel` in the openrouter card)
- Test: none new (guard change) — browser-verify

- [ ] **Step 1: Read** `app/(app)/settings/integrations/page.tsx` (current `requirePermission(role,"pipeline","configure")` admin gate), `components/shell/nav-items.ts:18-28`, `components/settings/settings-nav.ts:22`, and how RoleGate/nav filtering works.
- [ ] **Step 2: Implement.** Page guard: allow admin AND editor to VIEW (read-level) — e.g. gate on `can(role,"llmTokens","manage") || can(role,"pipeline","configure")` (both admin+editor pass), or a dedicated read check; the page renders status (booleans only — no secret values). Fetch `getOpenRouterTokensMasked()` and pass to `IntegrationCards`, which renders `OpenRouterTokensPanel` inside the openrouter card. Nav: add `editor` to the integrations entry in `nav-items.ts` and `settings-nav.ts`. Keep env-provider WRITE/Test actions gated as today (admin) if their action requires `pipeline:configure` — only token management is editor-accessible.
- [ ] **Step 3: Run** `bunx tsc --noEmit`; `bun run test:pure` 0 fail.
- [ ] **Step 4: BROWSER-VERIFY** (the whole feature): dev server via the preview tool (create `.claude/launch.json` if missing — dev cmd is `bun run dev`/`bun dev`; check package.json `scripts.dev`). As admin: `/settings/integrations` lists ALL integrations with status; the OpenRouter card shows the token panel; add a token (label + value) → it appears masked with an "actif" status; disable + delete work. As editor (if a test editor account exists or by temporarily checking the guard): the page is reachable and token management works; env Test stays admin-only. Screenshot. If the dev server can't start (missing env/DB/CREDENTIALS_ENCRYPTION_KEY), note exactly what blocked it and rely on tsc + unit tests — do NOT block the task.
- [ ] **Step 5: Commit** `feat(settings): editor access to integrations page + mount OpenRouter token manager`.

---

## Self-review notes (author)
- Spec coverage: T1 schema/setting; T2 classify+plainText; T3 pool loader; T4 runner+model factory; T5 wiring (all 3 sites); T6 RBAC+actions+masked read; T7 UI; T8 integrations listing/status/test; T9 page access + mount. All spec sections covered.
- Secrets: encryption reused (T1/T3/T6), masked reads only (T6), write-only inputs (T7), decrypt server-side at call time (T3), never logged. RBAC `llmTokens:manage` (T6) gates every action; page read widened to editor (T9) shows no values.
- Degradation contract: T4/T5 preserve `{ok:false} → next provider → mock/aiDegraded`.
- Type names consistent: `PooledToken`, `getOpenRouterTokenPool`, `markTokenResult`, `classifyOpenRouterError`, `plainTextLen`, `runWithOpenRouterPool`, `buildOpenRouterModel`, `getOpenRouterTokensMasked`, `llmTokens:manage`, `openrouterMinContentChars`.
- Dependencies: T3←T1; T4←T2,T3; T5←T2,T4,T1; T6←T1; T7←T6; T8←T6(masked read); T9←T7,T8. Order T1→T9 as written.
- DB-lane tests (T1,T3,T6) run under plain `bun test`; NONE added to PURE_FILES. Pure tests (T2,T4,T5,T8-helper) run standalone.

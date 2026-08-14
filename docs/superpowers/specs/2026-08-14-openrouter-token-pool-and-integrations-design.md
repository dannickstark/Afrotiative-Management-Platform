# Design — OpenRouter token pool (rotating fallback) + integrations page

Date: 2026-08-14
Status: approved-for-planning (pending user spec review)
Branch: `feat/openrouter-token-pool-and-integrations` (one combined PR)

Two coupled features:
- **A. Integrations page** — list ALL integrations (not just 5) with status/test; single-secret providers stay
  env-managed and labeled; the OpenRouter card becomes a real configurator (Feature B's token UI).
- **B. OpenRouter token pool** — DB-stored, encrypted, user-managed (admin+editor) OpenRouter tokens with
  automatic rotation/fallback on quota errors AND flaky (too-short) responses, effective without a restart.

Decisions locked with the user:
- Config depth: **list all + configure the runtime cases** (OpenRouter tokens + model). Other single-secret
  providers remain env-managed (Railway), shown as status/Test cards labeled « défini via l'environnement ».
- Token access: **admin + editor** (new RBAC capability).
- Retry trigger: **quota/rate-limit/auth errors AND short body** (< `openrouterMinContentChars`, default 400).
- Exhaustion: **per-token cooldown** (skip a failed token for a window; free tier resets ~daily).
- Rotation scope: **all OpenRouter calls** (article generation, improve, captions) via one shared runner.

Prerequisite: `CREDENTIALS_ENCRYPTION_KEY` (already used by social channels) must be set for token storage.
Without it, token add is disabled and the pool uses only the env `OPENROUTER_API_KEY` (graceful degrade).

---

## Feature B — OpenRouter token pool (the core)

### B1. Data model — `openrouterTokens` table (`db/schema.ts`)
Columns:
- `id` uuid pk default random
- `label` text not null — user-friendly account name (e.g. "compte gratuit #2")
- `tokenCiphertext` text not null — `encryptSecret(rawToken)` (lib/diffusion/crypto.ts format `iv:tag:ct`)
- `active` boolean not null default true
- `sortOrder` integer not null default 0 — rotation order (lower first)
- `cooldownUntil` timestamptz null — when set and > now(), the token is skipped
- `lastStatus` text null — one of `"ok" | "rate_limited" | "auth_failed" | "flaky" | "error"` (plain text,
  NOT a pg enum, to avoid a migration churn on a soft, evolving signal)
- `lastUsedAt` timestamptz null
- `lastError` text null — short last error message (for the UI)
- `createdBy` uuid null → users.id (audit)
- `createdAt` / `updatedAt` timestamptz not null default now()
Index on `(active, sortOrder)`. Migration: edit `db/schema.ts`, run `bun run db:generate` (drizzle-kit;
produces the next numbered file, `db/migrations/0019_*.sql`), commit the generated SQL. `db:migrate:deploy`
runs on Railway pre-deploy (railway.json). Same flow the `openrouterMinContentChars` column (B8) uses — one
migration covers both new columns/table.

### B2. Crypto — reuse, do not reinvent
Use `encryptSecret` / `decryptSecret` from `lib/diffusion/crypto.ts` verbatim (AES-256-GCM,
`CREDENTIALS_ENCRYPTION_KEY`). If `getCryptoConfig()` returns null (key unset), the add-token action fails
with a typed, user-facing error and the pool loader simply returns only the env token.

### B3. Pool loader (server-only) — `lib/ai/token-pool.ts`
- `export type PooledToken = { id: string | null; label: string; token: string };` (`id: null` = the env token)
- `export async function getOpenRouterTokenPool(cfg): Promise<PooledToken[]>`:
  - Query `openrouterTokens` where `active` AND (`cooldownUntil` is null OR `cooldownUntil <= now()`), ordered
    by `sortOrder`, `createdAt`. Decrypt each server-side (skip + log any that fail to decrypt — a stale-key
    token must not break the pool).
  - Append the env token last as `{ id: null, label: "environnement", token: cfg.openrouter.apiKey }` **only if**
    `cfg.openrouter?.apiKey` is set. Dedupe if an env token equals a DB one (compare plaintext).
  - Never expose this from a Server Action to the client (server-only module, no "use server").
- `export async function markTokenResult(id, status, cooldownMs?)`: best-effort update of `lastStatus`,
  `lastUsedAt`, `lastError`, and `cooldownUntil = now()+cooldownMs` when provided. `id: null` (env token) is a
  no-op. Never throws (a stats-update failure must not fail the LLM call).

### B4. Error classification — `lib/ai/openrouter-errors.ts`
`export function classifyOpenRouterError(err): "rate_limited" | "auth_failed" | "error"` — inspects the Vercel
AI SDK error. Use `APICallError.isInstance(err)` (exported from `ai@7`) to read `err.statusCode` /
`err.responseBody`; fall back to `String(err?.message)` for non-APICallError throws. Rules: statusCode 429 OR
message matching /rate.?limit|quota|exhaust|insufficient|no endpoints/i → `rate_limited`; statusCode 401/403 →
`auth_failed`; else `error`. Pure + unit-tested with synthetic error objects (fake `{ statusCode, message }`
and a real-ish APICallError shape).

### B5. The shared runner — `lib/ai/with-token-pool.ts`
```
export async function runWithOpenRouterPool<T>(
  cfg,
  op: (apiKey: string) => Promise<T>,
  isFlaky: (result: T) => boolean,   // per-call quality gate
): Promise<{ ok: true; value: T } | { ok: false }>
```
Behavior:
- Load pool (B3). If empty → `{ ok: false }`.
- For each `PooledToken` in order:
  - `try { const value = await op(token.token); }`
    - if `isFlaky(value)` → `markTokenResult(id, "flaky")` (no cooldown), continue to next token.
    - else → `markTokenResult(id, "ok")`, return `{ ok: true, value }`.
  - `catch (e)`: `const kind = classifyOpenRouterError(e)`;
    - `rate_limited` → `markTokenResult(id, "rate_limited", RATE_LIMIT_COOLDOWN_MS)`, continue.
    - `auth_failed` → `markTokenResult(id, "auth_failed", AUTH_COOLDOWN_MS)`, continue.
    - `error` → `markTokenResult(id, "error")` (no cooldown), continue.
- All tokens exhausted → `{ ok: false }` (caller falls through to next `llmOrder` provider → mock).
Constants: `RATE_LIMIT_COOLDOWN_MS` (default 60 min, env `OPENROUTER_RATE_COOLDOWN_MIN`), `AUTH_COOLDOWN_MS`
(default 24 h — a bad key won't fix itself soon). Cap total token attempts at the pool size (no infinite loop).

### B6. Model factory change — `lib/ai/providers.ts`
Add `buildOpenRouterModel(cfg, apiKey)` (or extend `buildModel` to accept an optional key override) so the
runner can build a model per token: `createOpenAICompatible({ name:"openrouter", baseURL:cfg.openrouter.baseUrl!,
apiKey, supportsStructuredOutputs:true })(cfg.openrouter.model)`. Non-openrouter providers unchanged.

### B7. Wire into the 3 call sites (refactor to the shared runner)
Today `generate-article.ts:50-70`, `improve-article.ts:22-40`, `caption.ts:171-186` each have an identical
`for (provider of llmOrder) { for (attempt<2) {...} }` loop that builds the model ONCE before the attempt loop.
Refactor each so that when the provider is `"openrouter"`, the call goes through `runWithOpenRouterPool` with the
right `op` (build model with the given key + run generateObject/generateText) and `isFlaky`:
- `generate-article.ts`: `isFlaky = (draft) => plainTextLen(draft.bodyHtml) < settings.openrouterMinContentChars`
  (strip tags, trim). On `{ ok:false }`, proceed to the next `llmOrder` provider; if all providers fail → mock
  (`aiDegraded` contract preserved).
- `improve-article.ts`: `isFlaky = (text) => text.trim().length === 0` (keep the existing non-empty rule).
- `caption.ts`: `isFlaky = (text) => text.trim().length === 0`.
Non-openrouter providers (omniroute) keep the existing single-key attempt loop. To stay DRY, factor the
"run the llmOrder chain" into a small shared helper if it reads cleanly; otherwise apply the same edit at each
site (three sites, identical shape). `plainTextLen` is a shared pure util (strip HTML, collapse whitespace).

### B8. Config / settings
- `pipelineSettings` (`db/schema.ts:308-325`): add `openrouterMinContentChars` integer not null default 400
  (admin-tunable, runtime). Surfaced in `getPipelineSettings()` (lazy-seed default) and the pipeline settings
  form (optional to expose in UI now; the column + default is the requirement).
- Cooldown windows are env-overridable constants (B5), not DB settings (rarely tuned).
- No change to `getPipelineConfig()` shape; the pool is loaded via its own async query at the call sites (config
  stays sync/env for `openrouter.apiKey`, which becomes the env pool member).

### B9. Settings UI — token management on the OpenRouter card
- Read helper `getOpenRouterTokensMasked()` (server): returns `{ id, label, active, lastStatus, cooldownUntil,
  lastUsedAt, createdByName? }[]` — NEVER the token value (mirror social's `omitCredentials`).
- Server actions (all gated admin+editor, see RBAC): `addOpenRouterToken(label, token)` (validates key configured,
  `encryptSecret`, inserts), `deleteOpenRouterToken(id)`, `setOpenRouterTokenActive(id, active)`, and optional
  `testOpenRouterToken(id)` (decrypt server-side, GET `{baseUrl}/models` with it, update lastStatus).
- Component: a token list + an add form (write-only `type="password" autoComplete="off"` input, cleared after
  save; never pre-filled), status badges (actif / en pause jusqu'à HH:MM / dernier: ok|rate_limited|…), enable/
  disable + delete buttons. Reuse the social-channel-form masking conventions and the app's table/DataTable if a
  table fits. French copy.

### B10. RBAC
- `lib/rbac.ts` matrix: grant editors a capability for token management. Cleanest: add a new resource, e.g.
  `llmTokens: { journalist: [], editor: ["manage"], admin: ["manage"] }`, and gate the token server actions with
  `requirePermission(role, "llmTokens", "manage")`. (Do NOT widen `pipeline:configure` — that also unlocks
  pipeline/env-secret settings which stay admin-only.)
- Integrations page access: make `/settings/integrations` visible to editor as well (nav `nav-items.ts` +
  `settings-nav.ts` role filter + the page's own guard) at READ level (status only, no secret values are ever
  rendered). The env-secret status dashboard shows only presence booleans, which is acceptable for editors; all
  WRITE token actions remain gated by `llmTokens:manage` (admin+editor). Env-provider Test buttons: keep admin-
  only if their `testIntegration` gate is `pipeline:configure`, OR relax to editor — default: keep Test gated as
  today (admin) and only token management is editor-accessible. The spec's requirement: editors can reach the page
  and manage tokens; they need not gain env-secret Test.

---

## Feature A — Integrations page: list all + status

### A1. Registry (`components/settings/integration-cards.tsx`)
Extend `INTEGRATIONS` from 5 to the full set, each with a `kind`:
- LLM: openrouter, omniroute, anthropic, openai, google
- Extract: jina, firecrawl (readability is local/no-key — omit or show as "local")
- Search: brave, exa
- Embeddings: embeddings (EMBED_*)
- Storage: r2 (R2_*)
- Email: resend (RESEND_API_KEY) — note the on/off + recipients already live in pipelineSettings
- WordPress: wordpress
Each card: a `management: "env" | "tokens"` marker. `env` cards show a status badge + « défini via
l'environnement » + Test (where available). The `openrouter` card renders Feature B's token management panel.
(Exclude crawl4ai — not wired into config on this branch.)

### A2. Status (`lib/queries/settings.ts::getIntegrationStatus`)
Extend to report presence for every registry entry: LLM providers + search + embeddings from `getPipelineConfig()`
(and `lib/search` config), R2 from `getStudioConfig()`, resend from env, wordpress from `getWpConfig()`. Return a
`{ name, configured, kind, management }[]` the cards render. For openrouter, also surface token-pool summary
(e.g. "3 jetons actifs, 1 en pause") from the masked read.

### A3. Test action (`lib/actions/integration-actions.ts::testIntegration`)
Extend for the new integrations where a free check exists: LLM providers (anthropic/openai/google/openrouter/
omniroute) → a lightweight models/health call where the SDK/endpoint allows (or key-presence when no free probe);
search (brave/exa) → key-presence (avoid spending quota); r2 → a cheap HEAD/list or presence; resend → presence.
Keep it FREE (no token-spending completions), matching the existing header contract.

---

## Testing strategy (whole feature)
- Repo has NO React component testing — test PURE logic + server helpers with `bun test`; browser-verify UI.
  **Do NOT add new test files to `scripts/test-fast.ts` PURE_FILES** (the `--pure` runner's grouping is fragile
  w.r.t. the studio-render DOM tests — adding files breaks studio-render-clippath; new tests run under plain
  `bun test`/CI). Verify each new test with `bun test <file>` and confirm `bun run test:pure` stays 0 fail.
- Pure/unit: `classifyOpenRouterError` (429/401/message cases); `plainTextLen`; `isFlaky` predicates;
  crypto round-trip already covered (reuse). `runWithOpenRouterPool` with an injected fake `op` +
  fake pool (dependency-injected DB reads or a seam) covering: first token ok; first flaky → second ok; first
  rate-limited → cooldown set + second ok; all exhausted → `{ ok:false }`; env-only pool.
- DB-touching (DB lane): pool loader ordering/cooldown filtering + decrypt; masked read never returns ciphertext;
  add/delete/toggle actions honor RBAC (admin+editor allowed, journalist denied).
- Browser-verify: integrations page lists all integrations; add a token; see it listed masked with status;
  disable/delete; (rotation itself is covered by unit tests, not a live multi-token run).

## Global constraints
- No new runtime dependency (crypto is `node:crypto`; AI SDK already present).
- Token secrets: encrypted at rest (reuse crypto.ts); NEVER returned to the client (masked reads only); write-only
  password inputs; decrypt server-side only at call time. No token value in logs.
- RBAC: token management = `llmTokens:manage` (admin+editor). Do not widen `pipeline:configure`. Every token
  server action calls `requireUser()` + `requirePermission`.
- The `via:"mock"` / `aiDegraded` degradation contract is unchanged — token exhaustion falls through all tokens →
  next provider → mock, exactly as before.
- Runtime effect: adding a token takes effect on the next run with NO restart (per-run async pool read).
- `bun run test:pure` stays green; `tsc --noEmit` clean; French UI copy; customized Next.js (AGENTS.md) — read
  `node_modules/next/dist/docs/` before touching any Next API (server actions, RSC, route handlers).
- Cooldown/flaky are best-effort signals; a stats-update or single-token failure must never crash an LLM call.

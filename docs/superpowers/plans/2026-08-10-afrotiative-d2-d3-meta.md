# D2 + D3 — Adaptateurs Meta (Facebook Page, Instagram) — Spec & Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Store social credentials safely, then turn D1's `StubChannel` into two real adapters — a Facebook Page post and an Instagram feed post — both driven by the Meta Graph API.

**Architecture:** D1's registry already isolates everything an adapter touches: one `send` method behind `SocialChannel`. This sub-project adds the one thing D1 deliberately left out — credential storage — and then implements two `send`s against it. Facebook and Instagram share a Meta app, a token shape and an app review, so they are one sub-project, not two.

**Tech Stack:** Next.js 16 App Router · TypeScript · Bun · Drizzle/Postgres · Meta Graph API · `node:crypto` (AES-256-GCM)

**Programme:** `docs/superpowers/specs/2026-08-09-afrotiative-studio-diffusion-roadmap.md` — see «Décisions D2 → D7».

> **Note on format.** Spec and plan are combined in this one document. The earlier sub-projects (V1, V2, V3, D1) each got a separate design spec because each introduced genuinely new architecture. This one does not: D1 fixed the interface, and the design questions here reduce to two decisions already recorded in the roadmap (credentials in the database, encrypted at rest) plus the shape of two HTTP calls.

## Decisions already taken (roadmap, 2026-08-10)

- **Credentials live in the database**, in `social_channel_settings`, so an admin can rotate a token from `/settings/social/[channel]` without a redeploy — decisive because Meta long-lived Page tokens expire around 60 days.
- **Therefore they must be encrypted at rest** (AES-256-GCM, key from an env var), never returned in plaintext to a client, and the UI shows a masked value while accepting writes only.
- Build order: Facebook + Instagram together, then LinkedIn, then WhatsApp. X and TikTok deferred.

## Global Constraints

- **Read the Next.js docs** under `node_modules/next/dist/docs/01-app/` before writing Server Actions — `AGENTS.md` requires it; this version has breaking changes vs. training data.
- **Every export of a `"use server"` module is an unauthenticated Server Action** (`lib/actions/taxonomy-actions.ts:5-11`). Guard first; raw writers in a plain module.
- **The human-review barrier is untouchable.** `tests/publish-due.test.ts` and `tests/wp-publish.test.ts` must stay green **and unmodified**.
- **Never log a credential**, not even truncated, and never return one to a client. A decrypted secret exists only inside a server-side send.
- All user-facing strings in **French**; **Base UI** (`render` prop, never `asChild`).
- **No real network calls in tests.** `tests/wp-publish.test.ts` is the precedent: a `Bun.serve` fake WordPress, injected by base URL. Do the same for Graph.
- **Never run two `bun test` invocations concurrently** (`test-setup.ts:38-40`).
- **Three suite failures are pre-existing** — `pipeline-web-search` (a) and (d), `pipeline-pause-resume` checkpoint (b) — each attributed by replaying the file at the branch point.
- Commit messages in **French**, prefix `feat(diffusion):`, ending with:
  `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`

---

### Task 1: Credential storage, encrypted at rest

**Files:** `lib/diffusion/crypto.ts`, `db/schema.ts` + migration, `lib/diffusion/settings-core.ts`, `lib/actions/diffusion-settings-actions.ts`, `components/settings/social-channel-form.tsx`, `lib/validation.ts`, `.env.example`, `docs/DEPLOYMENT.md`, `tests/diffusion-crypto.test.ts`

**Contract:**

`lib/diffusion/crypto.ts` — `encryptSecret(plain): string` / `decryptSecret(stored): string`, AES-256-GCM with a random IV per encryption and the auth tag stored alongside. Key from `CREDENTIALS_ENCRYPTION_KEY` (32 bytes, base64). **Missing key ⇒ the feature is unavailable, not a crash**: follow `getWpConfig()`'s idiom and return `null` from a `getCryptoConfig()`, so credential fields simply cannot be saved and the UI says so in French.

`social_channel_settings` gains **encrypted** credential columns. Design them generically rather than per-platform — Facebook needs a page id + token, Instagram an IG user id + the same token, LinkedIn an organization URN, WhatsApp none. A single `credentials` jsonb holding an encrypted blob, plus a plaintext `credentialsSetAt` timestamp for the UI, is one reasonable shape; per-column is another. **Choose and justify it in your report** — the criterion is that adding LinkedIn's URN later must not need a migration.

The settings action never returns plaintext. The form shows « Défini le … » or « Non défini », an input that writes only, and a *Supprimer* action.

**Tests:** round-trip encrypt/decrypt; two encryptions of the same plaintext differ (random IV); a tampered ciphertext fails to decrypt rather than returning garbage; no key ⇒ save refused with a French message; the settings query never returns plaintext; a `console.log` of a settings row contains no secret.

### Task 2: Graph client + Facebook adapter (D2)

**Files:** `lib/diffusion/meta/graph-client.ts`, `lib/diffusion/meta/facebook.ts`, `lib/diffusion/channels.ts`, `tests/diffusion-facebook.test.ts`

**Contract:** a small Graph client with an injectable base URL — that injection is what makes a `Bun.serve` fake possible, and it is the only reason the WordPress adapter is testable today.

Facebook `send`: publish a **photo post** to the Page — `POST /{page-id}/photos` with `url` (the render's public R2 URL), `caption`, `access_token`. Return the created post id as `externalId`.

**Write `externalId` as early as the API allows.** D1's review flagged the at-least-once problem: a crash after Graph accepts but before we record the id means a retry double-posts. This is where that gets addressed for Facebook — do it, and say in your report what window remains.

Map Graph errors to French messages. An expired token in particular must say so plainly and point at the settings page, because it *will* happen every ~60 days.

**Tests** (fake Graph, no network): a successful post records `externalId` and marks `sent`; a Graph error becomes a French message and `failed` with `attempts` incremented; an expired-token error (code 190) produces a distinct, actionable message; missing credentials refuse before any HTTP call.

### Task 3: Instagram adapter (D3)

**Files:** `lib/diffusion/meta/instagram.ts`, `lib/diffusion/channels.ts`, `tests/diffusion-instagram.test.ts`

**Contract:** Instagram publishing is **two steps**, unlike Facebook: `POST /{ig-user-id}/media` with `image_url` + `caption` creates a container, then `POST /{ig-user-id}/media_publish` with `creation_id` publishes it. The container is also **asynchronous** — it can return before the image is fetched, so a publish immediately after may fail with a not-ready error.

Handle that: poll the container's `status_code` until `FINISHED`, with a bounded number of attempts and a clear French message on timeout. Do not busy-loop.

The image URL must be publicly reachable — R2 already satisfies this, which is why storage was chosen in V1.

**The two-step flow makes the duplicate problem sharper**: a crash between container creation and publish leaves an orphan container; a crash after publish repeats Facebook's window. Record the container id as soon as it exists.

**Tests** (fake Graph): the two-step happy path publishes and records `externalId`; a container stuck `IN_PROGRESS` times out with a French message; an `ERROR` status fails cleanly; a crash-after-publish scenario is described in the report even if not directly testable.

### Task 4: Settings UI, docs, and the reaper cutoff

**Files:** `components/settings/social-channel-form.tsx`, `docs/DEPLOYMENT.md`, `README.md`, `lib/diffusion/scheduler.ts`, `tests/diffusion-reaper.test.ts`

**Contract:** the per-channel settings page gains the credential fields for Facebook (page id, token) and Instagram (IG user id — reusing the same token), masked as Task 1 specifies, with a *Tester la connexion* action that makes one **free** Graph call (`GET /me` or the page node) and reports success in French. Model it on `testIntegration` (`lib/actions/integration-actions.ts`), which is explicit that a connectivity check must never spend tokens.

Parameterize the reaper cutoff — D1 left `STALE_PENDING_MINUTES = 10` hardcoded, and the D1 review flagged that it becomes a correctness assumption about adapter latency the moment a real adapter lands. Instagram's container polling makes a send legitimately slower than a stub. Follow `RUN_STALE_MINUTES`'s precedent.

Document in `docs/DEPLOYMENT.md`: the Meta app prerequisites, which permissions need review, how to obtain a long-lived Page token, that it expires around 60 days, and `CREDENTIALS_ENCRYPTION_KEY` (how to generate it, and that losing it makes stored credentials unrecoverable).

**Tests:** the connection test makes exactly one HTTP call and no publish; the reaper honours the configured cutoff.

---

## Self-Review

**Coverage:** credentials → Task 1; D2 → Task 2; D3 → Task 3; operations → Task 4.

**Risks:**
1. Task 1 is the security-sensitive one. A leaked secret in a log or a server-action return is the failure that matters; test for it explicitly rather than assuming.
2. Instagram's asynchronous container is the piece most likely to work in a fake and fail against the real API. Say clearly in the report what could not be verified without credentials.
3. Neither adapter can be verified end to end until the Meta app review clears. Everything here is fake-server-tested by construction — do not claim otherwise.

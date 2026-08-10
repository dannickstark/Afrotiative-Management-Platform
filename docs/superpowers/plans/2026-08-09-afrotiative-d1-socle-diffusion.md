# D1 — Socle de diffusion — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Everything needed to distribute an article to a social network — except the networks. Data model, channel registry, per-channel settings, AI captions, the Diffusion panel, the automatic scheduler, and the audit trail.

**Architecture:** D1 ships with **no real adapters**. A `StubChannel` records a send without any network call, exactly as V1 shipped headless. That makes the whole socle verifiable end to end and reduces D2 (Facebook) to writing one `send` behind an interface that is already proven.

**Tech Stack:** Next.js 16 App Router (RSC + Server Actions) · TypeScript · Bun · Drizzle/Postgres · croner (the existing in-app scheduler) · Vercel AI SDK (existing provider chain with mock fallback) · shadcn on Base UI

**Spec:** `docs/superpowers/specs/2026-08-09-afrotiative-d1-socle-diffusion-design.md`

## Plan style

Contract-first, like V2 and V3: exact names, signatures, French copy and acceptance criteria are binding; how you build it is yours. V1's plan carried full sample code and reviewers found real defects *in that code* on nine of thirteen tasks. **Use a mid-tier model or better for every task here.**

## Global Constraints

- **Read the Next.js docs** under `node_modules/next/dist/docs/01-app/` before writing routes, Server Actions or config. `AGENTS.md` requires it; this version has breaking changes vs. training data.
- **Every export of a `"use server"` module is an unauthenticated Server Action** (`lib/actions/taxonomy-actions.ts:5-11`). Guard first with `requireUser()` + `requirePermission()`; keep raw writers in a plain module, as `lib/studio/template-core.ts` does.
- **The human-review barrier is untouchable.** `publishDueArticles` selects only `status='approved'`. `tests/publish-due.test.ts` and `tests/wp-publish.test.ts` must stay green **and unmodified**. If a change seems to require editing them, stop and report.
- **The `wordpress` channel must keep working unchanged.** `distributions` is extended, never reshaped.
- **No new PostgreSQL enums** — `text` + TypeScript unions. Reason documented on `alerts.type` (`db/schema.ts`).
- All user-facing strings in **French**; actions return `{ ok: false, message }` rather than throwing.
- **Base UI, not Radix:** `render={<Component />}`, never `asChild`.
- **Never run two `bun test` invocations concurrently** (`test-setup.ts:38-40`). DB-writing tests delete their fixtures defensively in `beforeAll` and clean up in `afterAll` even on failure.
- **Three suite failures are pre-existing** — `pipeline-web-search` cases (a) and (d), `pipeline-pause-resume` checkpoint (b) — each attributed by replaying the file at the branch point. Anything beyond those three is yours.
- Commit messages in **French**, prefix `feat(diffusion):`, ending with:
  `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`

## What V1/V2/V3 already give you

`renderForArticle(articleId, { context, channel })` → `{ok:true,url,renderId,degraded}` | `{ok:true,url:null,…}` | `{ok:false,reason,message}`. `CHANNELS`, `Channel`, `TemplateContext`, `FORMAT_PRESETS`, `FormatKey`. The studio can author `social_post` templates per channel. `lib/ai/` has a provider chain with a mock fallback so it runs without keys. `lib/pipeline/scheduler.ts` is a croner singleton started from `instrumentation.ts`.

---

# Lot 1 — Données & registre

### Task 1: Schema + RBAC

**Files:** `db/schema.ts`, `db/migrations/*` (generated), `lib/rbac.ts`, `tests/diffusion-schema.test.ts`

**Contract:** add to `distributions`: `renderId` (uuid, **no FK** — diffusion history, not a live join, same reasoning as `renders.subjectId`), `caption`, `attempts` (int, default 0), `lastError`, `scheduledFor`, `sentAt`, `triggeredBy` (`manual`|`scheduled`), `actorId` → `user.id`.

Add a **partial unique index**: at most one row per `(article_id, channel)` where `channel <> 'wordpress'` and `status IN ('pending','sent')`. This is the hard guarantee that the scheduler cannot double an operator's manual send.

New table `social_channel_settings`: `channel` (pk, text), `enabled`, `captionMaxChars`, `captionPrompt`, `autoEnabled`, `autoIntervalHours`, `autoMaxBacklogDays`, `autoWindowStartHour`, `autoWindowEndHour`, `lastAutoSendAt`, `updatedAt`.

RBAC resource `social`: `read` / `manage` / `send`. Admin gets all three; **editor gets `read` and `send` but not `manage`**; journalist none.

**Note on the index:** V1 learned that drizzle 0.45 does not expose `.nullsNotDistinct()` on `uniqueIndex()` and that hand-editing the generated SQL is this repo's established pattern (`db/migrations/0007_run_control_index.sql`). Check whether your predicate needs anything drizzle cannot emit, and if so hand-edit — then **verify against the live database** with `pg_indexes`, not by trusting the file.

**Tests:** two `pending` rows for the same (article, non-wordpress channel) → rejected; a `wordpress` row alongside a `facebook` row → allowed; a `failed` row does not block a retry; editor refused on `manage`, allowed on `send`; journalist refused on both.

### Task 2: Channel registry + `StubChannel`

**Files:** `lib/diffusion/channels.ts`, `lib/diffusion/stub-channel.ts`, `tests/diffusion-channels.test.ts`

**Contract:** the `SocialChannel` interface from spec §2 — `key`, `label` (French), `context` (always `social_post` in D1), `format` (`FormatKey`), `captionLimits {min,max,default}`, `send(input): Promise<SendResult>`.

`captionLimits` carries each platform's **official** limits, hard-coded, because they are not negotiable — a user setting can never exceed them. Research the real values and cite your source in a comment; do not invent them.

`StubChannel.send` logs, returns a synthetic `externalId`, and never touches the network. Register all five channels against it.

**Tests:** every `Channel` in `CHANNELS` has a registry entry; `captionLimits.default <= max` and `>= min` for each; `StubChannel.send` makes no network call (assert by injecting a fetch that throws if called).

### Task 3: Settings read/write core + queries

**Files:** `lib/diffusion/settings-core.ts`, `lib/queries/diffusion.ts`, `lib/actions/diffusion-settings-actions.ts`, `tests/diffusion-settings.test.ts`

**Contract:** `getChannelSettings(channel)` returns the row, **creating it lazily** from the registry defaults on first read. `updateChannelSettings(channel, patch)` guarded by `social:manage`, clamping `captionMaxChars` into `captionLimits` and refusing out-of-range values with a French message naming the bounds.

`listDistributionsForArticle(articleId)` for the panel.

**Tests:** lazy creation yields registry defaults; `captionMaxChars` above `captionLimits.max` refused; editor refused on update; the clamp message names the actual bound.

---

# Lot 2 — Envoi & panneau

### Task 4: AI caption generation

**Files:** `lib/diffusion/caption.ts`, `tests/diffusion-caption.test.ts`

**Contract:** `generateCaption({ articleId, channel })` → `{ ok: true, caption }` | `{ ok: false, message }`. Uses the existing `lib/ai/` provider chain (which already falls back to a mock, so it runs with no keys). French prompt, fed the title, excerpt and category, instructed to respect the channel's configured `captionMaxChars`.

**A model does not reliably obey a character limit**, so truncate defensively after generation — on a word boundary, with an ellipsis. Without a usable provider, fall back deterministically to a truncated title rather than erroring.

**Tests:** the result never exceeds `captionMaxChars`; a deliberately over-long model response is truncated on a word boundary; with no provider the deterministic fallback is used and is still within the limit.

### Task 5: `sendToChannel`

**Files:** `lib/diffusion/send-core.ts`, `lib/actions/diffusion-actions.ts`, `tests/diffusion-send.test.ts`

**Contract:** `sendToChannel({ articleId, channel, caption, triggeredBy, actorId })` guarded by `social:send`.

Order matters and is the point of this task:
1. Refuse unless `articles.status === 'published'` — the social card may carry `{{article.url}}` as a QR code, and that URL only exists after WordPress publication. Same ordering constraint V1 encodes in `CONTEXT_TOKENS`.
2. Refuse if the channel is disabled, with the reason.
3. `renderForArticle(articleId, { context: 'social_post', channel })`. `{ok:false}` → **refuse the send** and surface the message; shipping a card with no image is worse than a clear failure. `{ok:true,url:null}` → refuse too, with a message pointing at the studio: a social post with no image is not a thing this product does.
4. Insert/update the `distributions` row with `renderId`, `caption`, `triggeredBy`, `actorId`.
5. Call `channel.send`. Success → `status: 'sent'`, `sentAt`, `externalId`. Failure → `status: 'failed'`, `attempts + 1`, `lastError` in French.
6. Either way, append an `article_revisions` entry — that is the audit trail, and it mirrors what WordPress publication already does.

`renderId` is written **once** and never rewritten on retry: the render is immutable after diffusion.

**Tests:** an unpublished article is refused; a disabled channel is refused; a failing render refuses the send and writes no `sent` row; success sets `renderId`/`sentAt`/`externalId` and adds a revision; a failure increments `attempts` and sets `lastError`; a retry after failure **reuses the same `renderId`**; a second successful send is prevented by the unique index.

### Task 6: Diffusion panel

**Files:** `components/article/diffusion-panel.tsx`, `app/(app)/article/[id]/page.tsx`, `components/article/editor-shell.tsx`, `tests/diffusion-panel.test.ts`

**Contract:** one card per **enabled** channel, below the image tabs. Each shows the channel's own render preview, the AI-prefilled editable caption with a live character counter against the limit, a **Publier sur {canal}** button, and the current state (never sent / sent at … / failed with message and *Réessayer*).

The button is disabled — with the reason visible, not a click-time error — when: the article is not `published`; the channel is disabled; R2 is unconfigured; or the user lacks `social:send`.

Caption generation is **on demand** (a button), not on page load: it costs a model call per channel and most article views will not send.

**Tests:** the button is disabled with the right reason in each of the four cases; the counter reflects the configured limit; a failed send surfaces `lastError` and offers retry.

---

# Lot 3 — Réglages

### Task 7: `/settings/social`

**Files:** `app/(app)/settings/social/page.tsx`, `app/(app)/settings/social/[channel]/page.tsx`, `components/settings/social-channels.tsx`, `components/shell/nav-items.ts`, `tests/diffusion-settings-ui.test.ts`

**Contract:** the list shows each channel with its enabled state and a summary of its automatic-publication config. The detail page carries: enabled, `captionMaxChars` (bounded by `captionLimits`, with the bounds shown), optional prompt override, and the automatic block — `autoEnabled`, `autoIntervalHours`, `autoMaxBacklogDays`, `autoWindowStartHour`, `autoWindowEndHour`.

Admin only (`social:manage`). Add *Réseaux sociaux* to the Réglages nav section, and re-use `SETTINGS_CHILDREN` so the horizontal settings nav and the sidebar cannot drift — that shared list already exists for exactly this reason.

**Tests:** an editor reaching the page is refused; the bounds are rendered from `captionLimits`, not hard-coded.

---

# Lot 4 — Planificateur

### Task 8: Selection and due logic (pure)

**Files:** `lib/diffusion/schedule-core.ts`, `tests/diffusion-schedule.test.ts`

**Contract:** two pure, separately testable pieces.

`isDue({ now, lastAutoSendAt, autoIntervalHours, autoWindowStartHour, autoWindowEndHour })` → boolean. Outside the window it returns false **and the interval is not consumed** — a newsroom does not post at 4am, and a tick that does nothing must not count as a send.

`selectNextArticleQuery({ channel, now, maxBacklogDays })` → the criteria for: `articles.status = 'published'`, `publishedAt` within `[now - maxBacklogDays, now]`, **no** `distributions` row for this channel with status `pending` or `sent`, ordered by `publishedAt` **ascending**, limit 1.

That ascending sort *is* the user's rule — "oldest to newest, and if today is exhausted walk back to yesterday" falls out of it automatically. Do not implement day-by-day iteration; say so in a comment so nobody later "fixes" it into a loop.

**Tests:** ordering is ascending; an already-sent article is excluded; a `failed` row does **not** exclude (it should be retryable); `maxBacklogDays` is respected at the boundary; `isDue` false before the interval, true after; outside the window false at any interval; the window correctly handles a range that wraps midnight (e.g. 22 → 6) — decide whether to support that and say so.

### Task 9: Wire into the scheduler + docs

**Files:** `lib/diffusion/scheduler.ts`, `lib/pipeline/scheduler.ts` (extend, do not duplicate), `instrumentation.ts`, `README.md`, `docs/DEPLOYMENT.md`, `tests/diffusion-scheduler.test.ts`

**Contract:** one tick per channel with `autoEnabled`. On each: check `isDue`, select the next article, set `lastAutoSendAt` **before** sending (so a slow send cannot be picked up twice), then `sendToChannel(..., triggeredBy: 'scheduled', actorId: null)`.

Extend the **existing** croner singleton rather than adding a second scheduler — one process, one job, matching the single-instance Railway deployment. Follow the existing `[scheduler]` French logging convention and its never-throw contract: croner fires off its own timer, so an escaping rejection would surface only as an unlabelled unhandled rejection.

Document in `README.md` and `docs/DEPLOYMENT.md`: what automatic publication does, that it is **off by default**, and that D1 ships with a stub that sends nothing to a real network.

**Tests:** a due channel sends exactly one article; a not-due channel sends none; two consecutive ticks do not double-send the same article; `lastAutoSendAt` is persisted so a simulated restart does not produce a burst; a send failure does not wedge the scheduler (the next tick still runs).

---

## Self-Review

**Spec coverage:** §1 → Task 1; §2 → Task 2; §3 → Task 4; §4 → Tasks 5, 6; §5 → Tasks 8, 9; §6 → Tasks 3, 7; §7 → Tasks 5, 6; §8 → every task; §9 → the four lots.

**Risks flagged for implementers:**
1. Task 1's partial unique index is the anti-double-send guarantee. Verify it in the live database, not in the migration file — V1 learned this the hard way.
2. Task 5's ordering (published-check → render → row → send) is the task; getting it wrong produces a `sent` row with no image or a send with no audit entry.
3. Task 8's ascending sort replaces day-by-day iteration. A later "fix" that adds a loop would reintroduce the bug the sort avoids.
4. Task 4's truncation matters because models do not obey character limits reliably.

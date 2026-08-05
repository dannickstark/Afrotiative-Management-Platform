# SP9 — Failure alerting (in-app + optional email) — Plan

**Goal:** Alert on (a) a run that finalizes `failed` and (b) a feed gone dark (`failing`). Surface **in-app** (notifications bell + list, dashboard banner) AND via **optional email** (provider + key + toggle, default OFF until configured). The final sub-project.

**Branch:** `feat/pipeline-v2` (after SP8). Two dispatches: **SP9a** (data + triggers + email backend), **SP9b** (in-app surface + settings UI).

## Decisions
- Channel = **both**. Email is **default off**, opt-in via settings + requires a provider key; a no-op (never throws) when disabled/unconfigured.
- Triggers: `run_failed` (a run finalizing status `failed` — NOT partial/cancelled) and `feed_dark` (a feed crossing to `failing` — created only on the TRANSITION, not every read, so one alert per dark episode).

## Data model (additive migration)
- New `alerts` table: `id uuid pk`, `type text` (`'run_failed'|'feed_dark'`), `title text` (French), `detail text`, `entityId uuid` (the run or feed id, nullable), `read boolean not null default false`, `createdAt timestamp default now()`. Index on `(read, created_at)`.
- Add to `pipeline_settings`: `alertEmailEnabled boolean not null default false`, `alertEmailRecipients text` (nullable, comma-separated emails).

---

## SP9a — Alerts backend (data + triggers + email)

### 1. Migration + schema (above).

### 2. `lib/alerts/notify.ts` — `createAlert(input): Promise<void>` (best-effort, never throws)
`input = { type, title, detail, entityId }`. Inserts the alert row; THEN, if `alertEmailEnabled` AND `alertEmailRecipients` non-empty AND a provider key is set, sends the email best-effort (a send failure is logged `[alerts]` and swallowed). Reads settings via `getPipelineSettings()`. The whole function is wrapped so a failure NEVER propagates to the caller (alerting must never break a run).

### 3. `lib/email/resend.ts` — pluggable email (no new dependency; raw fetch)
`sendEmail({ to: string[], subject, html }): Promise<boolean>` — POSTs to `https://api.resend.com/emails` with `Authorization: Bearer ${RESEND_API_KEY}` and a `from` (env `ALERT_EMAIL_FROM`, default a placeholder like `alerts@afrotiative.local`). Returns false (no throw) if `RESEND_API_KEY` unset or the request fails. Keep it minimal + timeout. (Provider is swappable later; Resend chosen for a simple REST API.)

### 4. Triggers (best-effort at each site — never fail the run/read)
- **run_failed:** in `executeRun`'s finalize (`lib/pipeline/run.ts`), when the terminal `status === 'failed'`, `await createAlert({ type:'run_failed', title:"Exécution du pipeline échouée", detail:<counts/first error summary>, entityId: runId })`. NOT for `partial`/`cancelled`/`success`. Wrap so it can't affect finalization.
- **feed_dark:** in `updateFeedHealth` (`lib/pipeline/feed-health.ts`) on the FAILURE path, when the incremented `consecutiveFailures` reaches the failing threshold (3) — i.e. only on the transition (the read that makes it exactly 3) — `createAlert({ type:'feed_dark', title:"Flux muet", detail:"Le flux « {name} » a échoué {n} fois de suite.", entityId: feedId })`. Requires knowing the resulting streak; since the increment is atomic SQL, use a RETURNING to get the new `consecutiveFailures` and alert when it === 3. Best-effort.

### 5. Settings (validation) — `lib/validation.ts`
Add `alertEmailEnabled` (bool) + `alertEmailRecipients` (optional; if present, validate comma-separated emails — each a basic email regex; empty allowed) to `pipelineSettingsSchema`.

### 6. Tests (bun:test, real Neon dev, cleanup)
- `createAlert` inserts a row; with email disabled → no send attempted (mock/verify `sendEmail` not called or returns without a key); never throws even if the insert or send fails.
- `sendEmail` returns false (no throw) when `RESEND_API_KEY` unset; the payload builder maps `{to,subject,html}` correctly (test a pure `buildResendPayload` if you split it; do NOT hit the network — inject fetch or split parsing).
- Trigger: a run that finalizes `failed` creates exactly one `run_failed` alert (entityId = runId); a `partial`/`cancelled`/`success` run creates NONE. A feed crossing to streak 3 creates one `feed_dark` alert; streak 4/5 create no additional alert; recovery (reset to 0) then re-failing to 3 creates a new one. Full cleanup (delete created alerts, runs, feeds, raw_items).
- `pipelineSettingsSchema` accepts/rejects recipients correctly.

Commit(s): `feat(alerts): alerts table + run-failed/feed-dark triggers + optional email`.

---

## SP9b — In-app alerting surface + settings UI

### 1. Queries + actions
- `lib/queries/alerts.ts`: `getUnreadAlertCount()`, `getRecentAlerts(limit=20)`. (`pipeline:read`.)
- `lib/actions/alert-actions.ts`: `markAlertRead(id)`, `markAllAlertsRead()` (`pipeline:read`; global read-state — small team). Best-effort + revalidate.

### 2. Notifications surface (app shell)
- A `NotificationsBell` client component in the shell (sidebar header or the `NavUser`/inset header area from SP3): a bell icon with an unread-count badge; a dropdown (Base UI) listing recent alerts (type icon, French title, detail, relative time, read/unread), each linking to the run detail (`/runs`, open the run) or the feed (`/settings/feeds`); a "Tout marquer comme lu" action. Poll or refresh the unread count on navigation (RSC refresh is fine; no need for live polling).
- A dashboard alert **banner** (`/dashboard`): if there are unread `run_failed`/`feed_dark` alerts, a dismissible `Card`/banner summarizing them with a link. French, theme-aware.

### 3. Settings UI
- Add to the `/settings/pipeline` form (`PipelineSettingsForm`): an **Alertes** group — `alertEmailEnabled` switch + `alertEmailRecipients` input (comma-separated), with a note that email requires `RESEND_API_KEY` server-side. French.

### 4. Tests
- `getUnreadAlertCount`/`getRecentAlerts` (insert alerts, assert counts/order, cleanup); `markAlertRead`/`markAllAlertsRead` (RBAC + effect). No React harness → the bell/banner are verified by typecheck + a scripted dev boot.

Commit(s): `feat(alerts): in-app notifications bell + dashboard banner + email settings`.

## Global constraints (both)
- Alerting is BEST-EFFORT everywhere — it must NEVER fail a run or a feed read or a settings save. French copy. Additive migration. Email default OFF + no-op without a key. `getPipelineConfig()` stays sync. Preserve the runner invariants (alert creation in finalize is wrapped).

## Verify
`bun run typecheck` 0; `bun test` full suite green. Manual: trigger a failed run in dev → alert appears in the bell + dashboard banner; feed-dark likewise. Update roadmap SP9 box → program complete.

# SP5 — Run Control (per-operation timeout + stop + pause/resume) — Plan

**Goal:** No single operation can run forever; an admin can **stop** a run (cancel) or **pause** it and **resume** the same run later from where it left off. Extends the two-phase `executeRun` + the live panel. **Task-by-task (subagent-driven).**

**Branch:** `feat/pipeline-v2` (after SP4). **Tech:** Next.js 16, Drizzle/Neon, Bun.

## Decisions (roadmap): stop + pause/resume (real checkpointing); per-op timeout configurable in settings (`perOperationTimeoutMs`, SP1, default 300000).

## Design overview
- The detached `executeRun` cannot be interrupted from outside directly, so control is **cooperative via DB flags** the run polls: `cancel_requested` / `pause_requested` booleans on `pipeline_runs`, set by admin actions, checked by `executeRun` at safe boundaries (after phase 1, and between stories in phase 2).
- **Stop** → finalize the run to a new terminal status `cancelled` (unprocessed stories are simply not processed; their members were never recorded, so they resurface next run).
- **Pause** → persist the REMAINING stories to a `checkpoint` (jsonb) and finalize to `paused` (a non-terminal "parked" state). **Resume** re-invokes `executeRun` from the checkpoint (skips feed-reading/grouping; processes the remaining stories).
- **Per-operation timeout** → each stage call is wrapped in `Promise.race` against `perOperationTimeoutMs`; on timeout the step is recorded `failed` ("délai d'opération dépassé"), that story aborts, the run continues — so one stuck provider call can't make a run drag for hours.

## Global constraints
- Preserve the always-finalize + overlap invariants. French copy/step names. Best-effort observability. Human-review barrier intact. Additive migrations only. Do NOT make `getPipelineConfig()` async.

---

## Task 1 — Migration: control flags, checkpoint, new statuses, interlock
- `db/schema.ts`: add to `pipelineRuns`: `cancelRequested boolean not null default false`, `pauseRequested boolean not null default false`, `checkpoint jsonb` (nullable, typed as the remaining-stories payload). Add enum values `cancelled` and `paused` to the `pipelineStatus` pgEnum.
- **Interlock:** change the partial unique index `pipeline_runs_one_running` to cover BOTH active states: `where status in ('running','paused')` — so a paused run still holds the single slot (no new run starts while one is paused). Update `hasRunningRun()` and `reclaimStaleRuns()` in `lib/pipeline/overlap.ts`: `hasRunningRun` returns true for `running` OR `paused`; `reclaimStaleRuns` still only reaps stale `running` (activity-based, from SP2) — NEVER reaps `paused` (intentional).
- Generate + apply migration (note: adding enum values may need care — check drizzle output; `ALTER TYPE ... ADD VALUE`). Tests: round-trip a run with the flags/checkpoint/new statuses; `hasRunningRun` true for a paused run; reaper leaves paused alone.

## Task 2 — Per-operation timeout
- In `lib/pipeline/stages.ts`, wrap each timed stage (the `timed()` helper) so the operation races a timeout of `settings.perOperationTimeoutMs` (pass it into `stageSources`/`timed`). On timeout: the step is `failed` with French message "L'opération « {name} » a dépassé le délai de {N}s.", the error propagates to abort THIS story (articleId null), the run continues. A `perOperationTimeoutMs` of 0/negative disables the timeout (guard).
- Tests: a stage whose fn hangs beyond a tiny test timeout → step recorded failed with the timeout message, story aborts, `stageSources` returns articleId null (no throw to run level). Use a controllable fake stage fn + a small timeout value (inject via the settings row or a param) — do NOT actually wait 5 minutes.

## Task 3 — Stop (cancel)
- `executeRun` (lib/pipeline/run.ts): re-read the run's `cancelRequested` at each safe boundary (after phase 1; before processing each story). If set → break out, finalize status `cancelled` in the `finally` (add `cancelled` to the terminal-status logic; clear currentStage/currentItem; record a French "Exécution annulée par l'utilisateur" step). Already-produced articles stay (pending). Unprocessed stories' members were never recorded → resurface next run.
- New action `cancelRun(runId)` (`pipeline:configure`): set `cancel_requested=true` on the running/paused run. If the run is already terminal, no-op with a friendly message.
- Tests: set cancelRequested mid-run (insert a running run + set the flag, or drive a small executeRun that checks the flag) → run finalizes `cancelled`; cancelRun RBAC.

## Task 4 — Pause / Resume (checkpoint)
- Define the checkpoint payload: the REMAINING stories not yet processed — each story = an array of members `{ feedId, feedName, item: RawItem }` (RawItem is serializable). Store on `pipeline_runs.checkpoint`.
- `executeRun`: at each safe boundary, if `pauseRequested` → persist `checkpoint = remainingStories`, set status `paused` (via finalize path but NON-terminal: set finishedAt? NO — paused is resumable; leave finishedAt null, set a `pausedAt` reuse of updatedAt or just status), clear currentStage/currentItem, record a "Exécution mise en pause" step, and STOP (return without finalizing to a terminal status — but the run row must not be "running" so the finally's terminal-write must be conditional: if paused, write status=paused and DO NOT set a terminal/finishedAt).
- Refactor `executeRun` so phase-2 processing can start EITHER from freshly-grouped stories OR from a checkpoint's remaining stories. Add `resumeRun(runId)` action: loads the run's checkpoint, clears `pause_requested`/`checkpoint`, sets status `running`, and fires a detached `executeRun(runId, { resumeStories: checkpoint })` that skips phase 1 and processes the remaining stories (re-grouping already done). Recompute `total_items`/`processed_items` sensibly on resume (processed carries over).
- `getActiveRun()` (lib/queries/runs.ts): include `paused` runs (status in running/paused) so the live panel can show a paused run + its progress.
- Overlap: a paused run holds the slot (Task 1 index). `resumeRun` only proceeds if the run is `paused`.
- Tests: pause mid-run → status `paused`, checkpoint holds remaining stories, slot still held (hasRunningRun true); resume → processes remaining stories, finalizes; a second run can't start while paused (openRun returns null / skipped).

## Task 5 — Live panel controls
- `components/pipeline/live-run-panel.tsx`: during a `running` run show **Pause** + **Stop** buttons (admin, RoleGate); for a `paused` run show **Reprendre** + **Stop**. Wire to `pauseRun`/`resumeRun`/`cancelRun` actions (async transitions, French toasts). The panel already polls `getActiveRun` — a paused run renders with its progress + the Reprendre button; a cancelled/terminal run flows through the existing terminal path. Add `paused`/`cancelled` to the status label/pill maps (`lib/format.ts` `pipelineStatusLabel` + the panel/detail pill styles) with French labels ("En pause", "Annulée") and sensible colors.
- No automated UI test (no harness) — verify via typecheck + a scripted dev check; the flows are covered by the action/runner tests.

## Task 6 — Verify (whole SP5)
`bun run typecheck` 0; `bun test` full suite green. Manual: start a run in dev, pause it (status→paused, panel shows Reprendre), resume (continues), and stop another (status→cancelled). Update roadmap SP5 box. Commit per task.

## Notes
Checkpoint size is bounded by `maxItemsPerRun` items — fine for jsonb. Pause granularity is per-story (not mid-story) — acceptable and simple. A paused run left indefinitely holds the slot by design; admin can Stop it.

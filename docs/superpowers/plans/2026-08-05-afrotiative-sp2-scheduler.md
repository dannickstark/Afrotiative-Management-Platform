# SP2 — In-app pipeline scheduler — Plan

**Goal:** Trigger scheduled pipeline runs from inside the app, per a cron expression stored in `pipeline_settings.scheduleCron` (SP1), started at server boot via Next.js `instrumentation.ts`. Single-instance-safe via the existing one-running interlock. The external bearer route (`/api/pipeline/run`) stays as a manual/backup trigger.

**Branch:** `feat/pipeline-v2` (after SP1). **Tech:** Next.js 16 (App Router, `instrumentation` hook), Bun, Drizzle/Neon.

## Global constraints
- **This is NOT the Next.js you know** — before writing `instrumentation.ts`, READ `node_modules/next/dist/docs/` for the current `instrumentation`/`register` API and heed deprecations. Confirm the hook name/signature there rather than assuming.
- French log messages. Runtime-only (guard `process.env.NEXT_RUNTIME === "nodejs"`) — never schedule during build or on edge.
- Preserve the overlap interlock: a scheduled trigger must no-op if a run is already running (`hasRunningRun()`), never crash on overlap.
- Do NOT make `getPipelineConfig()` async. The scheduler reads `getPipelineSettings()` (async, SP1).

## Design

### Dependency
Add **`croner`** (`bun add croner`) — a small, zero-dependency cron scheduler/parser for Node. Rationale: hand-rolling a cron matcher is error-prone; croner both parses and schedules, and validates expressions (used by the settings Zod validator too).

### `lib/pipeline/scheduler.ts` (new, module singleton)
```ts
import { Cron } from "croner";
let job: Cron | null = null;

async function triggerScheduledRun(): Promise<void> {
  const { hasRunningRun } = await import("./overlap");
  if (await hasRunningRun()) { console.log("[scheduler] exécution déjà en cours — déclenchement ignoré"); return; }
  const { runPipeline } = await import("./run");
  const res = await runPipeline({ triggeredBy: "scheduled" });
  console.log(`[scheduler] exécution planifiée: ${res.status} (${res.produced} article(s))`);
}

// (Re)configure the schedule from the current DB settings. Called at boot AND after a settings
// change (same process, single instance) so a new cron takes effect without a restart.
export async function reloadSchedule(): Promise<void> {
  job?.stop(); job = null;
  const { getPipelineSettings } = await import("@/lib/queries/settings");
  const { scheduleCron } = await getPipelineSettings();
  if (!scheduleCron || !scheduleCron.trim()) { console.log("[scheduler] aucune planification configurée"); return; }
  try {
    job = new Cron(scheduleCron, { protect: true }, triggerScheduledRun); // protect: skip overlapping fires
    console.log(`[scheduler] planification active: ${scheduleCron} (prochaine: ${job.nextRun()?.toISOString()})`);
  } catch (e) {
    console.error(`[scheduler] cron invalide « ${scheduleCron} » — planification désactivée: ${(e as Error).message}`);
  }
}

export async function initScheduler(): Promise<void> { await reloadSchedule(); }
```
Notes: `protect: true` prevents overlapping fires from croner itself; `hasRunningRun()` guards against overlap with manual/external runs too. `runPipeline` is awaited inside the cron callback (a scheduled run wants a definitive result + logs) — croner runs it off the timer, not blocking requests.

### `instrumentation.ts` (repo root, new) — VERIFY the API against next docs first
```ts
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { initScheduler } = await import("@/lib/pipeline/scheduler");
  await initScheduler();
}
```
Confirm `instrumentation.ts` location + `register` export are correct for THIS Next version (docs). If Next 16 requires enabling it via config, do so.

### Hook settings changes → `reloadSchedule()`
In `lib/actions/pipeline-settings-actions.ts` (`updatePipelineSettings`), AFTER the successful upsert + `revalidatePath`, dynamically import and call `reloadSchedule()` so a cron change takes effect live in the running process:
```ts
try { const { reloadSchedule } = await import("@/lib/pipeline/scheduler"); await reloadSchedule(); }
catch (e) { console.error("[scheduler] rechargement après mise à jour des réglages échoué:", e); }
```
Best-effort — a scheduler reload failure must not fail the settings save.

### Settings validation for cron (extend SP1's Zod)
In `lib/validation.ts`, make `scheduleCron` in `pipelineSettingsSchema` validate as an OPTIONAL, possibly-empty cron: allow `""`/null (no schedule) or a string that `croner` accepts. Validate by attempting `new Cron(value, { paused: true })` in a `.refine()` (wrap in try/catch → false on throw) so an invalid cron is rejected at save time with a clean French message. (Import `Cron` in validation.ts is fine — it's not a `"use server"` file.)

## Tests (bun:test, real Neon dev, cleanup mandatory)
1. `triggerScheduledRun` no-ops when a run is already running: insert a `running` pipeline_runs row → call the (exported-for-test or via a thin wrapper) trigger → assert NO new run row created + the running row untouched; clean up. (Export `triggerScheduledRun` or test via `reloadSchedule` is hard to time — prefer exporting `triggerScheduledRun` for direct unit testing.)
2. `reloadSchedule` with `scheduleCron = null` leaves `job` null (no schedule); with a valid cron sets a job with a `nextRun()` in the future; with an invalid cron does not throw and leaves job null. (Snapshot/restore the `pipeline_settings` singleton row.)
3. `pipelineSettingsSchema` rejects an invalid cron string and accepts a valid one (e.g. `"0 * * * *"`) and empty.

Keep timing out of tests (don't wait for a cron to fire). Test the decision logic + config wiring only.

## Verify
`bun run typecheck` 0 errors; `bun test` full suite green; and a manual note: `bun run dev` boots without scheduler errors (log line "aucune planification configurée" when unset). Commit: `feat(pipeline): in-app cron scheduler via instrumentation`.

## Out of scope
Timezone UI (croner defaults to server TZ — fine for now; note it). Multi-instance coordination (Railway is single-instance; the interlock is the backstop). Distributed locking.

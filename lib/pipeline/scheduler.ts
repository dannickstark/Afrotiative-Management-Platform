import { Cron } from "croner";

// Module-singleton scheduled job (SP2). One process, one job — matches the single-instance
// Railway deployment; the pipeline_runs_one_running interlock (hasRunningRun()) is the backstop
// against any accidental overlap (e.g. a manual trigger racing a scheduled fire).
let job: Cron | null = null;

// D1 §5 (Task 9): the automatic social-diffusion tick. EXTENDS this same module/file rather than
// standing up a second scheduling mechanism elsewhere — same croner import, same never-throw +
// [scheduler]-logging conventions, same initScheduler() entrypoint from instrumentation.ts.
//
// It is a SECOND Cron object, not a second callback bolted onto `job` above — deliberately, and
// worth spelling out why: `job` only exists, and only fires, when an admin has configured
// pipeline_settings.scheduleCron (reloadSchedule leaves `job` null otherwise, e.g. on a fresh
// install, or a deployment that only ever triggers ingestion via the external-cron `/api/pipeline/
// run` route instead). Piggy-backing diffusion on that SAME job would make "does automatic social
// posting ever run" depend on an unrelated, optional, and possibly-off pipeline setting — silently
// breaking the very feature this task ships whenever ingestion scheduling isn't configured. Each
// channel's OWN cadence is still exactly one thing: autoIntervalHours, gated by isDue
// (lib/diffusion/schedule-core.ts). This job's cron expression is only how often that gets
// CHECKED — a fixed constant, not an admin-facing setting (no field for it exists on
// /settings/social/[channel]), because checking is cheap and every actual decision still goes
// through isDue.
let diffusionJob: Cron | null = null;
const DIFFUSION_TICK_CRON = "*/15 * * * *"; // every 15 minutes

// Exported (not just used internally by the Cron callback) so tests can call it directly without
// waiting on a real cron fire — see the plan's "no timing-dependent tests" constraint.
//
// Never throws: croner fires this off its own timer, so a rejection here would surface only as an
// unlabeled unhandled promise rejection (bypassing the [scheduler] French logging convention and
// leaving the operator no visible trace of a broken scheduled run). Catch everything, log it in
// the convention, and keep the scheduler alive for the next fire. (`catch: true` on the Cron
// options below is defense in depth for anything that could still escape.)
export async function triggerScheduledRun(): Promise<void> {
  try {
    const { hasRunningRun } = await import("./overlap");
    if (await hasRunningRun()) {
      console.log("[scheduler] exécution déjà en cours — déclenchement ignoré");
      return;
    }
    const { runPipeline } = await import("./run");
    const res = await runPipeline({ triggeredBy: "scheduled" });
    console.log(`[scheduler] exécution planifiée: ${res.status} (${res.produced} article(s))`);
  } catch (e) {
    console.error("[scheduler] échec du déclenchement planifié : " + (e as Error).message);
  }
}

// Exported for the same reason as triggerScheduledRun above: tests call it directly instead of
// waiting on a real cron fire. Never throws — triggerDiffusionTick (lib/diffusion/scheduler.ts)
// already catches everything internally (per-channel, and around its own reaper pass), so this
// try/catch is defense in depth only, matching triggerScheduledRun's own belt-and-suspenders shape
// (croner's catch: true below is a third layer).
export async function triggerScheduledDiffusionTick(): Promise<void> {
  try {
    const { triggerDiffusionTick } = await import("../diffusion/scheduler");
    await triggerDiffusionTick();
  } catch (e) {
    console.error("[scheduler] échec du tic de diffusion automatique : " + (e as Error).message);
  }
}

// Starts the diffusion tick job once, unconditionally (unlike reloadSchedule, there is no DB
// setting that could leave it deliberately unscheduled — see DIFFUSION_TICK_CRON's comment above).
// Idempotent: initScheduler() is the only caller today, but guarding against a second call is
// cheap insurance against ever double-scheduling if that changes.
function startDiffusionScheduler(): void {
  if (diffusionJob) return;
  try {
    // protect: true / catch: true — same reasoning as the pipeline job below: skip a re-fire while
    // the previous tick is still running, and swallow+log anything that could still escape
    // triggerScheduledDiffusionTick's own try/catch.
    diffusionJob = new Cron(DIFFUSION_TICK_CRON, { protect: true, catch: true }, triggerScheduledDiffusionTick);
    console.log(`[scheduler] tic de diffusion automatique actif : ${DIFFUSION_TICK_CRON} (prochain : ${diffusionJob.nextRun()?.toISOString()})`);
  } catch (e) {
    // Reaching here would mean DIFFUSION_TICK_CRON itself is invalid — a bug in this file, not
    // anything an operator configured. Degrade the same way reloadSchedule does: log, leave the
    // job cleared, let the app boot regardless (this runs from instrumentation.register(), where a
    // rejection would take the whole process down — see reloadSchedule's own comment below).
    console.error(`[scheduler] échec de démarrage du tic de diffusion automatique : ${(e as Error).message}`);
  }
}

// (Re)configures the schedule from the current DB settings (pipeline_settings.scheduleCron).
// Called at boot (initScheduler) AND after a settings change (updatePipelineSettings) — same
// process, single instance — so a new cron takes effect live without a restart.
//
// GENUINELY never throws — this is reached from instrumentation.register() at server boot, where a
// rejected promise makes Next's start-server exit the whole process (register() rejection →
// handlersError() → process.exit(1), for both `next dev` and `next start`). A scheduler that can't
// read its config, or is handed an invalid cron, must degrade to "no schedule" and let the app
// boot — never take it down. So both failure modes are caught: the DB-read (getPipelineSettings)
// and the cron parse (new Cron). On either, the job is left cleared.
export async function reloadSchedule(): Promise<void> {
  job?.stop();
  job = null;
  let scheduleCron: string | null | undefined;
  try {
    const { getPipelineSettings } = await import("@/lib/queries/settings");
    ({ scheduleCron } = await getPipelineSettings());
  } catch (e) {
    console.error("[scheduler] échec de lecture des réglages — planification désactivée : " + (e as Error).message);
    return;
  }
  if (!scheduleCron || !scheduleCron.trim()) {
    console.log("[scheduler] aucune planification configurée");
    return;
  }
  try {
    // protect: true — croner itself skips a new fire while the previous invocation of
    // triggerScheduledRun is still running (belt); hasRunningRun() inside triggerScheduledRun is
    // the DB-level backstop against overlap with a manual/external run too (suspenders).
    // catch: true — croner swallows+logs anything triggerScheduledRun could still throw, so a
    // failed fire can never crash the timer (triggerScheduledRun already catches its own errors).
    job = new Cron(scheduleCron, { protect: true, catch: true }, triggerScheduledRun);
    console.log(`[scheduler] planification active: ${scheduleCron} (prochaine: ${job.nextRun()?.toISOString()})`);
  } catch (e) {
    console.error(`[scheduler] cron invalide « ${scheduleCron} » — planification désactivée: ${(e as Error).message}`);
  }
}

export async function initScheduler(): Promise<void> {
  await reloadSchedule();
  startDiffusionScheduler();
}

// Test-only accessor: reloadSchedule() itself returns void (matches the plan's signature, and
// callers — boot/settings-save — don't need the instance), so tests need a way to observe whether
// a job was actually (re)created without reaching into module internals.
export function getScheduledJob(): Cron | null {
  return job;
}

// Test-only accessor, same reasoning as getScheduledJob above.
export function getDiffusionSchedulerJob(): Cron | null {
  return diffusionJob;
}

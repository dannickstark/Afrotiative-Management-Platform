import { Cron } from "croner";

// Module-singleton scheduled job (SP2). One process, one job — matches the single-instance
// Railway deployment; the pipeline_runs_one_running interlock (hasRunningRun()) is the backstop
// against any accidental overlap (e.g. a manual trigger racing a scheduled fire).
let job: Cron | null = null;

// Exported (not just used internally by the Cron callback) so tests can call it directly without
// waiting on a real cron fire — see the plan's "no timing-dependent tests" constraint.
export async function triggerScheduledRun(): Promise<void> {
  const { hasRunningRun } = await import("./overlap");
  if (await hasRunningRun()) {
    console.log("[scheduler] exécution déjà en cours — déclenchement ignoré");
    return;
  }
  const { runPipeline } = await import("./run");
  const res = await runPipeline({ triggeredBy: "scheduled" });
  console.log(`[scheduler] exécution planifiée: ${res.status} (${res.produced} article(s))`);
}

// (Re)configures the schedule from the current DB settings (pipeline_settings.scheduleCron).
// Called at boot (initScheduler) AND after a settings change (updatePipelineSettings) — same
// process, single instance — so a new cron takes effect live without a restart. Never throws: an
// invalid cron is logged and leaves the schedule disabled rather than crashing the caller (boot,
// or a settings save).
export async function reloadSchedule(): Promise<void> {
  job?.stop();
  job = null;
  const { getPipelineSettings } = await import("@/lib/queries/settings");
  const { scheduleCron } = await getPipelineSettings();
  if (!scheduleCron || !scheduleCron.trim()) {
    console.log("[scheduler] aucune planification configurée");
    return;
  }
  try {
    // protect: true — croner itself skips a new fire while the previous invocation of
    // triggerScheduledRun is still running (belt); hasRunningRun() inside triggerScheduledRun is
    // the DB-level backstop against overlap with a manual/external run too (suspenders).
    job = new Cron(scheduleCron, { protect: true }, triggerScheduledRun);
    console.log(`[scheduler] planification active: ${scheduleCron} (prochaine: ${job.nextRun()?.toISOString()})`);
  } catch (e) {
    console.error(`[scheduler] cron invalide « ${scheduleCron} » — planification désactivée: ${(e as Error).message}`);
  }
}

export async function initScheduler(): Promise<void> {
  await reloadSchedule();
}

// Test-only accessor: reloadSchedule() itself returns void (matches the plan's signature, and
// callers — boot/settings-save — don't need the instance), so tests need a way to observe whether
// a job was actually (re)created without reaching into module internals.
export function getScheduledJob(): Cron | null {
  return job;
}

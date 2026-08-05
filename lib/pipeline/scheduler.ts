import { Cron } from "croner";

// Module-singleton scheduled job (SP2). One process, one job — matches the single-instance
// Railway deployment; the pipeline_runs_one_running interlock (hasRunningRun()) is the backstop
// against any accidental overlap (e.g. a manual trigger racing a scheduled fire).
let job: Cron | null = null;

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
}

// Test-only accessor: reloadSchedule() itself returns void (matches the plan's signature, and
// callers — boot/settings-save — don't need the instance), so tests need a way to observe whether
// a job was actually (re)created without reaching into module internals.
export function getScheduledJob(): Cron | null {
  return job;
}

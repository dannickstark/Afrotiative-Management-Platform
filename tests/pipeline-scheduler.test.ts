import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { db, pipelineRuns, pipelineSettings } from "@/db";
import { eq } from "drizzle-orm";
import { triggerScheduledRun, reloadSchedule, getScheduledJob } from "@/lib/pipeline/scheduler";
import { pipelineSettingsSchema } from "@/lib/validation";
import type { PipelineSettings } from "@/lib/queries/settings";

// ─────────────────────────────────────────────────────────────────────────────
// triggerScheduledRun: must no-op (never call runPipeline / open a new run row) when a run is
// already "running" — the same overlap interlock the manual/external trigger relies on
// (tests/pipeline-run.test.ts "runPipeline overlap guard"). No timing involved: we insert the
// running row directly and call the exported function once, synchronously awaited.
describe("triggerScheduledRun", () => {
  let runningId: string | null = null;

  afterAll(async () => {
    if (runningId) await db.delete(pipelineRuns).where(eq(pipelineRuns.id, runningId));
  });

  it("no-ops (no new run row, running row untouched) when a run is already running", async () => {
    const [run] = await db.insert(pipelineRuns).values({ triggeredBy: "manual", status: "running" }).returning({ id: pipelineRuns.id });
    runningId = run.id;

    const before = await db.$count(pipelineRuns);
    await triggerScheduledRun();
    const after = await db.$count(pipelineRuns);

    // No new row was opened.
    expect(after).toBe(before);

    // The pre-existing running row is untouched (still running, not finalized).
    const [row] = await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, runningId));
    expect(row.status).toBe("running");
    expect(row.finishedAt).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// reloadSchedule: config wiring only — never wait for a cron to actually fire. pipeline_settings
// row id=1 is a shared, app-wide singleton (see tests/pipeline-settings.test.ts) — snapshot once
// and restore exactly at the end. Also re-run reloadSchedule() against the restored snapshot in
// afterAll so no test-created job (module-singleton `job` in lib/pipeline/scheduler.ts) is left
// scheduled past this file's run.
describe("reloadSchedule", () => {
  let snapshot: PipelineSettings | null = null;

  beforeAll(async () => {
    const [row] = await db.select().from(pipelineSettings).where(eq(pipelineSettings.id, 1));
    snapshot = row ?? null;
  });

  afterAll(async () => {
    await db.delete(pipelineSettings).where(eq(pipelineSettings.id, 1));
    if (snapshot) await db.insert(pipelineSettings).values(snapshot);
    // Reset the module-singleton job to match whatever is now really configured (or clear it if
    // the row was absent before this file ran), so no stray test job survives the suite.
    await reloadSchedule();
  });

  async function setScheduleCron(value: string | null): Promise<void> {
    await db.delete(pipelineSettings).where(eq(pipelineSettings.id, 1));
    await db.insert(pipelineSettings).values({ id: 1, scheduleCron: value });
  }

  it("clears the job when scheduleCron is null (no schedule configured)", async () => {
    await setScheduleCron(null);
    await reloadSchedule();
    expect(getScheduledJob()).toBeNull();
  });

  it("clears the job when scheduleCron is an empty/blank string", async () => {
    await setScheduleCron("   ");
    await reloadSchedule();
    expect(getScheduledJob()).toBeNull();
  });

  it("creates a job with a future nextRun() for a valid cron", async () => {
    // Once a year (Jan 1, 00:00) — guaranteed not to fire during this test run, while still
    // giving a definite future nextRun() to assert on.
    await setScheduleCron("0 0 1 1 *");
    await reloadSchedule();

    const job = getScheduledJob();
    expect(job).not.toBeNull();
    const next = job!.nextRun();
    expect(next).not.toBeNull();
    expect(next!.getTime()).toBeGreaterThan(Date.now());
  });

  it("does not throw and leaves no job for an invalid cron", async () => {
    await setScheduleCron("not a cron");
    await expect(reloadSchedule()).resolves.toBeUndefined();
    expect(getScheduledJob()).toBeNull();
  });

  it("replaces a previously-scheduled job when reloaded with a new valid cron", async () => {
    await setScheduleCron("0 0 1 1 *");
    await reloadSchedule();
    const first = getScheduledJob();
    expect(first).not.toBeNull();

    await setScheduleCron("0 0 2 1 *"); // Jan 2 instead of Jan 1 — still far in the future
    await reloadSchedule();
    const second = getScheduledJob();
    expect(second).not.toBeNull();
    expect(second).not.toBe(first);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// pipelineSettingsSchema.scheduleCron is now validated against croner itself (lib/validation.ts
// tries `new Cron(value, { paused: true })`), not a hand-rolled 5-field regex — so a pattern the
// old regex would have rejected (6 space-separated fields, seconds precision) must now pass,
// proving the swap actually took effect rather than just re-implementing the same regex.
describe("pipelineSettingsSchema.scheduleCron (croner-backed)", () => {
  const VALID = {
    maxItemsPerRun: 20, perOperationTimeoutMs: 300000, clusterThreshold: 0.83,
    scoreThreshold: 70, autoPublishEnabled: false, autoPublishMinSources: 2, webSearchEnabled: false,
  };

  it("accepts a 6-field cron with seconds precision (croner supports it, the old regex did not)", () => {
    expect(pipelineSettingsSchema.safeParse({ ...VALID, scheduleCron: "0 0 * * * *" }).success).toBe(true);
  });
  it("accepts null", () => {
    expect(pipelineSettingsSchema.safeParse({ ...VALID, scheduleCron: null }).success).toBe(true);
  });
  it("accepts an omitted scheduleCron", () => {
    expect(pipelineSettingsSchema.safeParse(VALID).success).toBe(true);
  });
  it("rejects an invalid cron with a clean French message", () => {
    const r = pipelineSettingsSchema.safeParse({ ...VALID, scheduleCron: "not a cron" });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0]?.message).toContain("Cron invalide");
  });
});

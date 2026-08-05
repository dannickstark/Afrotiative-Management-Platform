import { describe, it, expect, afterEach } from "bun:test";
import { db, pipelineRuns } from "@/db";
import { eq } from "drizzle-orm";
import { openRun } from "@/lib/pipeline/run";
import { resolveRunParams } from "@/lib/pipeline/run-params";

describe("resolveRunParams → openRun persistence", () => {
  let runId: string | null = null;
  afterEach(async () => { if (runId) { await db.delete(pipelineRuns).where(eq(pipelineRuns.id, runId)); runId = null; } });

  it("persists resolved defaults on the run row", async () => {
    const params = resolveRunParams(undefined, { defaultMaxItemAgeHours: 72, maxItemsPerRun: 15 }, new Date());
    runId = await openRun({ triggeredBy: "manual", params });
    expect(runId).not.toBeNull();
    const [row] = await db.select({ params: pipelineRuns.params }).from(pipelineRuns).where(eq(pipelineRuns.id, runId!));
    expect(row.params?.recency).toMatchObject({ kind: "age", hours: 72 });
    expect(row.params?.maxItems).toBe(15);
    expect(row.params?.feedIds).toBeNull();
    // finalize so it doesn't hold the one-running slot for later tests
    await db.update(pipelineRuns).set({ status: "success", finishedAt: new Date() }).where(eq(pipelineRuns.id, runId!));
  });
});

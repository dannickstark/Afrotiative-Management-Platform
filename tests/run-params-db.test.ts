import { describe, it, expect, afterAll } from "bun:test";
import { db, pipelineRuns } from "@/db";
import { eq } from "drizzle-orm";
import type { RunParams } from "@/db";

describe("pipeline_runs.params jsonb round-trip", () => {
  let runId: string | null = null;
  afterAll(async () => { if (runId) await db.delete(pipelineRuns).where(eq(pipelineRuns.id, runId)); });

  it("persists and reads back a typed RunParams blob", async () => {
    const params: RunParams = {
      recency: { kind: "age", hours: 48, cutoffAt: "2026-08-04T00:00:00.000Z" },
      feedIds: null,
      maxItems: 20,
    };
    const [row] = await db.insert(pipelineRuns)
      .values({ triggeredBy: "manual", status: "success", finishedAt: new Date(), params })
      .returning({ id: pipelineRuns.id, params: pipelineRuns.params });
    runId = row.id;
    expect(row.params).toEqual(params);
  });
});

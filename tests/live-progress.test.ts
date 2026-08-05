import { describe, it, expect, afterAll } from "bun:test";
import { db, pipelineRuns, pipelineSteps } from "@/db";
import { eq } from "drizzle-orm";

describe("pipeline_runs progress columns + pipeline_steps.at (migration 0003)", () => {
  let runId: string | null = null;
  let bareId: string | null = null;
  afterAll(async () => {
    if (runId) await db.delete(pipelineRuns).where(eq(pipelineRuns.id, runId)); // cascades steps
    if (bareId) await db.delete(pipelineRuns).where(eq(pipelineRuns.id, bareId));
  });

  it("persists and reads back the new progress fields with correct defaults", async () => {
    const [run] = await db.insert(pipelineRuns).values({
      triggeredBy: "manual", status: "running",
      phase: "processing_items", feedsTotal: 6, totalItems: 20,
      processedItems: 8, currentStage: "Génération IA", currentItem: "« Titre test »",
    }).returning({ id: pipelineRuns.id });
    runId = run.id;

    const [row] = await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, runId));
    expect(row.phase).toBe("processing_items");
    expect(row.feedsTotal).toBe(6);
    expect(row.totalItems).toBe(20);
    expect(row.processedItems).toBe(8);
    expect(row.currentStage).toBe("Génération IA");
    expect(row.currentItem).toBe("« Titre test »");

    await db.insert(pipelineSteps).values({ runId, name: "Étape test", status: "success", durationMs: 5 });
    const [step] = await db.select().from(pipelineSteps).where(eq(pipelineSteps.runId, runId));
    expect(step.at).not.toBeNull(); // default now()

    // processed_items default is 0 on a bare insert
    const [bare] = await db.insert(pipelineRuns).values({ triggeredBy: "manual", status: "failed", finishedAt: new Date() }).returning();
    bareId = bare.id; // capture before asserting so afterAll always cleans up, even if the assertion throws
    expect(bare.processedItems).toBe(0);
  });
});

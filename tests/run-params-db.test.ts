import { describe, it, expect, afterAll } from "bun:test";
import { db, pipelineRuns } from "@/db";
import { eq } from "drizzle-orm";
import type { RunParams } from "@/db";

describe("pipeline_runs.params jsonb round-trip", () => {
  const runIds: string[] = [];
  afterAll(async () => {
    for (const id of runIds) await db.delete(pipelineRuns).where(eq(pipelineRuns.id, id));
  });

  // Shared by every case below: insert a run row with the given params, track it for cleanup, and
  // return the params jsonb read straight back from the DB (proves it round-trips unchanged, not
  // just that the insert accepted it).
  async function roundTrip(params: RunParams) {
    const [row] = await db.insert(pipelineRuns)
      .values({ triggeredBy: "manual", status: "success", finishedAt: new Date(), params })
      .returning({ id: pipelineRuns.id, params: pipelineRuns.params });
    runIds.push(row.id);
    return row.params;
  }

  it("persists and reads back a typed RunParams blob", async () => {
    const params: RunParams = {
      recency: { kind: "age", hours: 48, cutoffAt: "2026-08-04T00:00:00.000Z" },
      feedIds: null,
      maxItems: 20,
    };
    expect(await roundTrip(params)).toEqual(params);
  });

  it("round-trips recency.kind === 'since' unchanged", async () => {
    const params: RunParams = {
      recency: { kind: "since", cutoffAt: "2026-08-05T09:00:00.000Z" },
      feedIds: null,
      maxItems: 10,
    };
    expect(await roundTrip(params)).toEqual(params);
  });

  it("round-trips recency.kind === 'none' unchanged", async () => {
    const params: RunParams = { recency: { kind: "none" }, feedIds: null, maxItems: 10 };
    expect(await roundTrip(params)).toEqual(params);
  });

  it("round-trips a non-null feedIds array unchanged", async () => {
    const params: RunParams = {
      recency: { kind: "none" },
      feedIds: ["11111111-1111-1111-1111-111111111111", "22222222-2222-2222-2222-222222222222"],
      maxItems: 10,
    };
    expect(await roundTrip(params)).toEqual(params);
  });
});

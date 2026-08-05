import { describe, it, expect, afterAll } from "bun:test";
import { db, pipelineRuns } from "@/db";
import { eq } from "drizzle-orm";
import { hasRunningRun, reclaimStaleRuns } from "@/lib/pipeline/overlap";

// ─────────────────────────────────────────────────────────────────────────────
// SP5 Task 1 — run-control schema foundation. Adds to pipeline_runs: cancel_requested /
// pause_requested booleans, a nullable checkpoint jsonb (holds the remaining-stories payload
// for pause/resume, wired in SP5 Task 4), and two new pipeline_status enum values: 'cancelled'
// (Stop) and 'paused' (Pause/Resume). The pipeline_runs_one_running partial unique index guards
// the single active slot via WHERE finished_at IS NULL (an active run — running OR paused — is
// exactly an unfinalized one; a paused run leaves finished_at null and so still holds the slot).
// The predicate is finished_at-based rather than status-based so the whole migration set applies
// in one transaction on a FRESH deploy without tripping PostgreSQL 55P04 (can't reference a
// just-added enum value in the same tx) — see .superpowers/sp5-t1-report.md.
// Network-free: real Neon DB only, no external HTTP.
describe("pipeline_runs run-control columns (cancelRequested/pauseRequested/checkpoint)", () => {
  let runId: string | null = null;

  afterAll(async () => {
    if (runId) await db.delete(pipelineRuns).where(eq(pipelineRuns.id, runId));
  });

  it("round-trips cancelRequested/pauseRequested/checkpoint and the 'paused'/'cancelled' statuses", async () => {
    // Shaped exactly as RunCheckpoint (db/schema.ts, narrowed in SP5 Task 4): stories[] of
    // members[], each { feedId, feedName, item: RawItem }.
    const checkpoint = {
      stories: [
        [{
          feedId: "feed-1", feedName: "Flux Test",
          item: { guid: "g1", url: "https://example.com/1", title: "T1", contentSnippet: "Extrait.", isoDate: null, contentHash: "hash1" },
        }],
      ],
    };

    const [row] = await db.insert(pipelineRuns).values({
      triggeredBy: "manual",
      status: "paused",
      cancelRequested: true,
      pauseRequested: true,
      checkpoint,
    }).returning();
    runId = row.id; // capture before asserting so afterAll always cleans up, even if an assertion throws

    expect(row.status).toBe("paused");
    expect(row.cancelRequested).toBe(true);
    expect(row.pauseRequested).toBe(true);
    expect(row.checkpoint).toEqual(checkpoint);

    // Re-read from a fresh SELECT to confirm it's actually persisted, not just echoed by RETURNING.
    const [reread] = await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, runId));
    expect(reread.status).toBe("paused");
    expect(reread.cancelRequested).toBe(true);
    expect(reread.pauseRequested).toBe(true);
    expect(reread.checkpoint).toEqual(checkpoint);

    // The 'cancelled' status value (Stop / Task 3) also round-trips.
    await db.update(pipelineRuns).set({ status: "cancelled" }).where(eq(pipelineRuns.id, runId));
    const [cancelled] = await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, runId));
    expect(cancelled.status).toBe("cancelled");
  });

  it("defaults cancelRequested/pauseRequested to false and checkpoint to null on a bare insert", async () => {
    const [row] = await db.insert(pipelineRuns).values({ triggeredBy: "scheduled", status: "failed", finishedAt: new Date() }).returning();
    try {
      expect(row.cancelRequested).toBe(false);
      expect(row.pauseRequested).toBe(false);
      expect(row.checkpoint).toBeNull();
    } finally {
      await db.delete(pipelineRuns).where(eq(pipelineRuns.id, row.id));
    }
  });
});

describe("hasRunningRun() / reclaimStaleRuns() treat 'paused' as an active, non-reapable slot", () => {
  let pausedRunId: string | null = null;

  afterAll(async () => {
    if (pausedRunId) await db.delete(pipelineRuns).where(eq(pipelineRuns.id, pausedRunId));
  });

  it("hasRunningRun() returns true when a 'paused' run exists (and no 'running' row is present)", async () => {
    const [run] = await db.insert(pipelineRuns).values({ triggeredBy: "manual", status: "paused" }).returning({ id: pipelineRuns.id });
    pausedRunId = run.id;

    expect(await hasRunningRun()).toBe(true);
  });

  it("reclaimStaleRuns() never reaps a 'paused' row, however old — pause is an intentional parked state, not staleness", async () => {
    // Backdate the same paused row from above well past the stale threshold (default 15 min).
    await db.update(pipelineRuns)
      .set({ startedAt: new Date(Date.now() - 24 * 60 * 60_000) }) // 24h ago
      .where(eq(pipelineRuns.id, pausedRunId!));

    await reclaimStaleRuns();

    const [after] = await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, pausedRunId!));
    expect(after.status).toBe("paused"); // NOT reaped to "failed"
    expect(after.finishedAt).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Interlock: pipeline_runs_one_running (WHERE finished_at IS NULL) must let a paused run hold the
// single slot — a second active run cannot open while one is parked. A paused run has finished_at
// null (unfinalized), so it occupies the index just like a running run does. Mirrors the existing
// overlap test pattern in tests/pipeline-run.test.ts ("runPipeline overlap guard").
describe("pipeline_runs_one_running index also covers 'paused' (interlock)", () => {
  let pausedRunId: string | null = null;

  afterAll(async () => {
    if (pausedRunId) await db.delete(pipelineRuns).where(eq(pipelineRuns.id, pausedRunId));
  });

  it("rejects a second 'running' insert while a 'paused' run holds the slot (SQLSTATE 23505)", async () => {
    const [run] = await db.insert(pipelineRuns).values({ triggeredBy: "manual", status: "paused" }).returning({ id: pipelineRuns.id });
    pausedRunId = run.id;

    // Drizzle wraps the pg error in DrizzleQueryError, so the SQLSTATE is on `.cause`.
    let code: string | undefined;
    try {
      await db.insert(pipelineRuns).values({ triggeredBy: "manual", status: "running" });
    } catch (e) {
      code = (e as { code?: string }).code ?? (e as { cause?: { code?: string } }).cause?.code;
    }
    expect(code).toBe("23505");
  });
});

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { db, feeds, rawItems, pipelineRuns } from "@/db";
import { eq } from "drizzle-orm";
import { deriveFeedHealth, updateFeedHealth, type FeedHealthInput } from "@/lib/pipeline/feed-health";
import { openRun, executeRun } from "@/lib/pipeline/run";

// ─────────────────────────────────────────────────────────────────────────────
// SP8 — pure unit tests for deriveFeedHealth. No DB, no network: every case below is a plain
// object → expected FeedHealth, exercising the exact threshold order documented on the function
// (idle first, then failing, then degraded, else healthy).
describe("deriveFeedHealth (pure)", () => {
  const base: FeedHealthInput = { active: true, lastFetchStatus: "ok", consecutiveFailures: 0, itemsCaptured7d: 10 };

  it("healthy: active, last read ok, no failure streak, items captured in the last 7 days", () => {
    expect(deriveFeedHealth(base)).toBe("healthy");
  });

  it("idle: never successfully/unsuccessfully read yet", () => {
    expect(deriveFeedHealth({ ...base, lastFetchStatus: "never", itemsCaptured7d: 0 })).toBe("idle");
  });

  it("idle: an inactive feed reads idle even with an error/failure history (active wins)", () => {
    expect(deriveFeedHealth({ ...base, active: false, lastFetchStatus: "error", consecutiveFailures: 5 })).toBe("idle");
  });

  it("failing: the most recent read errored", () => {
    expect(deriveFeedHealth({ ...base, lastFetchStatus: "error", consecutiveFailures: 1 })).toBe("failing");
  });

  it("failing: 3+ consecutive failures even if lastFetchStatus somehow still reads 'ok'", () => {
    expect(deriveFeedHealth({ ...base, consecutiveFailures: 3 })).toBe("failing");
    expect(deriveFeedHealth({ ...base, consecutiveFailures: 7 })).toBe("failing");
  });

  it("degraded: 1-2 consecutive failures (recovering-but-shaky)", () => {
    expect(deriveFeedHealth({ ...base, consecutiveFailures: 1 })).toBe("degraded");
    expect(deriveFeedHealth({ ...base, consecutiveFailures: 2 })).toBe("degraded");
  });

  it("degraded: last read ok but zero items captured in the last 7 days", () => {
    expect(deriveFeedHealth({ ...base, itemsCaptured7d: 0 })).toBe("degraded");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SP8 — updateFeedHealth exercised directly against the real Neon dev DB (network-free: no
// parseFeed/HTTP involved, just the DB write itself). Covers both outcomes plus the itemsCaptured7d
// 7-day-window recompute precisely (a row just inside the window counts, one just outside doesn't).
describe("updateFeedHealth (direct DB writes)", () => {
  let feedId: string;

  beforeAll(async () => {
    const [f] = await db.insert(feeds).values({
      name: "Fixture feed-health direct (test)", feedUrl: "http://example.invalid/rss", active: true,
    }).returning({ id: feeds.id });
    feedId = f.id;
  });

  afterAll(async () => {
    await db.delete(rawItems).where(eq(rawItems.feedId, feedId));
    await db.delete(feeds).where(eq(feeds.id, feedId));
  });

  it("failure: sets lastFetchStatus='error', a recent lastFetchAt, and increments consecutiveFailures across repeated calls", async () => {
    await updateFeedHealth(feedId, "failure");
    let [row] = await db.select().from(feeds).where(eq(feeds.id, feedId));
    expect(row.lastFetchStatus).toBe("error");
    expect(row.consecutiveFailures).toBe(1);
    expect(row.lastFetchAt).not.toBeNull();
    expect(Date.now() - new Date(row.lastFetchAt!).getTime()).toBeLessThan(5000);

    await updateFeedHealth(feedId, "failure");
    [row] = await db.select().from(feeds).where(eq(feeds.id, feedId));
    expect(row.consecutiveFailures).toBe(2); // streak — 2nd consecutive failure
  });

  it("success: resets consecutiveFailures to 0, sets lastFetchStatus='ok', and recomputes itemsCaptured7d from raw_items within the last 7 days", async () => {
    const now = new Date();
    const eightDaysAgo = new Date(now.getTime() - 8 * 24 * 60 * 60 * 1000);
    await db.insert(rawItems).values([
      { feedId, guid: "sp8:recent:1", url: "http://example.invalid/1", contentHash: "sp8-hash-1", fetchedAt: now },
      { feedId, guid: "sp8:recent:2", url: "http://example.invalid/2", contentHash: "sp8-hash-2", fetchedAt: now },
      { feedId, guid: "sp8:recent:3", url: "http://example.invalid/3", contentHash: "sp8-hash-3", fetchedAt: now },
      // Outside the 7-day window — must NOT be counted.
      { feedId, guid: "sp8:old:1", url: "http://example.invalid/4", contentHash: "sp8-hash-4", fetchedAt: eightDaysAgo },
    ]);

    await updateFeedHealth(feedId, "success");

    const [row] = await db.select().from(feeds).where(eq(feeds.id, feedId));
    expect(row.lastFetchStatus).toBe("ok");
    expect(row.consecutiveFailures).toBe(0); // reset after the two failures in the previous test
    expect(row.itemsCaptured7d).toBe(3); // only the 3 recent rows — the 8-day-old one is excluded
    expect(row.lastFetchAt).not.toBeNull();
    expect(Date.now() - new Date(row.lastFetchAt!).getTime()).toBeLessThan(5000);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SP8 — end-to-end wiring: executeRun's phase-1 feed-read loop (lib/pipeline/run.ts) must actually
// CALL updateFeedHealth after each feed parse attempt. Real Neon dev DB; network-free (an
// unreachable loopback URL for the failure runs, same fixture pattern as
// tests/pipeline-run.test.ts's "always finalizes" test; a local Bun.serve RSS fixture with ZERO
// items for the success run, so phase 2 never touches extraction/embedding/LLM providers at all —
// isolates this test to feed-health behavior only).
describe("executeRun wires feed-health into the phase-1 feed-read loop (SP8)", () => {
  let feedId: string;
  const runIds: string[] = [];
  let workingRss: ReturnType<typeof Bun.serve> | null = null;

  beforeAll(async () => {
    const [f] = await db.insert(feeds).values({
      name: "Fixture feed-health run-wiring (test)", feedUrl: "http://127.0.0.1:1/rss", active: true,
    }).returning({ id: feeds.id });
    feedId = f.id;
  });

  afterAll(async () => {
    if (workingRss) workingRss.stop(true);
    for (const id of runIds) await db.delete(pipelineRuns).where(eq(pipelineRuns.id, id)); // cascades pipeline_steps
    await db.delete(rawItems).where(eq(rawItems.feedId, feedId));
    await db.delete(feeds).where(eq(feeds.id, feedId));
  });

  it("increments consecutiveFailures across repeated failed reads, then resets to 0 (and recomputes itemsCaptured7d) on a successful read", async () => {
    // Run 1: unreachable feedUrl → parseFeed throws → 'error', streak 1.
    const runId1 = await openRun({ triggeredBy: "manual", feedsTotal: 1 });
    expect(runId1).not.toBeNull();
    runIds.push(runId1!);
    const res1 = await executeRun(runId1!, { feedIds: [feedId] });
    expect(res1.status).toBe("failed"); // the only feed failed to parse

    let [row] = await db.select().from(feeds).where(eq(feeds.id, feedId));
    expect(row.lastFetchStatus).toBe("error");
    expect(row.consecutiveFailures).toBe(1);
    const firstFetchAt = row.lastFetchAt;
    expect(firstFetchAt).not.toBeNull();

    // Run 2: still unreachable → streak 2.
    const runId2 = await openRun({ triggeredBy: "manual", feedsTotal: 1 });
    runIds.push(runId2!);
    await executeRun(runId2!, { feedIds: [feedId] });
    [row] = await db.select().from(feeds).where(eq(feeds.id, feedId));
    expect(row.lastFetchStatus).toBe("error");
    expect(row.consecutiveFailures).toBe(2);

    // Point the feed at a real (but zero-item) RSS fixture, and pre-seed raw_items so we can also
    // assert itemsCaptured7d gets recomputed on the successful read — no article/extraction/embed
    // fixtures needed since an empty feed produces zero phase-2 groups.
    workingRss = Bun.serve({
      port: 0,
      fetch: () => new Response(
        `<?xml version="1.0"?><rss version="2.0"><channel><title>Fixture feed-health OK</title></channel></rss>`,
        { headers: { "content-type": "application/xml" } },
      ),
    });
    await db.update(feeds).set({ feedUrl: `http://localhost:${workingRss.port}/feed` }).where(eq(feeds.id, feedId));
    await db.insert(rawItems).values([
      { feedId, guid: "sp8:wiring:prior:1", url: "http://example.invalid/prior1", contentHash: "sp8-wiring-hash-1" },
      { feedId, guid: "sp8:wiring:prior:2", url: "http://example.invalid/prior2", contentHash: "sp8-wiring-hash-2" },
    ]);

    // Run 3: parses successfully (0 items — a quiet run) → 'ok', streak reset to 0.
    const runId3 = await openRun({ triggeredBy: "manual", feedsTotal: 1 });
    runIds.push(runId3!);
    const res3 = await executeRun(runId3!, { feedIds: [feedId] });
    expect(res3.status).toBe("success"); // no feed/item failures, no cap hit — a quiet run

    [row] = await db.select().from(feeds).where(eq(feeds.id, feedId));
    expect(row.lastFetchStatus).toBe("ok");
    expect(row.consecutiveFailures).toBe(0); // streak reset after the success
    expect(row.itemsCaptured7d).toBe(2); // the 2 pre-seeded raw_items rows
    expect(row.lastFetchAt).not.toBeNull();
    expect(new Date(row.lastFetchAt!).getTime()).toBeGreaterThanOrEqual(new Date(firstFetchAt!).getTime());
  }, 20000);
});

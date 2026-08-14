import { describe, it, expect } from "bun:test";
import { classifyRunOutcome } from "@/lib/pipeline/run";

// TASK A-STATS — classifyRunOutcome is the pure status tally extracted from executeRun
// (lib/pipeline/run.ts). Its whole job here is proving one thing: a story skipped because its
// AI-classified category fell outside the run's category scope (stageSources returning
// `skipped: true`, tallied by executeRun into `skippedByCategory`) must NEVER be treated as a
// failure — not counted toward "items attempted", not able to trip "all items failed" → "failed",
// and therefore never able to fire the run_failed alert (which executeRun gates on
// `status === "failed"` alone). Every other threshold mirrors the pre-existing tally verbatim —
// these tests also pin those down so a future refactor can't silently change them.

const base = { produced: 0, itemFailures: 0, skippedByCategory: 0, feedsFailed: 0, targetFeedsLength: 0, capHit: false };

describe("classifyRunOutcome", () => {
  it("all-skipped (0 produced, 0 genuine failures, N category skips) is NOT failed — reads success", () => {
    expect(classifyRunOutcome({ ...base, skippedByCategory: 5 })).toBe("success");
  });

  it("all-skipped with feeds read successfully is still success, regardless of how large the skip count is", () => {
    expect(classifyRunOutcome({ ...base, skippedByCategory: 500, targetFeedsLength: 3 })).toBe("success");
  });

  it("skips mixed with real production is still success when there are no genuine failures", () => {
    expect(classifyRunOutcome({ ...base, produced: 2, skippedByCategory: 8 })).toBe("success");
  });

  it("skips mixed with a genuine failure still reports failed when NOTHING was produced", () => {
    // 1 genuine failure, 0 produced, skips must not dilute this into anything other than failed.
    expect(classifyRunOutcome({ ...base, itemFailures: 1, skippedByCategory: 20 })).toBe("failed");
  });

  it("skips mixed with a genuine failure alongside real production reports partial (unchanged behavior)", () => {
    expect(classifyRunOutcome({ ...base, produced: 1, itemFailures: 1, skippedByCategory: 3 })).toBe("partial");
  });

  it("a quiet run with nothing attempted at all (no skips either) is success — pre-existing behavior preserved", () => {
    expect(classifyRunOutcome(base)).toBe("success");
  });

  it("every feed failed to parse is failed, even with zero items attempted", () => {
    expect(classifyRunOutcome({ ...base, feedsFailed: 2, targetFeedsLength: 2 })).toBe("failed");
  });

  it("some feeds failed but at least one item was produced is partial", () => {
    expect(classifyRunOutcome({ ...base, produced: 1, feedsFailed: 1, targetFeedsLength: 2 })).toBe("partial");
  });

  it("hitting the item cap alone (no other failures) is partial", () => {
    expect(classifyRunOutcome({ ...base, produced: 1, capHit: true })).toBe("partial");
  });

  it("normal production with no failures at all is success", () => {
    expect(classifyRunOutcome({ ...base, produced: 3 })).toBe("success");
  });

  it("items attempted and ALL of them genuinely failed (no skips) is failed — pre-existing behavior preserved", () => {
    expect(classifyRunOutcome({ ...base, itemFailures: 4 })).toBe("failed");
  });
});

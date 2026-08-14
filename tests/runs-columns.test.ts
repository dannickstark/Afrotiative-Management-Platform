import { describe, expect, test } from "bun:test";
import { runDurationMs } from "@/components/pipeline/runs-columns";

// B4: the runs DataTable sorts its Duration column off this pure ms accessor (the cell itself
// still DISPLAYS lib/format.ts's existing formatRunDuration string, unchanged from the old
// hand-rolled table — that formatter is reused as-is and isn't re-tested here). This test only
// covers the one bit of new logic: the numeric sort key, including the "still running/paused"
// case where there's no finishedAt yet.
describe("runDurationMs", () => {
  test("returns the elapsed milliseconds for a finished run", () => {
    const started = "2026-08-12T08:00:00Z";
    const finished = "2026-08-12T08:00:01.500Z";
    expect(runDurationMs(started, finished)).toBe(1500);
  });

  test("accepts Date objects, not just ISO strings", () => {
    const started = new Date("2026-08-12T08:00:00Z");
    const finished = new Date("2026-08-12T08:00:05Z");
    expect(runDurationMs(started, finished)).toBe(5000);
  });

  test("sorts an unfinished (still running/paused) run as the longest, not zero/NaN", () => {
    const started = "2026-08-12T08:00:00Z";
    expect(runDurationMs(started, null)).toBe(Number.POSITIVE_INFINITY);
  });

  test("never returns a negative duration even if clocks disagree", () => {
    const started = "2026-08-12T08:00:05Z";
    const finished = "2026-08-12T08:00:00Z"; // finished "before" started
    expect(runDurationMs(started, finished)).toBe(0);
  });
});

import { describe, it, expect } from "bun:test";
import { getDashboardData } from "@/lib/queries/dashboard";

describe("getDashboardData", () => {
  it("returns counts and lists from seeded data", async () => {
    const d = await getDashboardData();
    expect(d.pendingCount).toBeGreaterThan(0);
    expect(d.latestPending.length).toBeGreaterThan(0);
    expect(d.latestErrors.length).toBeGreaterThan(0); // seed has one failed step
  });

  it("covers the date-boundary counts and lastRun", async () => {
    const d = await getDashboardData();
    expect(d.failedRuns24h).toBeGreaterThanOrEqual(1); // seed has one recent failed run
    expect(d.publishedWeek).toBeGreaterThanOrEqual(1); // seed publishes within the last 7 days
    expect(d.lastRun).toBeDefined();
    expect(["success", "partial", "failed", "running"]).toContain(d.lastRun!.status);
  });
});

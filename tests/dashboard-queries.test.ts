import { describe, it, expect } from "bun:test";
import { getDashboardData } from "@/lib/queries/dashboard";

describe("getDashboardData", () => {
  it("returns counts and lists from seeded data", async () => {
    const d = await getDashboardData();
    expect(d.pendingCount).toBeGreaterThan(0);
    expect(d.latestPending.length).toBeGreaterThan(0);
    expect(d.latestErrors.length).toBeGreaterThan(0); // seed has one failed step
  });
});

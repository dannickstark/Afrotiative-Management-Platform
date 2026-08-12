import { describe, it, expect } from "bun:test";
import { safeEqual } from "@/lib/timing-safe";

// Pure function, no DB, no network — registered in scripts/test-fast.ts's PURE_FILES allowlist.
// No real secret values here: dummy strings only (plan 006 STOP condition).
describe("safeEqual", () => {
  it("returns true for equal strings", () => {
    expect(safeEqual("dummy-secret-value", "dummy-secret-value")).toBe(true);
  });

  it("returns false for different-length strings", () => {
    expect(safeEqual("short", "much-longer-string")).toBe(false);
  });

  it("returns false for same-length but different strings", () => {
    expect(safeEqual("dummy-secret-aaaa", "dummy-secret-bbbb")).toBe(false);
  });
});

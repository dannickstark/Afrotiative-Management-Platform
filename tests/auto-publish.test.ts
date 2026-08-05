import { describe, it, expect } from "bun:test";
import { shouldAutoPublish, type ShouldAutoPublishInput } from "@/lib/pipeline/auto-publish";

// Pure gate — no DB, no network. A baseline input that qualifies on every condition; each test
// below flips exactly ONE field away from qualifying and asserts the gate blocks it, proving each
// condition is independently load-bearing (not just correlated with the others).
const QUALIFYING: ShouldAutoPublishInput = {
  enabled: true,
  score: 85,
  scoreThreshold: 70,
  sourceCount: 3,
  minSources: 2,
  hasImage: true,
  confidence: {},
};

describe("shouldAutoPublish — SP6 gated auto-publish", () => {
  it("returns true when every condition is satisfied", () => {
    expect(shouldAutoPublish(QUALIFYING)).toBe(true);
  });

  it("returns true at the exact score threshold (>=, not >)", () => {
    expect(shouldAutoPublish({ ...QUALIFYING, score: 70, scoreThreshold: 70 })).toBe(true);
  });

  it("returns true at the exact minSources floor (>=, not >)", () => {
    expect(shouldAutoPublish({ ...QUALIFYING, sourceCount: 2, minSources: 2 })).toBe(true);
  });

  it("returns false when disabled — the admin master switch always wins first", () => {
    expect(shouldAutoPublish({ ...QUALIFYING, enabled: false })).toBe(false);
  });

  it("returns false when disabled even if every OTHER condition would otherwise qualify", () => {
    // Belt-and-suspenders: disabled short-circuits regardless of how permissive everything else is.
    expect(shouldAutoPublish({
      ...QUALIFYING, enabled: false, score: 100, sourceCount: 10, minSources: 1,
    })).toBe(false);
  });

  it("returns false when score is null", () => {
    expect(shouldAutoPublish({ ...QUALIFYING, score: null })).toBe(false);
  });

  it("returns false when score is below the threshold", () => {
    expect(shouldAutoPublish({ ...QUALIFYING, score: 69, scoreThreshold: 70 })).toBe(false);
  });

  it("returns false when score is zero (falsy but not null — must not be treated as missing)", () => {
    // Zero is a legitimate (if extreme) score, not "unset" — but it's still below any sane
    // threshold, so this exercises the falsy-vs-null distinction without accidentally passing.
    expect(shouldAutoPublish({ ...QUALIFYING, score: 0, scoreThreshold: 70 })).toBe(false);
  });

  it("returns false when sourceCount is below minSources", () => {
    expect(shouldAutoPublish({ ...QUALIFYING, sourceCount: 1, minSources: 2 })).toBe(false);
  });

  it("returns false when there is no featured image", () => {
    expect(shouldAutoPublish({ ...QUALIFYING, hasImage: false })).toBe(false);
  });

  it("returns false when categoryUncertain is set", () => {
    expect(shouldAutoPublish({ ...QUALIFYING, confidence: { categoryUncertain: true } })).toBe(false);
  });

  it("returns false when imageMissing is set (even if hasImage is somehow true)", () => {
    expect(shouldAutoPublish({ ...QUALIFYING, confidence: { imageMissing: true } })).toBe(false);
  });

  it("returns false when clusterUncertain is set", () => {
    expect(shouldAutoPublish({ ...QUALIFYING, confidence: { clusterUncertain: true } })).toBe(false);
  });

  it("returns false when aiDegraded is set — a degraded (mock LLM/embedding) draft never auto-publishes", () => {
    expect(shouldAutoPublish({ ...QUALIFYING, confidence: { aiDegraded: true } })).toBe(false);
  });

  it("returns false when multiple confidence flags are set at once", () => {
    expect(shouldAutoPublish({
      ...QUALIFYING, confidence: { categoryUncertain: true, aiDegraded: true },
    })).toBe(false);
  });
});

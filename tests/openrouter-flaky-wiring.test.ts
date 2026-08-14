// tests/openrouter-flaky-wiring.test.ts — Task 5 (pure, DB-free). Unit-tests the article
// "flaky" predicate wired into lib/ai/generate-article.ts's OpenRouter pool call
// (lib/ai/with-token-pool.ts's runWithOpenRouterPool): a plain-text body shorter than the
// configured openrouterMinContentChars is treated as a flaky/unusable response, triggering
// rotation to the next pooled token.
import { describe, it, expect } from "bun:test";
import { articleIsFlaky } from "@/lib/ai/generate-article";

describe("articleIsFlaky", () => {
  it("is true when the body's plain-text length is below minChars", () => {
    expect(articleIsFlaky("<p>short</p>", 400)).toBe(true);
  });

  it("is false when the body's plain-text length meets/exceeds minChars", () => {
    expect(articleIsFlaky("<p>" + "a".repeat(500) + "</p>", 400)).toBe(false);
  });

  it("is exactly at the boundary: length === minChars is NOT flaky", () => {
    expect(articleIsFlaky("<p>" + "a".repeat(400) + "</p>", 400)).toBe(false);
  });

  it("is exactly at the boundary: length === minChars - 1 IS flaky", () => {
    expect(articleIsFlaky("<p>" + "a".repeat(399) + "</p>", 400)).toBe(true);
  });
});

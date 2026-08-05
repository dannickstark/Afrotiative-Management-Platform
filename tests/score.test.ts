import { describe, it, expect } from "bun:test";
import { computeArticleScore, type ArticleScoreInput } from "@/lib/pipeline/score";

// Pure function, no DB — SP4 Task 4.

const SHORT_BODY = "<p>Court.</p>";
const LONG_BODY_WITH_H2 =
  `<p>${"Paragraphe substantiel avec beaucoup de détails vérifiés et recoupés. ".repeat(15)}</p>` +
  `<h2>Contexte</h2><p>${"Autre paragraphe détaillé apportant du contexte supplémentaire. ".repeat(10)}</p>`;

describe("computeArticleScore", () => {
  it("single low-confidence source with no image/structure and every confidence flag set → low score", () => {
    const input: ArticleScoreInput = {
      sourceCount: 1,
      bestScore: 0,
      bodyHtml: SHORT_BODY,
      hasImage: false,
      confidence: {
        categoryUncertain: true,
        imageMissing: true,
        clusterUncertain: true,
        aiDegraded: true,
      },
    };
    const score = computeArticleScore(input);
    expect(score).toBeLessThan(30);
    expect(score).toBeGreaterThanOrEqual(0);
  });

  it("multi-source + image + <h2> + no confidence flags → high score", () => {
    const input: ArticleScoreInput = {
      sourceCount: 4,
      bestScore: 0.9,
      bodyHtml: LONG_BODY_WITH_H2,
      hasImage: true,
      confidence: {},
    };
    const score = computeArticleScore(input);
    expect(score).toBeGreaterThan(80);
    expect(score).toBeLessThanOrEqual(100);
  });

  it("is monotonically non-decreasing in sourceCount (strictly increasing before the cap)", () => {
    const base = (sourceCount: number): ArticleScoreInput => ({
      sourceCount,
      bestScore: 0.5,
      bodyHtml: SHORT_BODY,
      hasImage: false,
      confidence: {},
    });
    const scores = [1, 2, 3, 4, 5, 8].map((n) => computeArticleScore(base(n)));
    // strictly increasing up to the corroboration cap (reached at 3 sources)
    expect(scores[1]).toBeGreaterThan(scores[0]); // 2 > 1
    expect(scores[2]).toBeGreaterThan(scores[1]); // 3 > 2
    // non-decreasing beyond the cap
    for (let i = 1; i < scores.length; i++) {
      expect(scores[i]).toBeGreaterThanOrEqual(scores[i - 1]);
    }
  });

  it("is monotonically non-decreasing in bestScore (cluster cohesion)", () => {
    const base = (bestScore: number): ArticleScoreInput => ({
      sourceCount: 2,
      bestScore,
      bodyHtml: SHORT_BODY,
      hasImage: false,
      confidence: {},
    });
    const low = computeArticleScore(base(0.1));
    const mid = computeArticleScore(base(0.5));
    const high = computeArticleScore(base(0.9));
    expect(mid).toBeGreaterThanOrEqual(low);
    expect(high).toBeGreaterThanOrEqual(mid);
  });

  it("clamps to [0, 100] for extreme inputs on both ends", () => {
    const maxed = computeArticleScore({
      sourceCount: 999,
      bestScore: 5, // out-of-range, should be clamped internally
      bodyHtml: LONG_BODY_WITH_H2,
      hasImage: true,
      confidence: {},
    });
    expect(maxed).toBeLessThanOrEqual(100);
    expect(maxed).toBeGreaterThanOrEqual(0);

    const floored = computeArticleScore({
      sourceCount: 0,
      bestScore: -5, // out-of-range, should be clamped internally
      bodyHtml: "",
      hasImage: false,
      confidence: {
        categoryUncertain: true,
        imageMissing: true,
        clusterUncertain: true,
        aiDegraded: true,
      },
    });
    expect(floored).toBeGreaterThanOrEqual(0);
    expect(floored).toBeLessThanOrEqual(100);
    expect(floored).toBe(0);
  });

  it("rewards a resolved image and penalizes imageMissing independently", () => {
    const withImage = computeArticleScore({
      sourceCount: 2, bestScore: 0.5, bodyHtml: SHORT_BODY, hasImage: true, confidence: {},
    });
    const withoutImage = computeArticleScore({
      sourceCount: 2, bestScore: 0.5, bodyHtml: SHORT_BODY, hasImage: false, confidence: {},
    });
    expect(withImage).toBeGreaterThan(withoutImage);

    const flaggedMissing = computeArticleScore({
      sourceCount: 2, bestScore: 0.5, bodyHtml: SHORT_BODY, hasImage: false,
      confidence: { imageMissing: true },
    });
    expect(flaggedMissing).toBeLessThan(withoutImage);
  });

  it("rewards completeness: a long body with a subheading scores higher than a short one without", () => {
    const complete = computeArticleScore({
      sourceCount: 1, bestScore: 0, bodyHtml: LONG_BODY_WITH_H2, hasImage: false, confidence: {},
    });
    const incomplete = computeArticleScore({
      sourceCount: 1, bestScore: 0, bodyHtml: SHORT_BODY, hasImage: false, confidence: {},
    });
    expect(complete).toBeGreaterThan(incomplete);
  });
});

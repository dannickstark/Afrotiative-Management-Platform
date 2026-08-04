import { describe, it, expect } from "bun:test";
import { buildArticleSchema } from "@/lib/ai/schema";

describe("buildArticleSchema", () => {
  it("constrains category to the provided list", () => {
    const s = buildArticleSchema(["Économie", "Finance"]);
    expect(s.safeParse({ title: "Titre long", bodyHtml: "<p>x</p>", excerpt: "e", category: "Sport",
      tags: [], featuredImageUrl: null, imageCredit: null, imageSourceUrl: null,
      confidence: { categoryUncertain: false, imageMissing: false, clusterUncertain: false } }).success).toBe(false);
    expect(s.safeParse({ title: "Titre long", bodyHtml: "<p>x</p>", excerpt: "e", category: "Finance",
      tags: ["BRVM"], featuredImageUrl: null, imageCredit: null, imageSourceUrl: null,
      confidence: { categoryUncertain: false, imageMissing: false, clusterUncertain: false } }).success).toBe(true);
  });

  it("accepts any category string when categoryNames is empty (z.string() branch)", () => {
    const s = buildArticleSchema([]);
    expect(s.safeParse({ title: "Titre long", bodyHtml: "<p>x</p>", excerpt: "e", category: "N'importe quoi",
      tags: [], featuredImageUrl: null, imageCredit: null, imageSourceUrl: null,
      confidence: { categoryUncertain: false, imageMissing: false, clusterUncertain: false } }).success).toBe(true);
  });
});

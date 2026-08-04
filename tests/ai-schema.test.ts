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

  // Real providers (OpenRouter/OpenAI structured output) frequently omit imageSourceUrl (and
  // sometimes featuredImageUrl/imageCredit) entirely rather than sending null when there's no
  // image credited. These fields must be `.nullish()`, not merely `.nullable()`, or the whole
  // object is rejected and generateArticle needlessly falls through to the mock.
  it("accepts an object that OMITS imageSourceUrl entirely (only imageCredit set)", () => {
    const s = buildArticleSchema(["Économie", "Finance"]);
    const result = s.safeParse({
      title: "Titre suffisamment long", bodyHtml: "<p>x</p>", excerpt: "e", category: "Finance",
      tags: ["BRVM"], featuredImageUrl: "https://cdn.example/img.jpg", imageCredit: "Ecofin",
      // imageSourceUrl intentionally omitted
      confidence: { categoryUncertain: false, imageMissing: false, clusterUncertain: false },
    });
    expect(result.success).toBe(true);
  });

  it("accepts an object that OMITS featuredImageUrl, imageCredit, and imageSourceUrl entirely", () => {
    const s = buildArticleSchema(["Économie", "Finance"]);
    const result = s.safeParse({
      title: "Titre suffisamment long", bodyHtml: "<p>x</p>", excerpt: "e", category: "Finance",
      tags: ["BRVM"],
      // featuredImageUrl, imageCredit, imageSourceUrl intentionally omitted
      confidence: { categoryUncertain: false, imageMissing: false, clusterUncertain: false },
    });
    expect(result.success).toBe(true);
  });
});

import { describe, it, expect } from "bun:test";
import { mockGenerateArticle } from "@/lib/ai/mock";

describe("mockGenerateArticle", () => {
  it("is deterministic and always low-confidence", () => {
    const input = { sources: [{ mediaName: "Ecofin", text: "La BRVM progresse fortement cette semaine." }], candidateImages: [], categories: ["Marchés"] };
    const a = mockGenerateArticle(input), b = mockGenerateArticle(input);
    expect(a).toEqual(b);
    expect(a.category).toBe("Marchés");
    expect(a.confidence.categoryUncertain).toBe(true);
  });
});

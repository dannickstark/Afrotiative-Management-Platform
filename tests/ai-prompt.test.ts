import { describe, it, expect } from "bun:test";
import { buildArticlePrompt } from "@/lib/ai/generate-article";
import { mockGenerateArticle } from "@/lib/ai/mock";

// SP4 Task 3 — subheadings + reference-aware prompt. Pure string assertions on the built prompt
// (no LLM call), plus a check that the mock draft (used whenever every real provider is
// unconfigured/fails) already exhibits the subheading structure the prompt now asks for.
describe("buildArticlePrompt", () => {
  const input = {
    sources: [
      { mediaName: "Ecofin", url: "https://ecofin.example/a", text: "La BRVM progresse fortement cette semaine." },
      { mediaName: "Jeune Afrique", url: "https://ja.example/b", text: "Les analystes saluent la performance boursière." },
    ],
    candidateImages: [] as string[],
    categories: ["Économie", "Marchés"],
  };

  it("instructs the model to structure the article with <h2>/<h3> subheadings every 2-3 paragraphs", () => {
    const p = buildArticlePrompt(input);
    expect(p).toContain("<h2>");
    expect(p).toContain("<h3>");
    expect(p.toLowerCase()).toContain("sous-titre");
    expect(p).toMatch(/2\s*(à|-)\s*3/); // "toutes les 2 à 3 paragraphes" (or similar phrasing)
  });

  it("instructs the model to cross-check ALL provided sources and attribute claims", () => {
    const p = buildArticlePrompt(input);
    expect(p.toLowerCase()).toContain("toutes les sources");
    expect(p.toLowerCase()).toMatch(/attribu/); // "attribue"/"attribution"
  });

  it("instructs the model NOT to invent its own Sources/Références section", () => {
    const p = buildArticlePrompt(input).toLowerCase();
    // The references list is appended automatically after the body.
    expect(p).toMatch(/sources.*ajout|ajout.*sources/);
    // Assert the actual "don't add a Sources/Références section" instruction: a negation AND a
    // reference to a sources/références section — not a near-tautology that matches any French.
    expect(p).toMatch(/n['e ].*\b(sections?|sources|références)\b/);
    expect(p).toContain("n'ajoute jamais");
  });

  it("still includes every source's content", () => {
    const p = buildArticlePrompt(input);
    expect(p).toContain("Ecofin");
    expect(p).toContain("Jeune Afrique");
    expect(p).toContain("La BRVM progresse fortement cette semaine.");
  });
});

describe("mockGenerateArticle bodyHtml structure", () => {
  it("contains at least two <h2> subheadings so downstream scoring/tests see structure", () => {
    const draft = mockGenerateArticle({
      sources: [{ mediaName: "Ecofin", text: "La BRVM progresse fortement cette semaine." }],
      candidateImages: [],
      categories: ["Économie"],
    });
    const h2Count = (draft.bodyHtml.match(/<h2[\s>]/gi) ?? []).length;
    expect(h2Count).toBeGreaterThanOrEqual(2);
  });
});

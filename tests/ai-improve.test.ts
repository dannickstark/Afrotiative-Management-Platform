import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { buildImprovePrompt, improveArticleBody } from "@/lib/ai/improve-article";

describe("buildImprovePrompt", () => {
  const base = { title: "BRVM en hausse", bodyHtml: "<p>La bourse progresse.</p>" };
  it("always instructs to keep facts and output only HTML body", () => {
    const p = buildImprovePrompt(base);
    expect(p).toContain("conserve TOUS les faits");
    expect(p).toContain(base.bodyHtml);
    expect(p).toContain(base.title);
  });
  it("includes the editor instruction when provided, omits it when absent/blank", () => {
    expect(buildImprovePrompt({ ...base, instruction: "raccourcir" })).toContain("raccourcir");
    expect(buildImprovePrompt({ ...base, instruction: "   " })).not.toContain("Consigne supplémentaire");
  });
});

describe("improveArticleBody (no provider configured)", () => {
  const keys = ["OPENROUTER_API_KEY", "OMNIROUTE_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY"];
  const snap: Record<string, string | undefined> = {};
  beforeAll(() => { for (const k of keys) { snap[k] = process.env[k]; delete process.env[k]; } });
  afterAll(() => { for (const k of keys) { if (snap[k] === undefined) delete process.env[k]; else process.env[k] = snap[k]; } });
  it("falls back to via:'mock' and returns the body unchanged (caller refuses on mock)", async () => {
    const r = await improveArticleBody({ title: "T", bodyHtml: "<p>Inchangé.</p>" });
    expect(r.via).toBe("mock");
    expect(r.bodyHtml).toBe("<p>Inchangé.</p>");
  });
});

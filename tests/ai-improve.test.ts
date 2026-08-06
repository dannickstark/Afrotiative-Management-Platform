import { describe, it, expect, beforeAll, afterAll, beforeEach, mock, spyOn } from "bun:test";

// Capture the REAL implementations BEFORE mock.module() below swaps them in. This mirrors
// tests/ai-fallback.test.ts's leak-safe pattern: importing the REAL modules first forces Bun to
// resolve+cache their true exports, so mock.module()'s factory below MERGES its keys onto that
// already-cached object instead of replacing the whole module — any key our factory doesn't touch
// stays real. That matters here because tests/ai-fallback.test.ts ALSO mocks "ai" and
// "@/lib/ai/providers" (its own `generateObject`/`buildModel` indirection) — since neither file's
// factory ever sets a key the OTHER one relies on (`generateText` here, `generateObject` there),
// merge semantics mean the two files' mocks can never stomp on each other regardless of which
// loads first in a combined `bun test` run. Restoring in afterAll (below) keeps it that way for
// every file that runs afterwards, exactly like ai-fallback.test.ts's own restoration.
const { buildModel: realBuildModel } = await import("@/lib/ai/providers");
const { generateText: realGenerateText } = await import("ai");

// --- Mutable controls, reset per test; the module mocks below delegate to these. ---
let buildModelImpl: (name: string, cfg: unknown) => unknown = realBuildModel as unknown as typeof buildModelImpl;
let generateTextImpl: (opts: { model: { name: string } }) => Promise<{ text: string }> =
  realGenerateText as unknown as typeof generateTextImpl;

mock.module("@/lib/ai/providers", () => ({
  buildModel: (name: string, cfg: unknown) => buildModelImpl(name, cfg),
}));
mock.module("ai", () => ({
  generateText: (opts: { model: { name: string } }) => generateTextImpl(opts),
}));

// Imported AFTER the mocks are registered so its static imports resolve to the mocks.
const { buildImprovePrompt, improveArticleBody } = await import("@/lib/ai/improve-article");

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

describe("improveArticleBody (configured provider, happy path)", () => {
  const originalOrder = process.env.LLM_ORDER;
  beforeEach(() => {
    // Silence the observability console.warn emitted on provider failure (the fallthrough test
    // below deliberately fails the first provider).
    spyOn(console, "warn").mockImplementation(() => {});
  });
  afterAll(() => {
    // Restore BOTH the closure indirection (so "ai"/"@/lib/ai/providers" forward to real behavior
    // for every file that runs afterwards) and LLM_ORDER.
    buildModelImpl = realBuildModel as unknown as typeof buildModelImpl;
    generateTextImpl = realGenerateText as unknown as typeof generateTextImpl;
    if (originalOrder === undefined) delete process.env.LLM_ORDER;
    else process.env.LLM_ORDER = originalOrder;
  });

  it("returns via=<provider name> and the provider's generated body on success", async () => {
    process.env.LLM_ORDER = "openrouter";
    buildModelImpl = (name: string) => ({ name });
    const seen: { model: { name: string } }[] = [];
    generateTextImpl = async (opts) => { seen.push(opts); return { text: "<p>Corps amélioré par le fournisseur.</p>" }; };

    const r = await improveArticleBody({ title: "BRVM en hausse", bodyHtml: "<p>Ancien corps.</p>", instruction: "clarifier" });
    expect(r.via).toBe("openrouter");
    expect(r.bodyHtml).toBe("<p>Corps amélioré par le fournisseur.</p>");
    expect(seen).toHaveLength(1);
    expect(seen[0].model.name).toBe("openrouter");
  });

  it("falls through to the next configured provider when the first throws", async () => {
    process.env.LLM_ORDER = "openrouter,omniroute";
    buildModelImpl = (name: string) => ({ name });
    generateTextImpl = async (opts) => {
      if (opts.model.name === "openrouter") throw new Error("quota exceeded");
      return { text: "<p>Corps produit par le second fournisseur.</p>" };
    };

    const r = await improveArticleBody({ title: "T", bodyHtml: "<p>Ancien.</p>" });
    expect(r.via).toBe("omniroute");
    expect(r.bodyHtml).toBe("<p>Corps produit par le second fournisseur.</p>");
  });
});

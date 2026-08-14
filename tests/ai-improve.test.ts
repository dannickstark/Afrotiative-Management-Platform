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
const { runWithOpenRouterPool: realRunWithOpenRouterPool } = await import("@/lib/ai/with-token-pool");

// --- Mutable controls, reset per test; the module mocks below delegate to these. ---
let buildModelImpl: (name: string, cfg: unknown) => unknown = realBuildModel as unknown as typeof buildModelImpl;
let generateTextImpl: (opts: { model: unknown }) => Promise<{ text: string }> =
  realGenerateText as unknown as typeof generateTextImpl;
// runWithOpenRouterPool is the rotation runner (lib/ai/with-token-pool.ts) — mocked so these unit
// tests can drive improveArticleBody's openrouter branch (`op`/`isFlaky`) directly without a real
// DB token pool or a real OpenRouter API key. Default mirrors the real runner's single-token
// behavior: call op, ok:false on throw. Unlike tests/ai-fallback.test.ts's default, this one is
// safe to apply isFlaky automatically too (see below) because every test's provider text here is
// non-empty on the success path.
// The optional 3rd `deps` param is NOT used by this file's own tests, but MUST still be accepted
// and forwarded: this mock.module() call leaks into every file that imports "@/lib/ai/with-token-
// pool" afterwards in the same `bun test` process (same reasoning as the buildModel/generateText
// leak documented above) — including tests/with-token-pool.test.ts, which calls the REAL
// runWithOpenRouterPool(op, isFlaky, deps) with an explicit `deps` override to fake the pool
// without a DB. Dropping that 3rd arg here would silently swap it for the REAL default deps
// (real DB pool) once this file's afterAll restores runWithOpenRouterPoolImpl to the real function.
let runWithOpenRouterPoolImpl: (
  op: (apiKey: string) => Promise<string>,
  isFlaky: (v: string) => boolean,
  deps?: unknown,
) => Promise<{ ok: true; value: string } | { ok: false }> = async (op, isFlaky) => {
  try {
    const value = await op("test-openrouter-api-key");
    return isFlaky(value) ? { ok: false } : { ok: true, value };
  } catch {
    return { ok: false };
  }
};

// buildOpenRouterModel is left UNTOUCHED by this factory — because `realBuildModel` above was
// captured via a top-level `await import(...)` before this call, Bun merges this factory's keys
// onto the already-cached module object rather than replacing it wholesale, so
// buildOpenRouterModel stays the REAL function for improveArticleBody's openrouter `op` to call.
mock.module("@/lib/ai/providers", () => ({
  buildModel: (name: string, cfg: unknown) => buildModelImpl(name, cfg),
}));
mock.module("ai", () => ({
  generateText: (opts: { model: unknown }) => generateTextImpl(opts),
}));
mock.module("@/lib/ai/with-token-pool", () => ({
  runWithOpenRouterPool: (op: (apiKey: string) => Promise<string>, isFlaky: (v: string) => boolean, deps?: unknown) =>
    runWithOpenRouterPoolImpl(op, isFlaky, deps),
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
  const originalOpenRouterKey = process.env.OPENROUTER_API_KEY;
  beforeEach(() => {
    // Silence the observability console.warn emitted on provider failure (the fallthrough test
    // below deliberately fails the first provider).
    spyOn(console, "warn").mockImplementation(() => {});
    runWithOpenRouterPoolImpl = async (op, isFlaky) => {
      try {
        const value = await op("test-openrouter-api-key");
        return isFlaky(value) ? { ok: false } : { ok: true, value };
      } catch {
        return { ok: false };
      }
    };
  });
  afterAll(() => {
    // Restore BOTH the closure indirection (so "ai"/"@/lib/ai/providers"/with-token-pool forward
    // to real behavior for every file that runs afterwards) and LLM_ORDER/OPENROUTER_API_KEY.
    buildModelImpl = realBuildModel as unknown as typeof buildModelImpl;
    generateTextImpl = realGenerateText as unknown as typeof generateTextImpl;
    runWithOpenRouterPoolImpl = realRunWithOpenRouterPool as unknown as typeof runWithOpenRouterPoolImpl;
    if (originalOrder === undefined) delete process.env.LLM_ORDER;
    else process.env.LLM_ORDER = originalOrder;
    if (originalOpenRouterKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = originalOpenRouterKey;
  });

  // The "Important" finding this test (and its assertions) directly answers: nothing previously
  // proved that improveArticleBody's openrouter branch actually calls runWithOpenRouterPool with a
  // correct `op` (builds a real model via buildOpenRouterModel and runs the SAME generateText call
  // the file already makes) and a correct `isFlaky` (empty/blank text → flaky). This test captures
  // the exact arguments the call site passes to the (mocked) pool runner and asserts them
  // directly, then drives a successful pool result through to via:"openrouter".
  it("routes the openrouter branch through runWithOpenRouterPool: builds a model, applies the empty-text isFlaky rule, and returns via='openrouter' on success", async () => {
    process.env.OPENROUTER_API_KEY = "test-openrouter-api-key";
    process.env.LLM_ORDER = "openrouter";
    let seenApiKey: string | undefined;
    let seenModel: unknown;
    let capturedIsFlaky: ((t: string) => boolean) | undefined;
    runWithOpenRouterPoolImpl = async (op, isFlaky) => {
      capturedIsFlaky = isFlaky;
      seenApiKey = "fake-pool-key";
      const value = await op("fake-pool-key");
      return { ok: true, value };
    };
    generateTextImpl = async (opts) => { seenModel = opts.model; return { text: "<p>Corps amélioré par le fournisseur.</p>" }; };

    const r = await improveArticleBody({ title: "BRVM en hausse", bodyHtml: "<p>Ancien corps.</p>", instruction: "clarifier" });

    expect(r.via).toBe("openrouter");
    expect(r.bodyHtml).toBe("<p>Corps amélioré par le fournisseur.</p>");
    expect(seenApiKey).toBe("fake-pool-key");
    // op really called buildOpenRouterModel(cfg, apiKey) (the REAL function — only buildModel is
    // mocked above) and passed the resulting model into generateText, not some placeholder.
    expect(seenModel).toBeTruthy();

    expect(capturedIsFlaky).toBeTruthy();
    expect(capturedIsFlaky!("")).toBe(true);
    expect(capturedIsFlaky!("   ")).toBe(true); // whitespace-only trims to empty
    expect(capturedIsFlaky!("<p>Corps amélioré par le fournisseur.</p>")).toBe(false);
  });

  it("falls through to the next configured provider when the OpenRouter pool is exhausted ({ok:false})", async () => {
    process.env.OPENROUTER_API_KEY = "test-openrouter-api-key";
    process.env.LLM_ORDER = "openrouter,omniroute";
    buildModelImpl = (name: string) => ({ name }); // only reached for omniroute now
    // Real runWithOpenRouterPool would return {ok:false} once every pooled token's op() throws
    // (quota exceeded, etc.) — expressed here directly via the mocked pool runner.
    runWithOpenRouterPoolImpl = async () => ({ ok: false });
    generateTextImpl = async () => ({ text: "<p>Corps produit par le second fournisseur.</p>" }); // only omniroute reaches this now

    const r = await improveArticleBody({ title: "T", bodyHtml: "<p>Ancien.</p>" });
    expect(r.via).toBe("omniroute");
    expect(r.bodyHtml).toBe("<p>Corps produit par le second fournisseur.</p>");
  });
});

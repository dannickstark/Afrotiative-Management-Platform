import { describe, it, expect, mock, spyOn, beforeEach, afterAll } from "bun:test";
import type { ArticleDraft } from "@/lib/ai/schema";

// Capture the REAL implementations BEFORE mock.module() below swaps the registry. This is what
// lets afterAll (below) genuinely restore them: empirically, Bun 1.3.14's mock.restore() does
// NOT undo mock.module() — it only resets spyOn()-created mocks, so a module mocked via
// mock.module() stays mocked for the rest of the `bun test` process even after mock.restore().
// Left unaddressed, that leaks into every other file that imports these modules afterwards —
// notably tests/pipeline-run.test.ts's "network-free E2E" stageItem test, whose generateArticle()
// call would then resolve these stubs (via the last values buildModelImpl/generateObjectImpl were
// left at) instead of exercising the real generate→mock fallback path.
// NOTE: destructure the function VALUES here, don't keep the namespace objects. Per Bun's own
// mock.module docs, "If the module is already loaded, exports are overwritten with the return
// value of factory" — i.e. mock.module() mutates the SAME exports object in place rather than
// swapping in a new one. Holding onto `await import(...)` 's namespace object and reading
// `.buildModel` off it later (in afterAll) would therefore yield the MOCKED function, not the
// original — destructuring right here copies the real function reference into a plain variable
// that mock.module() can no longer touch.
const { buildModel: realBuildModel } = await import("@/lib/ai/providers");
const { generateObject: realGenerateObject } = await import("ai");

// --- Mutable controls, reset per test; the module mocks below delegate to these. ---
let buildModelImpl: (name: string, cfg: unknown) => unknown = () => null;
let generateObjectImpl: (opts: { model: { name: string } }) => Promise<{ object: ArticleDraft }> =
  async () => { throw new Error("generateObjectImpl not set"); };

// Network-free: replace only the provider factory and the AI SDK (nothing else in the
// suite imports these, so replacing them wholesale cannot leak into other test files).
// The config is NOT module-mocked — Bun shares one module registry across the whole
// `bun test` run, so a partial mock of pipeline-config would break other files that need
// parsePipelineConfig. Instead we drive cfg.llmOrder via the REAL getPipelineConfig through
// process.env.LLM_ORDER; buildModel is mocked, so provider-credential gating is irrelevant.
// mockGenerateArticle + schema also remain REAL so the terminal-mock path is exercised for real.
//
// Both factories are a stable indirection (they always call through buildModelImpl /
// generateObjectImpl, never inline the test-of-the-moment logic), so repointing those two
// variables at the real functions in afterAll (below) genuinely restores real behavior for every
// current AND future importer — without needing Bun to support "un-mocking" a module.
mock.module("@/lib/ai/providers", () => ({
  buildModel: (name: string, cfg: unknown) => buildModelImpl(name, cfg),
}));
mock.module("ai", () => ({
  generateObject: (opts: { model: { name: string } }) => generateObjectImpl(opts),
}));

// Imported AFTER the mocks are registered so its static imports resolve to the mocks.
const { generateArticle } = await import("@/lib/ai/generate-article");

function setOrder(order: string[]): void {
  process.env.LLM_ORDER = order.join(",");
}

const goodDraft = (over: Partial<ArticleDraft> = {}): ArticleDraft => ({
  title: "Titre suffisamment long",
  bodyHtml: "<p>corps</p>",
  excerpt: "extrait",
  category: "Économie",
  tags: ["BRVM"],
  featuredImageUrl: null,
  imageCredit: null,
  imageSourceUrl: null,
  confidence: { categoryUncertain: false, imageMissing: false, clusterUncertain: false },
  ...over,
});

const baseInput = {
  sources: [{ mediaName: "Ecofin", url: "https://x", text: "La BRVM progresse fortement cette semaine." }],
  candidateImages: [] as string[],
  categories: ["Économie", "Marchés"],
};

describe("generateArticle fallback chain", () => {
  const originalOrder = process.env.LLM_ORDER;
  beforeEach(() => {
    // Silence the observability console.warn emitted on provider failure.
    spyOn(console, "warn").mockImplementation(() => {});
    buildModelImpl = () => null;
    generateObjectImpl = async () => { throw new Error("generateObjectImpl not set"); };
    if (originalOrder === undefined) delete process.env.LLM_ORDER;
    else process.env.LLM_ORDER = originalOrder;
  });

  // Bun shares ONE module registry across the whole `bun test` run, so the mock.module("ai", …)
  // and mock.module("@/lib/ai/providers", …) stubs registered above the describe block would
  // otherwise leak into every other test file that imports those modules afterwards — notably
  // tests/pipeline-run.test.ts's "network-free E2E" stageItem test, whose generateArticle() call
  // would then resolve these leaked stubs instead of exercising the real generate→mock fallback
  // path. mock.restore() only undoes the spyOn(console, "warn") mock (module mocks are not
  // restorable in this Bun version) — so real restoration comes from repointing the
  // buildModelImpl/generateObjectImpl indirection at the real functions captured above.
  afterAll(() => {
    mock.restore();
    buildModelImpl = realBuildModel as unknown as typeof buildModelImpl;
    generateObjectImpl = realGenerateObject as unknown as typeof generateObjectImpl;
    if (originalOrder === undefined) delete process.env.LLM_ORDER;
    else process.env.LLM_ORDER = originalOrder;
  });

  it("skips an unconfigured provider (buildModel→null) and uses the next configured one", async () => {
    setOrder(["openrouter", "omniroute"]);
    buildModelImpl = (name) => (name === "openrouter" ? null : { name });
    const seen: string[] = [];
    generateObjectImpl = async (opts) => { seen.push(opts.model.name); return { object: goodDraft({ category: "Marchés" }) }; };

    const r = await generateArticle(baseInput);
    expect(r.via).toBe("omniroute");
    expect(seen).toEqual(["omniroute"]); // generateObject never invoked for the null provider
    expect(r.draft.category).toBe("Marchés");
  });

  it("falls through to the next provider when generateObject throws", async () => {
    setOrder(["openrouter", "omniroute"]);
    buildModelImpl = (name) => ({ name });
    generateObjectImpl = async (opts) => {
      if (opts.model.name === "openrouter") throw new Error("quota exceeded");
      return { object: goodDraft({ category: "Marchés" }) };
    };

    const r = await generateArticle(baseInput);
    expect(r.via).toBe("omniroute");
    expect(r.draft.category).toBe("Marchés");
  });

  it("returns the deterministic mock with via='mock' when every provider fails", async () => {
    setOrder(["openrouter", "omniroute"]);
    buildModelImpl = (name) => ({ name });
    generateObjectImpl = async () => { throw new Error("provider down"); };

    const r = await generateArticle(baseInput);
    expect(r.via).toBe("mock");
    expect(r.draft.title.startsWith("[MOCK]")).toBe(true);
    expect(r.draft.category).toBe("Économie"); // mock uses categories[0]
    expect(r.draft.confidence.categoryUncertain).toBe(true); // mock is always low-confidence
  });

  it("returns via=<provider name> and that provider's object on success", async () => {
    setOrder(["openrouter", "omniroute"]);
    buildModelImpl = (name) => ({ name });
    generateObjectImpl = async () => ({ object: goodDraft({ title: "Article réel produit par le modèle" }) });

    const r = await generateArticle(baseInput);
    expect(r.via).toBe("openrouter");
    expect(r.draft.title).toBe("Article réel produit par le modèle");
  });

  it("sanitizeDraft nulls a featuredImageUrl that is not a supplied candidate (and its image fields)", async () => {
    setOrder(["openrouter"]);
    buildModelImpl = (name) => ({ name });
    generateObjectImpl = async () => ({
      object: goodDraft({
        featuredImageUrl: "https://not-a-candidate.example/x.jpg",
        imageCredit: "Quelqu'un",
        imageSourceUrl: "https://src.example",
        confidence: { categoryUncertain: false, imageMissing: false, clusterUncertain: false },
      }),
    });

    const r = await generateArticle({ ...baseInput, candidateImages: [] });
    expect(r.draft.featuredImageUrl).toBeNull();
    expect(r.draft.imageCredit).toBeNull();
    expect(r.draft.imageSourceUrl).toBeNull();
    expect(r.draft.confidence.imageMissing).toBe(true);
  });

  it("sanitizeDraft persists null (never undefined) when the provider OMITS the image fields entirely", async () => {
    // Simulates a real provider (OpenRouter/OpenAI structured output) that omits
    // featuredImageUrl/imageCredit/imageSourceUrl rather than sending null — the schema's
    // `.nullish()` fields let this validate, and sanitizeDraft must still normalize the
    // persisted draft to `null`, never leave `undefined` on it (clean DB insert in stages.ts).
    setOrder(["openrouter"]);
    buildModelImpl = (name) => ({ name });
    const omittedImageDraft = {
      title: "Titre suffisamment long",
      bodyHtml: "<p>corps</p>",
      excerpt: "extrait",
      category: "Économie",
      tags: ["BRVM"],
      // featuredImageUrl, imageCredit, imageSourceUrl intentionally absent from this object
      confidence: { categoryUncertain: false, imageMissing: false, clusterUncertain: false },
    } as unknown as ArticleDraft;
    generateObjectImpl = async () => ({ object: omittedImageDraft });

    const r = await generateArticle({ ...baseInput, candidateImages: [] });
    expect(r.via).toBe("openrouter");
    expect(r.draft.featuredImageUrl).toBeNull();
    expect(r.draft.imageCredit).toBeNull();
    expect(r.draft.imageSourceUrl).toBeNull();
    // Explicitly assert `undefined` never leaks through — toBeNull() alone would also pass for
    // undefined in some matcher setups, so also check the key is present with value null.
    expect("featuredImageUrl" in r.draft && r.draft.featuredImageUrl === null).toBe(true);
    expect("imageCredit" in r.draft && r.draft.imageCredit === null).toBe(true);
    expect("imageSourceUrl" in r.draft && r.draft.imageSourceUrl === null).toBe(true);
    expect(r.draft.confidence.imageMissing).toBe(true);
  });

  it("sanitizeDraft persists null (never undefined) for imageSourceUrl when the provider sets an image+credit but omits the source URL", async () => {
    // The exact real-world shape reported: model picks a candidate image and sets imageCredit,
    // but omits imageSourceUrl outright instead of sending null.
    const cand = "https://cdn.example/img.jpg";
    setOrder(["openrouter"]);
    buildModelImpl = (name) => ({ name });
    const partialImageDraft = {
      title: "Titre suffisamment long",
      bodyHtml: "<p>corps</p>",
      excerpt: "extrait",
      category: "Économie",
      tags: ["BRVM"],
      featuredImageUrl: cand,
      imageCredit: "Ecofin",
      // imageSourceUrl intentionally absent
      confidence: { categoryUncertain: false, imageMissing: false, clusterUncertain: false },
    } as unknown as ArticleDraft;
    generateObjectImpl = async () => ({ object: partialImageDraft });

    const r = await generateArticle({ ...baseInput, candidateImages: [cand] });
    expect(r.via).toBe("openrouter");
    expect(r.draft.featuredImageUrl).toBe(cand);
    expect(r.draft.imageCredit).toBe("Ecofin");
    expect(r.draft.imageSourceUrl).toBeNull();
    expect("imageSourceUrl" in r.draft && r.draft.imageSourceUrl === null).toBe(true);
  });

  it("sanitizeDraft keeps a featuredImageUrl that IS a supplied candidate", async () => {
    const cand = "https://cdn.example/img.jpg";
    setOrder(["openrouter"]);
    buildModelImpl = (name) => ({ name });
    generateObjectImpl = async () => ({
      object: goodDraft({
        featuredImageUrl: cand,
        imageCredit: "Ecofin",
        imageSourceUrl: "https://src.example",
        confidence: { categoryUncertain: false, imageMissing: false, clusterUncertain: false },
      }),
    });

    const r = await generateArticle({ ...baseInput, candidateImages: [cand] });
    expect(r.draft.featuredImageUrl).toBe(cand);
    expect(r.draft.imageCredit).toBe("Ecofin");
    expect(r.draft.imageSourceUrl).toBe("https://src.example");
    expect(r.draft.confidence.imageMissing).toBe(false);
  });
});

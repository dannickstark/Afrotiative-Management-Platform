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
const { getPipelineSettings: realGetPipelineSettings } = await import("@/lib/queries/settings");
const { runWithOpenRouterPool: realRunWithOpenRouterPool } = await import("@/lib/ai/with-token-pool");

// --- Mutable controls, reset per test; the module mocks below delegate to these. ---
let buildModelImpl: (name: string, cfg: unknown) => unknown = () => null;
let generateObjectImpl: (opts: { model: unknown }) => Promise<{ object: ArticleDraft }> =
  async () => { throw new Error("generateObjectImpl not set"); };
// getPipelineSettings is only reached by generate-article.ts's REAL openrouter branch once
// cfg.openrouter is configured (below). Mocked so this DB-free ("pure" lane, per
// scripts/test-fast.ts's PURE_FILES) test file never opens a real DB connection just because a
// test sets OPENROUTER_API_KEY. openrouterMinContentChars: 400 matches the real default seeded
// by lib/queries/settings.ts's getPipelineSettings().
let getPipelineSettingsImpl: () => Promise<{ openrouterMinContentChars: number }> =
  async () => ({ openrouterMinContentChars: 400 });
// runWithOpenRouterPool is the rotation runner (lib/ai/with-token-pool.ts) — mocked so these
// unit tests can drive the openrouter branch's `op`/`isFlaky` wiring directly without a real DB
// token pool or a real OpenRouter API key. The DEFAULT below faithfully mirrors the real runner's
// single-token behavior (call op, ok:false on throw) WITHOUT applying isFlaky automatically —
// several tests below construct drafts with a short bodyHtml ("<p>corps</p>", well under any
// realistic openrouterMinContentChars) that would spuriously read as "flaky" if isFlaky were
// auto-applied here; isFlaky's real behavior is instead asserted directly (see "routes the
// openrouter branch through runWithOpenRouterPool" below) against the closure the call site wires
// in, exactly as it's actually invoked in production.
// The optional 3rd `deps` param is NOT used by this file's own tests, but MUST still be accepted
// and forwarded: this mock.module() call leaks into every file that imports "@/lib/ai/with-token-
// pool" afterwards in the same `bun test` process (same reasoning as the buildModel/generateObject
// leak documented above) — including tests/with-token-pool.test.ts, which calls the REAL
// runWithOpenRouterPool(op, isFlaky, deps) with an explicit `deps` override to fake the pool
// without a DB. Dropping that 3rd arg here would silently swap it for the REAL default deps
// (real DB pool) once this file's afterAll restores runWithOpenRouterPoolImpl to the real function.
let runWithOpenRouterPoolImpl: (
  op: (apiKey: string) => Promise<ArticleDraft>,
  isFlaky: (v: ArticleDraft) => boolean,
  deps?: unknown,
) => Promise<{ ok: true; value: ArticleDraft } | { ok: false; reason: string; detail?: string }> = async (op) => {
  try {
    return { ok: true, value: await op("test-openrouter-api-key") };
  } catch {
    return { ok: false, reason: "error" };
  }
};

// Network-free: replace only the provider factory and the AI SDK (nothing else in the
// suite imports these, so replacing them wholesale cannot leak into other test files).
// The config is NOT module-mocked — Bun shares one module registry across the whole
// `bun test` run, so a partial mock of pipeline-config would break other files that need
// parsePipelineConfig. Instead we drive cfg.llmOrder via the REAL getPipelineConfig through
// process.env.LLM_ORDER; buildModel is mocked, so provider-credential gating is irrelevant for
// the NON-openrouter branch (openrouter itself is now gated on the REAL cfg.openrouter, i.e. the
// REAL process.env.OPENROUTER_API_KEY — see the individual tests below).
// mockGenerateArticle + schema also remain REAL so the terminal-mock path is exercised for real.
//
// All four factories are a stable indirection (they always call through the *Impl variables,
// never inline the test-of-the-moment logic), so repointing them at the real functions in
// afterAll (below) genuinely restores real behavior for every current AND future importer —
// without needing Bun to support "un-mocking" a module.
// buildOpenRouterModel is left UNTOUCHED by this factory — because `realBuildModel` above was
// captured via a top-level `await import(...)` before this call, Bun merges this factory's keys
// onto the already-cached module object rather than replacing it wholesale, so
// buildOpenRouterModel stays the REAL function for the openrouter branch's `op` to call.
mock.module("@/lib/ai/providers", () => ({
  buildModel: (name: string, cfg: unknown) => buildModelImpl(name, cfg),
}));
mock.module("ai", () => ({
  generateObject: (opts: { model: unknown }) => generateObjectImpl(opts),
}));
mock.module("@/lib/queries/settings", () => ({
  getPipelineSettings: () => getPipelineSettingsImpl(),
}));
mock.module("@/lib/ai/with-token-pool", () => ({
  runWithOpenRouterPool: (op: (apiKey: string) => Promise<ArticleDraft>, isFlaky: (v: ArticleDraft) => boolean, deps?: unknown) =>
    runWithOpenRouterPoolImpl(op, isFlaky, deps),
}));

// Imported AFTER the mocks are registered so its static imports resolve to the mocks.
const { generateArticle, articleIsFlaky } = await import("@/lib/ai/generate-article");

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
  const originalOpenRouterKey = process.env.OPENROUTER_API_KEY;
  beforeEach(() => {
    // Silence the observability console.warn emitted on provider failure.
    spyOn(console, "warn").mockImplementation(() => {});
    buildModelImpl = () => null;
    generateObjectImpl = async () => { throw new Error("generateObjectImpl not set"); };
    getPipelineSettingsImpl = async () => ({ openrouterMinContentChars: 400 });
    runWithOpenRouterPoolImpl = async (op) => {
      try {
        return { ok: true, value: await op("test-openrouter-api-key") };
      } catch {
        return { ok: false, reason: "error" };
      }
    };
    if (originalOrder === undefined) delete process.env.LLM_ORDER;
    else process.env.LLM_ORDER = originalOrder;
    // Every test below opts IN to a configured openrouter (cfg.openrouter defined) by explicitly
    // setting this itself; default it to ABSENT here so "unconfigured" is the neutral baseline
    // (matches test-setup.ts's real-world stripping of OPENROUTER_API_KEY for the whole suite).
    delete process.env.OPENROUTER_API_KEY;
  });

  // Bun shares ONE module registry across the whole `bun test` run, so the mock.module(…) stubs
  // registered above the describe block would otherwise leak into every other test file that
  // imports those modules afterwards — notably tests/pipeline-run.test.ts's "network-free E2E"
  // stageItem test, whose generateArticle() call would then resolve these leaked stubs instead of
  // exercising the real generate→mock fallback path. mock.restore() only undoes the
  // spyOn(console, "warn") mock (module mocks are not restorable in this Bun version) — so real
  // restoration comes from repointing the *Impl indirection at the real functions captured above.
  afterAll(() => {
    mock.restore();
    buildModelImpl = realBuildModel as unknown as typeof buildModelImpl;
    generateObjectImpl = realGenerateObject as unknown as typeof generateObjectImpl;
    getPipelineSettingsImpl = realGetPipelineSettings as unknown as typeof getPipelineSettingsImpl;
    runWithOpenRouterPoolImpl = realRunWithOpenRouterPool as unknown as typeof runWithOpenRouterPoolImpl;
    if (originalOrder === undefined) delete process.env.LLM_ORDER;
    else process.env.LLM_ORDER = originalOrder;
    if (originalOpenRouterKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = originalOpenRouterKey;
  });

  it("skips openrouter when unconfigured (cfg.openrouter unset) and uses the next configured provider", async () => {
    delete process.env.OPENROUTER_API_KEY; // cfg.openrouter undefined → the openrouter branch's own gate skips it
    setOrder(["openrouter", "omniroute"]);
    buildModelImpl = (name) => ({ name }); // only reached for omniroute now — openrouter no longer calls buildModel
    let poolCalled = false;
    runWithOpenRouterPoolImpl = async () => { poolCalled = true; return { ok: false, reason: "error" }; };
    const seen: string[] = [];
    generateObjectImpl = async (opts) => { seen.push((opts.model as { name: string }).name); return { object: goodDraft({ category: "Marchés" }) }; };

    const r = await generateArticle(baseInput);
    expect(poolCalled).toBe(false); // the pool runner is never invoked when openrouter is unconfigured
    expect(r.via).toBe("omniroute");
    expect(seen).toEqual(["omniroute"]); // generateObject never invoked for the skipped provider
    expect(r.draft.category).toBe("Marchés");
    expect(r.failure).toBeUndefined(); // nominal path — no failure carried
  });

  it("falls through to the next provider when the OpenRouter pool is exhausted ({ok:false})", async () => {
    process.env.OPENROUTER_API_KEY = "test-openrouter-api-key";
    setOrder(["openrouter", "omniroute"]);
    buildModelImpl = (name) => ({ name });
    // Real runWithOpenRouterPool would return {ok:false} once every pooled token's op() throws
    // (quota exceeded, etc.) — expressed here directly via the mocked pool runner, matching the
    // NEW architecture rather than a per-name check inside generateObjectImpl.
    runWithOpenRouterPoolImpl = async () => ({ ok: false, reason: "rate_limited" });
    generateObjectImpl = async () => { return { object: goodDraft({ category: "Marchés" }) }; }; // only omniroute reaches this now

    const r = await generateArticle(baseInput);
    expect(r.via).toBe("omniroute");
    expect(r.draft.category).toBe("Marchés");
    expect(r.failure).toBeUndefined(); // nominal path (omniroute succeeded) — no failure carried
  });

  it("returns the deterministic mock with via='mock' when every provider fails", async () => {
    process.env.OPENROUTER_API_KEY = "test-openrouter-api-key";
    setOrder(["openrouter", "omniroute"]);
    buildModelImpl = (name) => ({ name });
    runWithOpenRouterPoolImpl = async () => ({ ok: false, reason: "rate_limited" }); // openrouter pool exhausted
    generateObjectImpl = async () => { throw new Error("provider down"); }; // omniroute also fails

    const r = await generateArticle(baseInput);
    expect(r.via).toBe("mock");
    expect(r.draft.title.startsWith("[MOCK]")).toBe(true);
    expect(r.draft.category).toBe("Économie"); // mock uses categories[0]
    expect(r.draft.confidence.categoryUncertain).toBe(true); // mock is always low-confidence
    // omniroute's own throw (both attempts) is the LAST failure recorded, overriding openrouter's
    // rate_limited — matches the brief: "la dernière raison mémorisée gagne".
    expect(r.failure).toBe("error");
    expect(r.failureDetail).toBe("provider down");
  });

  it("returns via='mock' with failure='rate_limited' when the OpenRouter pool is the ONLY configured provider and is exhausted", async () => {
    process.env.OPENROUTER_API_KEY = "test-openrouter-api-key";
    setOrder(["openrouter"]);
    runWithOpenRouterPoolImpl = async () => ({ ok: false, reason: "rate_limited" });

    const r = await generateArticle(baseInput);
    expect(r.via).toBe("mock");
    expect(r.failure).toBe("rate_limited");
  });

  it("returns via='mock' with failure='unconfigured' when llmOrder has no configured provider at all", async () => {
    delete process.env.OPENROUTER_API_KEY; // openrouter branch's own gate skips it — never tried
    setOrder(["openrouter", "omniroute"]);
    buildModelImpl = () => null; // omniroute also has no model → never tried either
    let poolCalled = false;
    runWithOpenRouterPoolImpl = async () => { poolCalled = true; return { ok: false, reason: "error" }; };

    const r = await generateArticle(baseInput);
    expect(poolCalled).toBe(false);
    expect(r.via).toBe("mock");
    expect(r.failure).toBe("unconfigured");
    expect(r.failureDetail).toBeUndefined();
  });

  // The "Important" finding this test (and its assertions) directly answers: with the LEGACY
  // buildModel-mock tests removed, nothing previously proved that generateArticle's openrouter
  // branch actually calls runWithOpenRouterPool with a correct `op` (builds a real model via
  // buildOpenRouterModel and runs the SAME generateObject call the file already makes) and a
  // correct `isFlaky` (articleIsFlaky bound to settings.openrouterMinContentChars). This test
  // captures the exact arguments the call site passes to the (mocked) pool runner and asserts
  // them directly, then drives a successful pool result through to via:"openrouter".
  it("routes the openrouter branch through runWithOpenRouterPool: builds a model via buildOpenRouterModel and applies articleIsFlaky", async () => {
    process.env.OPENROUTER_API_KEY = "test-openrouter-api-key";
    setOrder(["openrouter"]);
    getPipelineSettingsImpl = async () => ({ openrouterMinContentChars: 400 });

    let seenApiKey: string | undefined;
    let seenModel: unknown;
    let capturedIsFlaky: ((d: ArticleDraft) => boolean) | undefined;
    runWithOpenRouterPoolImpl = async (op, isFlaky) => {
      capturedIsFlaky = isFlaky;
      seenApiKey = "fake-pool-key";
      const value = await op("fake-pool-key");
      return { ok: true, value };
    };
    generateObjectImpl = async (opts) => {
      seenModel = opts.model;
      return { object: goodDraft({ title: "Article réel produit par le modèle" }) };
    };

    const r = await generateArticle(baseInput);

    expect(r.via).toBe("openrouter");
    expect(r.draft.title).toBe("Article réel produit par le modèle");
    expect(seenApiKey).toBe("fake-pool-key");
    // op really called buildOpenRouterModel(cfg, apiKey) (the REAL function — only buildModel is
    // mocked above) and passed the resulting model into generateObject, not some placeholder.
    expect(seenModel).toBeTruthy();

    // The SAME isFlaky closure the call site wired in — proves settings.openrouterMinContentChars
    // (mocked to 400 above, matching the real default) actually drives the rule, matching
    // articleIsFlaky's own unit-tested boundary (tests/openrouter-flaky-wiring.test.ts).
    expect(capturedIsFlaky).toBeTruthy();
    expect(capturedIsFlaky!(goodDraft({ bodyHtml: "<p>short</p>" }))).toBe(true);
    expect(capturedIsFlaky!(goodDraft({ bodyHtml: "<p>" + "a".repeat(500) + "</p>" }))).toBe(false);
    expect(capturedIsFlaky!(goodDraft({ bodyHtml: "<p>short</p>" }))).toBe(articleIsFlaky("<p>short</p>", 400));
  });

  it("sanitizeDraft nulls a featuredImageUrl that is not a supplied candidate (and its image fields)", async () => {
    process.env.OPENROUTER_API_KEY = "test-openrouter-api-key";
    setOrder(["openrouter"]);
    generateObjectImpl = async () => ({
      object: goodDraft({
        featuredImageUrl: "https://not-a-candidate.example/x.jpg",
        imageCredit: "Quelqu'un",
        imageSourceUrl: "https://src.example",
        confidence: { categoryUncertain: false, imageMissing: false, clusterUncertain: false },
      }),
    });

    const r = await generateArticle({ ...baseInput, candidateImages: [] });
    expect(r.via).toBe("openrouter");
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
    process.env.OPENROUTER_API_KEY = "test-openrouter-api-key";
    setOrder(["openrouter"]);
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
    process.env.OPENROUTER_API_KEY = "test-openrouter-api-key";
    setOrder(["openrouter"]);
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
    process.env.OPENROUTER_API_KEY = "test-openrouter-api-key";
    setOrder(["openrouter"]);
    generateObjectImpl = async () => ({
      object: goodDraft({
        featuredImageUrl: cand,
        imageCredit: "Ecofin",
        imageSourceUrl: "https://src.example",
        confidence: { categoryUncertain: false, imageMissing: false, clusterUncertain: false },
      }),
    });

    const r = await generateArticle({ ...baseInput, candidateImages: [cand] });
    expect(r.via).toBe("openrouter");
    expect(r.draft.featuredImageUrl).toBe(cand);
    expect(r.draft.imageCredit).toBe("Ecofin");
    expect(r.draft.imageSourceUrl).toBe("https://src.example");
    expect(r.draft.confidence.imageMissing).toBe(false);
  });
});

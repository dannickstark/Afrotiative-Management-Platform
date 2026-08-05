import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, mock, spyOn } from "bun:test";
import { db, pipelineSettings } from "@/db";
import { eq } from "drizzle-orm";
import type { PipelineSettings } from "@/lib/queries/settings";

// Capture the REAL brave module BEFORE mock.module() below swaps the registry. Bun mutates the
// SAME exports object in place (documented at length in tests/ai-fallback.test.ts) — destructuring
// the real braveSearch here, before the mock is registered, is what lets afterAll genuinely
// restore it afterwards instead of leaking the stub into the rest of the `bun test` process.
const realBrave = await import("@/lib/search/brave");
const { parseBraveResponse } = realBrave;

// Mutable indirection the module mock below always delegates to — swapped per-test to simulate a
// Brave failure, reset to the real implementation by default.
let braveSearchImpl: typeof realBrave.braveSearch = realBrave.braveSearch;

mock.module("@/lib/search/brave", () => ({
  braveSearch: (...args: Parameters<typeof realBrave.braveSearch>) => braveSearchImpl(...args),
  parseBraveResponse: realBrave.parseBraveResponse,
}));

// Imported AFTER the mock is registered so its internal `./brave` import resolves to the stub.
const { searchRelated } = await import("@/lib/search");

// pipeline_settings row id=1 is a shared, app-wide singleton (possibly holding a real
// admin-configured value) — snapshot once before this file's tests run and restore exactly
// (present with original values, or absent) once at the very end. Same pattern as
// tests/pipeline-settings.test.ts.
let snapshot: PipelineSettings | null = null;

beforeAll(async () => {
  const [row] = await db.select().from(pipelineSettings).where(eq(pipelineSettings.id, 1));
  snapshot = row ?? null;
});

afterAll(async () => {
  await db.delete(pipelineSettings).where(eq(pipelineSettings.id, 1));
  if (snapshot) await db.insert(pipelineSettings).values(snapshot);
  mock.restore();
  braveSearchImpl = realBrave.braveSearch;
});

async function setWebSearchEnabled(enabled: boolean): Promise<void> {
  await db.delete(pipelineSettings).where(eq(pipelineSettings.id, 1));
  await db.insert(pipelineSettings).values({ id: 1, webSearchEnabled: enabled });
}

// test-setup.ts already strips every `*_API_KEY` env var (including BRAVE_SEARCH_API_KEY) before
// the suite runs; snapshot/restore explicitly anyway so this file is self-contained and
// order-independent with respect to any other file.
const ORIGINAL_BRAVE_KEY = process.env.BRAVE_SEARCH_API_KEY;

beforeEach(() => {
  braveSearchImpl = realBrave.braveSearch;
});
afterEach(() => {
  if (ORIGINAL_BRAVE_KEY === undefined) delete process.env.BRAVE_SEARCH_API_KEY;
  else process.env.BRAVE_SEARCH_API_KEY = ORIGINAL_BRAVE_KEY;
});

describe("searchRelated (network-free)", () => {
  it("returns [] when webSearchEnabled is false, regardless of BRAVE_SEARCH_API_KEY", async () => {
    await setWebSearchEnabled(false);
    process.env.BRAVE_SEARCH_API_KEY = "fake-key-should-never-be-used";

    const results = await searchRelated("BRVM");
    expect(results).toEqual([]);
  });

  it("returns [] when enabled but no BRAVE_SEARCH_API_KEY is configured", async () => {
    await setWebSearchEnabled(true);
    delete process.env.BRAVE_SEARCH_API_KEY;

    const results = await searchRelated("BRVM");
    expect(results).toEqual([]);
  });

  it("never throws — swallows a Brave provider error, logs a French [search] warning, and returns []", async () => {
    await setWebSearchEnabled(true);
    process.env.BRAVE_SEARCH_API_KEY = "fake-key";
    braveSearchImpl = async () => { throw new Error("panne réseau simulée"); };
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

    const results = await searchRelated("sujet quelconque");

    expect(results).toEqual([]);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain("[search]");
    warnSpy.mockRestore();
  });

  it("respects the opts.limit passed through to the provider", async () => {
    await setWebSearchEnabled(true);
    process.env.BRAVE_SEARCH_API_KEY = "fake-key";
    let seenLimit: number | undefined;
    braveSearchImpl = async (_q, _k, limit) => { seenLimit = limit; return []; };

    await searchRelated("BRVM", { limit: 5 });
    expect(seenLimit).toBe(5);
  });

  it("defaults to a small result cap (3) when no limit is given", async () => {
    await setWebSearchEnabled(true);
    process.env.BRAVE_SEARCH_API_KEY = "fake-key";
    let seenLimit: number | undefined;
    braveSearchImpl = async (_q, _k, limit) => { seenLimit = limit; return []; };

    await searchRelated("BRVM");
    expect(seenLimit).toBe(3);
  });
});

describe("parseBraveResponse (pure, no network)", () => {
  it("maps a canned Brave Web Search JSON response to SearchResult[]", () => {
    const fixture = {
      web: {
        results: [
          { title: "BRVM: nouveau record", url: "https://ecofin.example/brvm-record", description: "La bourse régionale progresse." },
          { title: "Analyse des marchés", url: "https://ja.example/marches", description: "Les investisseurs saluent la tendance." },
        ],
      },
    };

    expect(parseBraveResponse(fixture, 3)).toEqual([
      { title: "BRVM: nouveau record", url: "https://ecofin.example/brvm-record", snippet: "La bourse régionale progresse." },
      { title: "Analyse des marchés", url: "https://ja.example/marches", snippet: "Les investisseurs saluent la tendance." },
    ]);
  });

  it("caps the number of results at the given limit", () => {
    const fixture = {
      web: {
        results: Array.from({ length: 10 }, (_, i) => ({
          title: `Résultat ${i}`, url: `https://example.com/${i}`, description: `Extrait ${i}`,
        })),
      },
    };

    expect(parseBraveResponse(fixture, 3)).toHaveLength(3);
  });

  it("returns [] when the response has no web.results", () => {
    expect(parseBraveResponse({}, 3)).toEqual([]);
    expect(parseBraveResponse({ web: {} }, 3)).toEqual([]);
    expect(parseBraveResponse(null, 3)).toEqual([]);
  });

  it("skips malformed entries missing title or url", () => {
    const fixture = { web: { results: [{ description: "sans titre ni url" }, { title: "OK", url: "https://x.example", description: "bien formé" }] } };
    expect(parseBraveResponse(fixture, 5)).toEqual([{ title: "OK", url: "https://x.example", snippet: "bien formé" }]);
  });

  it("defaults snippet to an empty string when description is missing", () => {
    const fixture = { web: { results: [{ title: "Sans description", url: "https://x.example" }] } };
    expect(parseBraveResponse(fixture, 5)).toEqual([{ title: "Sans description", url: "https://x.example", snippet: "" }]);
  });
});

import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, mock, spyOn } from "bun:test";
import { db, pipelineSettings } from "@/db";
import { eq } from "drizzle-orm";
import type { PipelineSettings } from "@/lib/queries/settings";

// Capture the REAL brave + settings exports BEFORE mock.module() below swaps the registry, and
// DESTRUCTURE each function into its own plain const. This matters: Bun's mock.module() mutates
// the SAME module-namespace object in place (documented at length in tests/ai-fallback.test.ts),
// so re-reading `realSettings.getPipelineSettings` AFTER mocking would yield the WRAPPER, not the
// original — and since the wrapper delegates to getPipelineSettingsImpl, feeding the wrapper back
// into that indirection (in beforeEach) is infinite recursion. Destructured consts are copies that
// mock.module() can no longer touch, so they stay the genuine originals for the whole file.
const realBrave = await import("@/lib/search/brave");
const { braveSearch: realBraveSearch, parseBraveResponse } = realBrave;
const realSettingsModule = await import("@/lib/queries/settings");
const {
  getPipelineSettings: realGetPipelineSettings,
  getFeeds, getMembers, getTaxonomy, getIntegrationStatus,
} = realSettingsModule;

// Mutable indirections the module mocks below always delegate to — swapped per-test to simulate a
// Brave failure / a settings-read rejection, reset to the real implementations by default.
let braveSearchImpl: typeof realBraveSearch = realBraveSearch;
let getPipelineSettingsImpl: typeof realGetPipelineSettings = realGetPipelineSettings;

mock.module("@/lib/search/brave", () => ({
  braveSearch: (...args: Parameters<typeof realBraveSearch>) => braveSearchImpl(...args),
  parseBraveResponse,
}));

// List every export explicitly (NOT `...realSettingsModule`) so getFeeds/getTaxonomy/… stay the
// real functions for any other test file that imports them, while getPipelineSettings routes
// through the mutable indirection. Spreading the namespace here is what deadlocked an earlier
// draft — the spread re-materialized the wrapper back onto the indirection.
mock.module("@/lib/queries/settings", () => ({
  getFeeds, getMembers, getTaxonomy, getIntegrationStatus,
  getPipelineSettings: (...args: Parameters<typeof realGetPipelineSettings>) => getPipelineSettingsImpl(...args),
}));

// Imported AFTER the mocks are registered so its internal `./brave` and `@/lib/queries/settings`
// imports resolve to the stubs.
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
  braveSearchImpl = realBraveSearch;
  getPipelineSettingsImpl = realGetPipelineSettings;
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
  braveSearchImpl = realBraveSearch;
  getPipelineSettingsImpl = realGetPipelineSettings;
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

  it("never throws — swallows a getPipelineSettings() DB rejection and returns [] (transient Neon blip)", async () => {
    // The settings read hits Neon (and may run a seed-insert) — a transient DB failure there must
    // degrade to [] just like a Brave failure, since SP4 Task 6 calls searchRelated from inside the
    // per-story runner loop. Set the key so we'd otherwise proceed past the gates to the DB read.
    process.env.BRAVE_SEARCH_API_KEY = "fake-key";
    getPipelineSettingsImpl = async () => { throw new Error("Neon indisponible (simulé)"); };
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

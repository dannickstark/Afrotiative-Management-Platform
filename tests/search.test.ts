import { describe, it, expect, spyOn } from "bun:test";
import { resolveWebSearch, type SearchProvider, type SearchResult } from "@/lib/search";
import { parseBraveResponse } from "@/lib/search/brave";
import { parseExaResponse } from "@/lib/search/exa";

// These chain tests exercise the FULLY-INJECTABLE core resolveWebSearch(loadSettings, order,
// providers, env, query, limit) with plain fakes — NO mock.module, NO process.env manipulation,
// NO DB. That matters: Bun's mock.module() is global and cannot intercept a module another test
// file already imported, so an earlier draft that mocked @/lib/search/brave|exa|queries/settings
// failed order-dependently (green alone, red after tests/pipeline-web-search.test.ts imported the
// real modules first). Injecting every dependency as an argument makes these tests immune to file
// execution order. searchRelated()'s public signature is unchanged; it's now a thin wrapper that
// wires the real getPipelineSettings / searchOrder / PROVIDERS / process.env into this same core.

// A fake provider whose .search returns canned results (or throws), recording whether it was
// called so "the next provider was NOT reached" is a positive assertion, not an inference.
function fakeProvider(
  name: string,
  envKey: string,
  behavior: (query: string, apiKey: string, limit: number) => Promise<SearchResult[]>,
): SearchProvider & { calls: number; lastLimit?: number } {
  const p = {
    name, envKey, calls: 0, lastLimit: undefined as number | undefined,
    async search(query: string, apiKey: string, limit: number) {
      p.calls++; p.lastLimit = limit;
      return behavior(query, apiKey, limit);
    },
  };
  return p;
}

const settingsOn = async () => ({ webSearchEnabled: true });
const settingsOff = async () => ({ webSearchEnabled: false });

describe("resolveWebSearch — provider chain (injectable, network-free)", () => {
  it("returns [] when webSearchEnabled is false, without consulting any provider", async () => {
    const brave = fakeProvider("brave", "BRAVE_SEARCH_API_KEY", async () => [{ title: "x", url: "https://x", snippet: "" }]);
    const exa = fakeProvider("exa", "EXA_API_KEY", async () => [{ title: "y", url: "https://y", snippet: "" }]);

    const results = await resolveWebSearch(
      settingsOff, ["brave", "exa"], [brave, exa],
      { BRAVE_SEARCH_API_KEY: "k", EXA_API_KEY: "k" }, "BRVM", 3,
    );

    expect(results).toEqual([]);
    expect(brave.calls).toBe(0);
    expect(exa.calls).toBe(0);
  });

  it("returns [] when enabled but no provider key is configured", async () => {
    const brave = fakeProvider("brave", "BRAVE_SEARCH_API_KEY", async () => { throw new Error("ne doit pas être appelé"); });
    const exa = fakeProvider("exa", "EXA_API_KEY", async () => { throw new Error("ne doit pas être appelé"); });

    const results = await resolveWebSearch(settingsOn, ["brave", "exa"], [brave, exa], {}, "BRVM", 3);

    expect(results).toEqual([]);
    expect(brave.calls).toBe(0);
    expect(exa.calls).toBe(0);
  });

  it("Brave key only, braveSearch succeeds → returns Brave's results, Exa is never called", async () => {
    const braveResults = [{ title: "Brave hit", url: "https://brave.example", snippet: "..." }];
    const brave = fakeProvider("brave", "BRAVE_SEARCH_API_KEY", async () => braveResults);
    const exa = fakeProvider("exa", "EXA_API_KEY", async () => [{ title: "Exa", url: "https://exa", snippet: "" }]);

    const results = await resolveWebSearch(
      settingsOn, ["brave", "exa"], [brave, exa], { BRAVE_SEARCH_API_KEY: "k" }, "BRVM", 3,
    );

    expect(results).toEqual(braveResults);
    expect(brave.calls).toBe(1);
    expect(exa.calls).toBe(0);
  });

  it("returns Brave's result even when it is an empty array (first success wins, Exa not tried)", async () => {
    const brave = fakeProvider("brave", "BRAVE_SEARCH_API_KEY", async () => []);
    const exa = fakeProvider("exa", "EXA_API_KEY", async () => [{ title: "Exa", url: "https://exa", snippet: "" }]);

    const results = await resolveWebSearch(
      settingsOn, ["brave", "exa"], [brave, exa], { BRAVE_SEARCH_API_KEY: "k", EXA_API_KEY: "k" }, "BRVM", 3,
    );

    expect(results).toEqual([]);
    expect(brave.calls).toBe(1);
    expect(exa.calls).toBe(0);
  });

  it("falls back to Exa when Brave throws (simulated 429/quota) and both keys are set", async () => {
    const exaResults = [{ title: "Exa hit", url: "https://exa.example", snippet: "..." }];
    const brave = fakeProvider("brave", "BRAVE_SEARCH_API_KEY", async () => { throw new Error("429 quota exceeded (simulé)"); });
    const exa = fakeProvider("exa", "EXA_API_KEY", async () => exaResults);
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

    const results = await resolveWebSearch(
      settingsOn, ["brave", "exa"], [brave, exa], { BRAVE_SEARCH_API_KEY: "k", EXA_API_KEY: "k" }, "BRVM", 3,
    );

    expect(results).toEqual(exaResults);
    expect(brave.calls).toBe(1);
    expect(exa.calls).toBe(1);
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain("[search]");
    warnSpy.mockRestore();
  });

  it("Exa key only (no Brave key) → skips Brave silently and uses Exa", async () => {
    const exaResults = [{ title: "Exa only", url: "https://exa.example", snippet: "..." }];
    const brave = fakeProvider("brave", "BRAVE_SEARCH_API_KEY", async () => { throw new Error("ne doit pas être appelé"); });
    const exa = fakeProvider("exa", "EXA_API_KEY", async () => exaResults);
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

    const results = await resolveWebSearch(
      settingsOn, ["brave", "exa"], [brave, exa], { EXA_API_KEY: "k" }, "BRVM", 3,
    );

    expect(results).toEqual(exaResults);
    expect(brave.calls).toBe(0); // no key → not attempted
    expect(exa.calls).toBe(1);
    expect(warnSpy).not.toHaveBeenCalled(); // a skipped (keyless) provider logs nothing
    warnSpy.mockRestore();
  });

  it("respects order = ['exa','brave'] — tries Exa first even though Brave is also configured", async () => {
    const exaResults = [{ title: "Exa first", url: "https://exa.example", snippet: "..." }];
    const brave = fakeProvider("brave", "BRAVE_SEARCH_API_KEY", async () => { throw new Error("ne devrait jamais être appelé"); });
    const exa = fakeProvider("exa", "EXA_API_KEY", async () => exaResults);

    const results = await resolveWebSearch(
      settingsOn, ["exa", "brave"], [brave, exa], { BRAVE_SEARCH_API_KEY: "k", EXA_API_KEY: "k" }, "BRVM", 3,
    );

    expect(results).toEqual(exaResults);
    expect(exa.calls).toBe(1);
    expect(brave.calls).toBe(0);
  });

  it("ignores an unknown provider name in the order and continues to a known one", async () => {
    const exaResults = [{ title: "Exa", url: "https://exa.example", snippet: "" }];
    const exa = fakeProvider("exa", "EXA_API_KEY", async () => exaResults);

    const results = await resolveWebSearch(
      settingsOn, ["bing", "exa"], [exa], { EXA_API_KEY: "k" }, "BRVM", 3,
    );

    expect(results).toEqual(exaResults);
    expect(exa.calls).toBe(1);
  });

  it("never throws — both providers throw → returns [] (chain exhausted), one warning each", async () => {
    const brave = fakeProvider("brave", "BRAVE_SEARCH_API_KEY", async () => { throw new Error("panne Brave simulée"); });
    const exa = fakeProvider("exa", "EXA_API_KEY", async () => { throw new Error("panne Exa simulée"); });
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

    const results = await resolveWebSearch(
      settingsOn, ["brave", "exa"], [brave, exa], { BRAVE_SEARCH_API_KEY: "k", EXA_API_KEY: "k" }, "sujet", 3,
    );

    expect(results).toEqual([]);
    expect(brave.calls).toBe(1);
    expect(exa.calls).toBe(1);
    expect(warnSpy).toHaveBeenCalledTimes(2);
    for (const call of warnSpy.mock.calls) expect(String(call[0])).toContain("[search]");
    warnSpy.mockRestore();
  });

  it("never throws — a single Brave failure with no other provider configured → [] + one warning", async () => {
    const brave = fakeProvider("brave", "BRAVE_SEARCH_API_KEY", async () => { throw new Error("panne réseau simulée"); });
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

    const results = await resolveWebSearch(
      settingsOn, ["brave", "exa"], [brave], { BRAVE_SEARCH_API_KEY: "k" }, "sujet", 3,
    );

    expect(results).toEqual([]);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain("[search]");
    warnSpy.mockRestore();
  });

  it("never throws — swallows a loadSettings() rejection and returns [] (transient Neon blip)", async () => {
    const loadSettings = async () => { throw new Error("Neon indisponible (simulé)"); };
    const brave = fakeProvider("brave", "BRAVE_SEARCH_API_KEY", async () => [{ title: "x", url: "https://x", snippet: "" }]);
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

    const results = await resolveWebSearch(
      loadSettings, ["brave", "exa"], [brave], { BRAVE_SEARCH_API_KEY: "k" }, "sujet", 3,
    );

    expect(results).toEqual([]);
    expect(brave.calls).toBe(0); // never reached the provider loop
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain("[search]");
    warnSpy.mockRestore();
  });

  it("passes the given limit through verbatim to the chosen provider", async () => {
    const brave = fakeProvider("brave", "BRAVE_SEARCH_API_KEY", async () => []);

    await resolveWebSearch(settingsOn, ["brave"], [brave], { BRAVE_SEARCH_API_KEY: "k" }, "BRVM", 5);
    expect(brave.lastLimit).toBe(5);

    await resolveWebSearch(settingsOn, ["brave"], [brave], { BRAVE_SEARCH_API_KEY: "k" }, "BRVM", 3);
    expect(brave.lastLimit).toBe(3);
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

describe("parseExaResponse (pure, no network)", () => {
  it("maps a canned Exa Search JSON response to SearchResult[], preferring highlights[0] as the snippet", () => {
    const fixture = {
      results: [
        {
          title: "BRVM: nouveau record", url: "https://ecofin.example/brvm-record",
          highlights: ["La bourse régionale progresse fortement."],
          summary: "résumé ignoré quand un highlight existe",
        },
        {
          title: "Analyse des marchés", url: "https://ja.example/marches",
          highlights: [], summary: "Les investisseurs saluent la tendance.",
        },
      ],
    };

    expect(parseExaResponse(fixture, 3)).toEqual([
      { title: "BRVM: nouveau record", url: "https://ecofin.example/brvm-record", snippet: "La bourse régionale progresse fortement." },
      { title: "Analyse des marchés", url: "https://ja.example/marches", snippet: "Les investisseurs saluent la tendance." },
    ]);
  });

  it("falls back to text when neither highlights nor summary are present", () => {
    const fixture = { results: [{ title: "Texte brut", url: "https://x.example", text: "Un long extrait de la page qui sert de secours." }] };
    expect(parseExaResponse(fixture, 3)).toEqual([
      { title: "Texte brut", url: "https://x.example", snippet: "Un long extrait de la page qui sert de secours." },
    ]);
  });

  it("caps the number of results at the given limit", () => {
    const fixture = {
      results: Array.from({ length: 10 }, (_, i) => ({
        title: `Résultat ${i}`, url: `https://example.com/${i}`, highlights: [`Extrait ${i}`],
      })),
    };

    expect(parseExaResponse(fixture, 3)).toHaveLength(3);
  });

  it("returns [] when the response has no results", () => {
    expect(parseExaResponse({}, 3)).toEqual([]);
    expect(parseExaResponse({ results: [] }, 3)).toEqual([]);
    expect(parseExaResponse(null, 3)).toEqual([]);
  });

  it("skips malformed entries missing title or url", () => {
    const fixture = { results: [{ highlights: ["sans titre ni url"] }, { title: "OK", url: "https://x.example", highlights: ["bien formé"] }] };
    expect(parseExaResponse(fixture, 5)).toEqual([{ title: "OK", url: "https://x.example", snippet: "bien formé" }]);
  });

  it("defaults snippet to an empty string when no highlight/summary/text is present", () => {
    const fixture = { results: [{ title: "Sans extrait", url: "https://x.example" }] };
    expect(parseExaResponse(fixture, 5)).toEqual([{ title: "Sans extrait", url: "https://x.example", snippet: "" }]);
  });
});

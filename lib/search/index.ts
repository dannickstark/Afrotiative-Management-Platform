import { getPipelineSettings } from "@/lib/queries/settings";
import { getPipelineConfig } from "@/lib/config/pipeline-config";
import { braveSearch } from "./brave";
import { exaSearch } from "./exa";

export type SearchResult = { title: string; url: string; snippet: string };

// A web-search provider: a name (matched against searchOrder / SEARCH_ORDER), the env var that
// gates it, and its thin, throwing `search()` implementation (mirrors lib/search/brave.ts /
// lib/search/exa.ts).
export type SearchProvider = {
  name: string;
  envKey: string;
  search: (query: string, apiKey: string, limit: number) => Promise<SearchResult[]>;
};

const DEFAULT_LIMIT = 3;
const MAX_LIMIT = 10; // hard cap regardless of what a caller asks for

// The REAL provider chain, tried in `searchOrder` (env SEARCH_ORDER, default "brave,exa"). Kept as
// a module constant so searchRelated() stays a thin wrapper; resolveWebSearch() below takes the
// list as an argument instead, so tests inject plain fakes without mock.module (which Bun cannot
// apply to a module another test file already imported — the source of an order-dependent test
// failure otherwise).
const PROVIDERS: SearchProvider[] = [
  { name: "brave", envKey: "BRAVE_SEARCH_API_KEY", search: braveSearch },
  { name: "exa", envKey: "EXA_API_KEY", search: exaSearch },
];

// Fully-injectable core of the web-search provider chain — every dependency (the settings loader,
// the provider order, the provider list, and the env map) is an argument, so it's deterministically
// unit-testable with plain fakes and no global mocking. searchRelated() below is the thin
// production wiring.
//
// Semantics (see searchRelated's doc): gated on webSearchEnabled; providers tried IN ORDER; a
// provider missing its key is skipped silently; a provider that throws is logged (French,
// "[search]"-prefixed) and the NEXT is tried; the FIRST provider that resolves — even with an
// empty array — wins. Every configured provider failing, or none configured, falls through to [].
// NEVER throws: any error escaping the loop (including the settings read) degrades to [].
export async function resolveWebSearch(
  loadSettings: () => Promise<{ webSearchEnabled: boolean }>,
  order: string[],
  providers: SearchProvider[],
  env: Record<string, string | undefined>,
  query: string,
  limit: number,
): Promise<SearchResult[]> {
  try {
    const settings = await loadSettings();
    if (!settings.webSearchEnabled) return [];

    for (const name of order) {
      const provider = providers.find((p) => p.name === name);
      if (!provider) continue; // unknown provider name in the order — ignore

      const apiKey = env[provider.envKey];
      if (!apiKey) continue; // not configured — skip without attempting or logging

      // INNER try/catch per provider: a single provider's failure (quota/429/402, auth, network,
      // timeout) must not abort the chain — log and fall through to the next candidate instead.
      try {
        return await provider.search(query, apiKey, limit);
      } catch (e) {
        console.warn(`[search] fournisseur « ${name} » indisponible, essai du suivant : ${(e as Error).message}`);
      }
    }

    return []; // chain exhausted: nothing configured, or every configured provider failed
  } catch (e) {
    console.warn(`[search] la recherche web a échoué : ${(e as Error).message}`);
    return [];
  }
}

// Pluggable, OPTIONAL web-search provider CHAIN used to augment a story's sources with external
// coverage (SP4 Task 6 wires the actual fetch/extract of the result URLs via the SSRF-safe
// extract chain — this module only returns search hits, never fetches the pages themselves).
//
// Off by default: returns [] unless pipeline_settings.web_search_enabled (SP1, admin-configured)
// is true AND at least one provider in `searchOrder` (pipeline-config, env SEARCH_ORDER, default
// "brave,exa") has its API key set. Providers are tried IN ORDER: a provider missing its key is
// skipped (not even attempted); a provider that throws (quota/429/402, auth, network, timeout) is
// logged and skipped so the NEXT provider is tried; the FIRST provider that resolves — even with
// an empty array — wins and its result is returned immediately. If every configured provider
// throws, or none is configured, the chain falls through to [] (corpus-only degrade, no error).
//
// NEVER throws — like the pipeline's other best-effort providers (lib/embeddings, lib/extract),
// any error escaping the chain (including the settings read itself) is logged (French,
// "[search]"-prefixed) and swallowed so a flaky/rate-limited search API can never fail a pipeline
// run. Thin wrapper over resolveWebSearch() with the real dependencies wired in.
export async function searchRelated(query: string, opts?: { limit?: number }): Promise<SearchResult[]> {
  const limit = Math.min(Math.max(opts?.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  return resolveWebSearch(getPipelineSettings, getPipelineConfig().searchOrder, PROVIDERS, process.env, query, limit);
}

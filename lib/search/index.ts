import { getPipelineSettings } from "@/lib/queries/settings";
import { getPipelineConfig } from "@/lib/config/pipeline-config";
import { braveSearch } from "./brave";
import { exaSearch } from "./exa";

export type SearchResult = { title: string; url: string; snippet: string };

const DEFAULT_LIMIT = 3;
const MAX_LIMIT = 10; // hard cap regardless of what a caller asks for

// Registry of known web-search providers, keyed by the name used in pipeline-config's
// `searchOrder` (env SEARCH_ORDER, default "brave,exa"). Each entry pairs the env var that gates
// it with its thin, throwing `*Search` implementation (mirrors lib/search/brave.ts /
// lib/search/exa.ts). A name in searchOrder that isn't a key here is silently ignored — lets an
// operator list a not-yet-built provider without breaking the chain.
const PROVIDERS: Record<string, { envKey: string; run: (query: string, apiKey: string, limit: number) => Promise<SearchResult[]> }> = {
  brave: { envKey: "BRAVE_SEARCH_API_KEY", run: braveSearch },
  exa: { envKey: "EXA_API_KEY", run: exaSearch },
};

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
// run.
export async function searchRelated(query: string, opts?: { limit?: number }): Promise<SearchResult[]> {
  const limit = Math.min(Math.max(opts?.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);

  // ONE try/catch around the ENTIRE body — the settings read included. getPipelineSettings() hits
  // Neon (and may run a seed-insert on first use), so a transient DB blip can reject here just as
  // easily as a provider's fetch can; both must degrade to [] rather than propagate, since SP4
  // Task 6 calls this from inside the per-story runner loop where an unhandled rejection has real
  // blast radius. (run.ts / scheduler.ts likewise treat getPipelineSettings() as throwable.)
  try {
    const settings = await getPipelineSettings();
    if (!settings.webSearchEnabled) return [];

    for (const name of getPipelineConfig().searchOrder) {
      const provider = PROVIDERS[name];
      if (!provider) continue; // unknown provider name in SEARCH_ORDER — ignore

      const apiKey = process.env[provider.envKey];
      if (!apiKey) continue; // not configured — skip without attempting or logging

      // INNER try/catch per provider: a single provider's failure must not abort the chain — log
      // and fall through to the next candidate instead.
      try {
        return await provider.run(query, apiKey, limit);
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

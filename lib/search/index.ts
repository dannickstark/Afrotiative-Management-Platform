import { getPipelineSettings } from "@/lib/queries/settings";
import { braveSearch } from "./brave";

export type SearchResult = { title: string; url: string; snippet: string };

const DEFAULT_LIMIT = 3;
const MAX_LIMIT = 10; // hard cap regardless of what a caller asks for

// Pluggable, OPTIONAL web-search provider used to augment a story's sources with external
// coverage (SP4 Task 6 wires the actual fetch/extract of the result URLs via the SSRF-safe
// extract chain — this module only returns search hits, never fetches the pages themselves).
//
// Off by default: returns [] unless pipeline_settings.web_search_enabled (SP1, admin-configured)
// is true AND BRAVE_SEARCH_API_KEY is set. Currently a single provider (Brave); a future provider
// would extend the same "return [] rather than throw" contract below.
//
// NEVER throws — like the pipeline's other best-effort providers (lib/embeddings, lib/extract),
// any error from the underlying provider is logged (French, "[search]"-prefixed) and swallowed so
// a flaky/rate-limited search API can never fail a pipeline run.
export async function searchRelated(query: string, opts?: { limit?: number }): Promise<SearchResult[]> {
  const limit = Math.min(Math.max(opts?.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);

  // ONE try/catch around the ENTIRE body — the settings read included. getPipelineSettings() hits
  // Neon (and may run a seed-insert on first use), so a transient DB blip can reject here just as
  // easily as braveSearch's fetch can; both must degrade to [] rather than propagate, since SP4
  // Task 6 calls this from inside the per-story runner loop where an unhandled rejection has real
  // blast radius. (run.ts / scheduler.ts likewise treat getPipelineSettings() as throwable.)
  try {
    const settings = await getPipelineSettings();
    if (!settings.webSearchEnabled) return [];

    const apiKey = process.env.BRAVE_SEARCH_API_KEY;
    if (!apiKey) return [];

    return await braveSearch(query, apiKey, limit);
  } catch (e) {
    console.warn(`[search] la recherche web (Brave) a échoué : ${(e as Error).message}`);
    return [];
  }
}

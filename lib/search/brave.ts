import type { SearchResult } from "./index";

type BraveWebResult = { title?: unknown; url?: unknown; description?: unknown };
type BraveSearchResponse = { web?: { results?: BraveWebResult[] } };

// PURE — no I/O. Maps a raw Brave Web Search API JSON body (`{ web: { results: [...] } }`) to our
// SearchResult[] shape. Split out from braveSearch() below specifically so it can be unit-tested
// (tests/search.test.ts) with a canned fixture, with no network call and no fetch mocking needed.
// Defensive about shape: Brave is an external API, so entries missing a string title/url are
// skipped rather than propagated as garbage results.
export function parseBraveResponse(json: unknown, limit: number): SearchResult[] {
  const results = (json as BraveSearchResponse | null | undefined)?.web?.results ?? [];
  const out: SearchResult[] = [];
  for (const r of results) {
    if (typeof r?.title !== "string" || typeof r?.url !== "string") continue;
    out.push({ title: r.title, url: r.url, snippet: typeof r.description === "string" ? r.description : "" });
    if (out.length >= limit) break;
  }
  return out;
}

// Minimal fetch against the Brave Web Search API. Throws on a non-2xx response or network error —
// the caller (lib/search/index.ts's searchRelated) is responsible for catching, logging a French
// warning, and returning [] (this module stays a thin, throwing provider like lib/extract/jina.ts
// and lib/embeddings/jina.ts).
export async function braveSearch(query: string, apiKey: string, limit: number): Promise<SearchResult[]> {
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${limit}`;
  const res = await fetch(url, {
    headers: { "X-Subscription-Token": apiKey, Accept: "application/json" },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`Brave Search a répondu ${res.status}`);
  const json = await res.json();
  return parseBraveResponse(json, limit);
}

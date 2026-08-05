import type { SearchResult } from "./index";

type ExaResult = { title?: unknown; url?: unknown; highlights?: unknown; summary?: unknown; text?: unknown };
type ExaSearchResponse = { results?: ExaResult[] };

// PURE — no I/O. Maps a raw Exa Search API JSON body (`{ results: [...] }`, per
// https://docs.exa.ai/reference/search) to our SearchResult[] shape. Split out from exaSearch()
// below specifically so it can be unit-tested (tests/search.test.ts) with a canned fixture, with
// no network call and no fetch mocking needed — mirrors lib/search/brave.ts's
// parseBraveResponse(). Defensive about shape: Exa is an external API, so entries missing a
// string title/url are skipped rather than propagated as garbage results.
//
// Snippet precedence: highlights[0] (short, query-focused extract) ?? summary (LLM-generated
// summary) ?? a slice of the full text (last-resort) ?? "" (no content field requested/returned).
export function parseExaResponse(json: unknown, limit: number): SearchResult[] {
  const results = (json as ExaSearchResponse | null | undefined)?.results ?? [];
  const out: SearchResult[] = [];
  for (const r of results) {
    if (typeof r?.title !== "string" || typeof r?.url !== "string") continue;
    const highlight = Array.isArray(r.highlights) && typeof r.highlights[0] === "string" ? r.highlights[0] : undefined;
    const summary = typeof r.summary === "string" && r.summary ? r.summary : undefined;
    const text = typeof r.text === "string" && r.text ? r.text.slice(0, 300) : undefined;
    out.push({ title: r.title, url: r.url, snippet: highlight || summary || text || "" });
    if (out.length >= limit) break;
  }
  return out;
}

// Minimal fetch against the Exa Search API (POST https://api.exa.ai/search, auth via the
// `x-api-key` header — confirmed against https://docs.exa.ai/reference/search). Throws on a
// non-2xx response or network error — the caller (lib/search/index.ts's searchRelated) is
// responsible for catching, logging a French warning, and falling through to the next provider
// (this module stays a thin, throwing provider like lib/search/brave.ts and
// lib/extract/jina.ts).
export async function exaSearch(query: string, apiKey: string, limit: number): Promise<SearchResult[]> {
  const res = await fetch("https://api.exa.ai/search", {
    method: "POST",
    headers: { "x-api-key": apiKey, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      query,
      numResults: limit,
      // Ask for highlights (short, query-focused extracts) AND summary/text so
      // parseExaResponse() has a fallback chain even if Exa omits highlights for a given result.
      contents: { highlights: true, summary: true, text: { maxCharacters: 300 } },
    }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`Exa Search a répondu ${res.status}`);
  const json = await res.json();
  return parseExaResponse(json, limit);
}

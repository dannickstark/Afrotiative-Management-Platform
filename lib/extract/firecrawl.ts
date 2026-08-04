import Firecrawl from "@mendable/firecrawl-js";
import type { Extracted } from "./index";

// NOTE on the installed SDK (@mendable/firecrawl-js@4.32.0): the default export is the
// v2 `Firecrawl` client class (constructor takes `{ apiKey }` or an API key string).
// `scrape(url, options)` returns a flat `Document` — `doc.markdown`, `doc.metadata?.title`,
// and (when the "images" format is requested) `doc.images: string[]` — there is NO
// `.data` wrapper as in older/representative snippets. On a non-2xx response or quota
// error the SDK throws an `SdkError` (a plain `Error` subclass), so it naturally falls
// through the extraction chain via the caller's try/catch — no special-casing needed here.
export async function firecrawlExtract(url: string, apiKey: string): Promise<Extracted> {
  const fc = new Firecrawl({ apiKey });
  const doc = await fc.scrape(url, { formats: ["markdown", "images"] });
  const text = doc?.markdown ?? "";
  if (!text || text.trim().length < 100) throw new Error("Firecrawl: contenu trop court");
  return {
    title: doc?.metadata?.title ?? "",
    text: text.slice(0, 20000),
    images: doc?.images ?? [],
    via: "firecrawl",
  };
}

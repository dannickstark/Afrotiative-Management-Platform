import { getPipelineConfig } from "@/lib/config/pipeline-config";
import { jinaExtract } from "./jina";
import { firecrawlExtract } from "./firecrawl";
import { crawl4aiExtract, crawl4aiImages } from "./crawl4ai";
import { readabilityExtract } from "./readability";
import { extractImages } from "./images";
import { isSafePublicHttpUrl } from "@/lib/url-guard";

export type Extracted = { title: string; text: string; images: string[]; via: string };
export type ExtractResult = Extracted & { attempts: { provider: string; ok: boolean; reason?: string }[] };

export type ExtractOptions = {
  // SP4 Task 6b (web-search augmentation) — web-search result URLs are UNTRUSTED (arbitrary
  // internet, picked by a third-party search API, never a feed we deliberately chose to follow).
  // externalOnly restricts the chain to providers that fetch from THEIR OWN infrastructure (jina
  // reader, firecrawl, crawl4ai — the last runs on our own separate Crawl4AI infra, not our Next
  // server) — there is no SSRF surface from OUR server regardless of the URL. The direct-`fetch(url)`
  // readability provider is skipped entirely, and so is the raw-fetch image backfill (it's also a
  // direct fetch of the untrusted URL; see backfillCandidateImages below, which still allows
  // Crawl4AI for images even in externalOnly mode for the same reason). If none of jina, firecrawl,
  // or crawl4ai is configured, this returns `via:"none"` rather than ever falling back to a direct
  // fetch.
  externalOnly?: boolean;
};

export async function extract(url: string, opts: ExtractOptions = {}): Promise<ExtractResult> {
  const cfg = getPipelineConfig();
  const attempts: ExtractResult["attempts"] = [];
  const order = opts.externalOnly
    ? cfg.extractOrder.filter((name) => name === "jina" || name === "firecrawl" || name === "crawl4ai")
    : cfg.extractOrder;

  for (const name of order) {
    try {
      let r: Extracted;
      if (name === "jina") {
        if (!cfg.jina) {
          attempts.push({ provider: name, ok: false, reason: "pas de clé Jina" });
          continue;
        }
        r = await jinaExtract(url, cfg.jina.apiKey);
      } else if (name === "firecrawl") {
        if (!cfg.firecrawl) {
          attempts.push({ provider: name, ok: false, reason: "pas de clé Firecrawl" });
          continue;
        }
        r = await firecrawlExtract(url, cfg.firecrawl.apiKey);
      } else if (name === "crawl4ai") {
        if (!cfg.crawl4ai) {
          attempts.push({ provider: name, ok: false, reason: "pas de config Crawl4AI" });
          continue;
        }
        r = await crawl4aiExtract(url, cfg.crawl4ai);
      } else if (name === "readability") {
        r = await readabilityExtract(url);
      } else {
        continue;
      }
      attempts.push({ provider: name, ok: true });
      // Jina always returns no images; Firecrawl/Crawl4AI usually do but may come back empty too —
      // in either case, backfill candidate images (see backfillCandidateImages below, which tries
      // a raw fetch for trusted feed URLs and Crawl4AI for both feed and untrusted web URLs).
      if (r.images.length === 0 && name !== "readability") r.images = await backfillCandidateImages(url, !!opts.externalOnly);
      return { ...r, attempts };
    } catch (e) {
      attempts.push({ provider: name, ok: false, reason: (e as Error).message });
    }
  }

  return { title: "", text: "", images: [], via: "none", attempts };
}

// Thin, explicit wrapper around extract(url, { externalOnly: true }) — used by the pipeline
// runner (lib/pipeline/run.ts) for web-search result URLs ONLY. Named as its own function (rather
// than call sites passing the option inline) so it reads as a deliberate SSRF-safety decision at
// every call site, not an easily-overlooked options bag.
export function extractExternal(url: string): Promise<ExtractResult> {
  return extract(url, { externalOnly: true });
}

// Whether at least one external-fetching provider (jina reader, firecrawl, or crawl4ai — providers
// that fetch from THEIR OWN infrastructure, never ours) is BOTH configured (has a key/creds) AND
// enabled in the extraction order. The runner checks this BEFORE even calling searchRelated(): if
// no external provider will actually run, extractExternal() would just return `via:"none"` for
// every single hit (a wasted Brave call + per-hit no-op), so this lets the caller skip web
// augmentation entirely and log ONE clear reason instead. Requiring extractOrder membership — not
// just the key — matters because keys can be set while EXTRACT_ORDER deliberately excludes those
// providers (e.g. an operator pinning EXTRACT_ORDER="readability"): extractExternal() filters the
// order to jina/firecrawl/crawl4ai, so a provider absent from the order never runs even with a key
// present.
export function hasExternalExtractor(): boolean {
  const cfg = getPipelineConfig();
  const jinaReady = !!cfg.jina && cfg.extractOrder.includes("jina");
  const firecrawlReady = !!cfg.firecrawl && cfg.extractOrder.includes("firecrawl");
  const crawl4aiReady = !!cfg.crawl4ai && cfg.extractOrder.includes("crawl4ai");
  return jinaReady || firecrawlReady || crawl4aiReady;
}

// Two image-backfill strategies, tried in order:
//  1. Raw fetch of `url` — feed-URLs ONLY (`externalOnly === false`). This is a direct fetch of
//     `url` from OUR server, so it's exactly the SSRF surface externalOnly exists to avoid; never
//     called for untrusted web-search URLs. It's also prone to failing outright on JS-rendered or
//     bot-blocked pages, since it's a plain unauthenticated GET with no rendering.
//  2. Crawl4AI — safe for BOTH feed and untrusted web URLs, because Crawl4AI fetches from its own
//     separate infra (a hosted Railway box), never from our server directly. This is what lets
//     web-search sources get images at all (they skip strategy 1 entirely), and gives feed sources
//     a second chance when the raw fetch above is blocked or renders nothing useful.
async function backfillCandidateImages(url: string, externalOnly: boolean): Promise<string[]> {
  const cfg = getPipelineConfig();
  if (!externalOnly) {
    const raw = await backfillImages(url);
    if (raw.length) return raw;
  }
  if (cfg.crawl4ai) return await crawl4aiImages(url, cfg.crawl4ai);
  return [];
}

async function backfillImages(url: string): Promise<string[]> {
  // SSRF guard: same reasoning as the externalOnly comment above — this fetches `url` directly,
  // and on the ingest path `url` is feed-publisher-supplied, not operator-vetted.
  if (!isSafePublicHttpUrl(url)) return [];
  try {
    const res = await fetch(url, {
      headers: { "user-agent": "AfrotiativeBot/1.0" },
      signal: AbortSignal.timeout(10000),
    });
    return extractImages(await res.text(), url);
  } catch {
    return [];
  }
}

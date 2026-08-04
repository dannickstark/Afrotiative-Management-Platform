import { getPipelineConfig } from "@/lib/config/pipeline-config";
import { jinaExtract } from "./jina";
import { firecrawlExtract } from "./firecrawl";
import { readabilityExtract } from "./readability";
import { extractImages } from "./images";

export type Extracted = { title: string; text: string; images: string[]; via: string };
export type ExtractResult = Extracted & { attempts: { provider: string; ok: boolean; reason?: string }[] };

export async function extract(url: string): Promise<ExtractResult> {
  const cfg = getPipelineConfig();
  const attempts: ExtractResult["attempts"] = [];

  for (const name of cfg.extractOrder) {
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
      } else if (name === "readability") {
        r = await readabilityExtract(url);
      } else {
        continue;
      }
      attempts.push({ provider: name, ok: true });
      // Jina always returns no images; Firecrawl usually does but may come back empty too —
      // in either case, backfill candidate images from a best-effort raw fetch of the page.
      if (r.images.length === 0 && name !== "readability") r.images = await backfillImages(url);
      return { ...r, attempts };
    } catch (e) {
      attempts.push({ provider: name, ok: false, reason: (e as Error).message });
    }
  }

  return { title: "", text: "", images: [], via: "none", attempts };
}

async function backfillImages(url: string): Promise<string[]> {
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

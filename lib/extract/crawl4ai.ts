import type { Extracted } from "./index";

type Crawl4aiImage = { src?: string | null; width?: number | null; score?: number };
type Crawl4aiResult = {
  success?: boolean;
  metadata?: { title?: string; description?: string; "og:image"?: string };
  markdown?: { raw_markdown?: string; fit_markdown?: string };
  media?: { images?: Crawl4aiImage[] };
};
type Crawl4aiResponse = { success?: boolean; results?: Crawl4aiResult[] };

export async function crawl4aiExtract(
  url: string,
  creds: { apiUrl: string; apiToken: string },
): Promise<Extracted> {
  const res = await fetch(`${creds.apiUrl}/crawl`, {
    method: "POST",
    headers: { Authorization: `Bearer ${creds.apiToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ urls: [url] }),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`Crawl4AI a répondu ${res.status}`);

  const json = (await res.json()) as Crawl4aiResponse;
  const r = json.results?.[0];
  if (!r || r.success === false) throw new Error("Crawl4AI: aucun résultat");

  const text = ((r.markdown?.fit_markdown || r.markdown?.raw_markdown) ?? "").slice(0, 20000);
  if (text.trim().length < 100) throw new Error("Crawl4AI: contenu trop court");

  const title = r.metadata?.title ?? "";

  const ogImage = r.metadata?.["og:image"];
  const candidates: { src: string | null | undefined; width?: number | null }[] = [
    { src: typeof ogImage === "string" && ogImage ? ogImage : null, width: null },
    ...[...(r.media?.images ?? [])]
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
      .map((img) => ({ src: img.src, width: img.width })),
  ];

  const out = new Set<string>();
  for (const { src, width } of candidates) {
    if (!src) continue;
    if (!(width == null || width === 0 || width >= 200)) continue;

    const withProtocol = src.startsWith("//") ? `https:${src}` : src;
    let abs: string;
    try {
      abs = new URL(withProtocol, url).href;
    } catch {
      continue;
    }
    if (!/^https?:$/i.test(new URL(abs).protocol)) continue;
    if (/\.svg($|\?)/i.test(abs)) continue;

    out.add(abs);
  }

  return { title, text, images: [...out].slice(0, 8), via: "crawl4ai" };
}

// Never-throw image-backfill helper — mirrors the chain's other image fallbacks. Safe to call on
// untrusted web URLs since it only ever hits OUR Crawl4AI instance, never the target URL directly.
export async function crawl4aiImages(
  url: string,
  creds: { apiUrl: string; apiToken: string },
): Promise<string[]> {
  try {
    const e = await crawl4aiExtract(url, creds);
    return e.images;
  } catch {
    return [];
  }
}

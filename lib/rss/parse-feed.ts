import Parser from "rss-parser";
import { createHash } from "node:crypto";

export type RawItem = { guid: string; url: string; title: string; contentSnippet: string; isoDate: string | null; contentHash: string };

export function normalizeUrl(u: string): string {
  try {
    const url = new URL(u);
    url.hash = "";
    url.host = url.host.toLowerCase();
    [...url.searchParams.keys()].forEach((k) => { if (/^utm_|^fbclid$|^gclid$/i.test(k)) url.searchParams.delete(k); });
    let s = url.toString();
    s = s.replace(/\/(\?|$)/, "$1").replace(/\?$/, "");
    return s;
  } catch { return u; }
}
export function contentHash(title: string, body: string): string {
  return createHash("sha256").update(`${title.trim().toLowerCase()}\n${body.trim().toLowerCase()}`).digest("hex");
}

const parser = new Parser({ timeout: 15000, headers: { "user-agent": "AfrotiativeBot/1.0" } });

export async function parseFeed(feedUrl: string): Promise<RawItem[]> {
  const feed = await parser.parseURL(feedUrl);
  return (feed.items ?? []).map((it) => {
    const url = normalizeUrl(it.link ?? "");
    const title = it.title ?? "";
    const body = it.contentSnippet ?? it.content ?? "";
    return { guid: it.guid ?? url, url, title, contentSnippet: body, isoDate: it.isoDate ?? null, contentHash: contentHash(title, body) };
  }).filter((r) => r.url);
}

import { db, rawItems } from "@/db";
import { eq, or } from "drizzle-orm";
import type { RawItem } from "@/lib/rss/parse-feed";

export function dedupKeys(item: RawItem): [string, string, string] {
  return [item.guid, item.url, item.contentHash];
}

export async function isSeen(feedId: string, item: RawItem): Promise<boolean> {
  const [g, u, h] = dedupKeys(item);
  const hit = await db.select({ id: rawItems.id }).from(rawItems)
    .where(or(eq(rawItems.guid, g), eq(rawItems.url, u), eq(rawItems.contentHash, h))).limit(1);
  return hit.length > 0;
}

export async function recordRawItem(feedId: string, item: RawItem): Promise<string> {
  const [row] = await db.insert(rawItems).values({
    feedId, guid: item.guid, url: item.url, contentHash: item.contentHash,
    rawTitle: item.title, rawBody: item.contentSnippet,
  }).returning({ id: rawItems.id });
  return row.id;
}

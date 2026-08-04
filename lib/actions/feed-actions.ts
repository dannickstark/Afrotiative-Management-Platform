"use server";
import { db, feeds } from "@/db";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import { requirePermission } from "@/lib/rbac";
import { feedSchema, type FeedInput } from "@/lib/validation";
import { isSafePublicHttpUrl } from "@/lib/url-guard";

// feedSchema/validateFeedInput live in lib/validation.ts, not here — see the comment there for
// why (a file-level "use server" module may only export async functions).

async function guard() {
  const user = await requireUser();
  requirePermission(user.role, "feed", "manage");
  return user;
}

export async function createFeed(input: FeedInput) {
  await guard();
  const data = feedSchema.parse(input);
  await db.insert(feeds).values({ name: data.name, feedUrl: data.feedUrl, siteUrl: data.siteUrl || null, active: data.active });
  revalidatePath("/settings/feeds");
}

export async function updateFeed(id: string, input: FeedInput) {
  await guard();
  const data = feedSchema.parse(input);
  await db.update(feeds).set({ name: data.name, feedUrl: data.feedUrl, siteUrl: data.siteUrl || null, active: data.active }).where(eq(feeds.id, id));
  revalidatePath("/settings/feeds");
}

export async function toggleFeed(id: string, active: boolean) {
  await guard();
  await db.update(feeds).set({ active }).where(eq(feeds.id, id));
  revalidatePath("/settings/feeds");
}

export async function deleteFeed(id: string) {
  await guard();
  await db.delete(feeds).where(eq(feeds.id, id));
  revalidatePath("/settings/feeds");
}

// Lets an editor validate a feed BEFORE activating it: parses the URL through the same
// rss-parser path the pipeline uses, without writing anything to feeds/raw_items.
//
// url is admin-entered but fetched server-side with the app's own credentials/network access —
// an authenticated SSRF surface (an editor could point it at localhost/an internal service/cloud
// metadata endpoint). Reject non-http(s) schemes and private/loopback/link-local hosts BEFORE
// calling parseFeed (which fetches it), same guard as the WordPress featured-image fetch.
export async function testFeed(url: string) {
  await guard();
  if (!isSafePublicHttpUrl(url)) {
    return { ok: false as const, message: "URL non autorisée." };
  }
  try {
    const { parseFeed } = await import("@/lib/rss/parse-feed");
    const items = await parseFeed(url);
    return { ok: true as const, count: items.length, message: `${items.length} article(s) trouvé(s).` };
  } catch (e) {
    return { ok: false as const, message: `Flux illisible : ${(e as Error).message}` };
  }
}

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { db, articles, wpCategories, distributions } from "@/db";
import { eq, inArray } from "drizzle-orm";
import { getPublishedArticles, PUBLISHED_PAGE_SIZE } from "@/lib/queries/published";

const envSnap: Record<string, string | undefined> = {};
const WP_ENV = { WP_BASE_URL: "https://wp.example.com", WP_USER: "u", WP_APP_PASSWORD: "p" };
const catIds: string[] = [];
const articleIds: string[] = [];

async function mkArticle(o: { title: string; catIdx: 0 | 1; ai: boolean; publishedAt: Date | null; status?: string; wpId?: string }) {
  const [a] = await db.insert(articles).values({
    title: o.title, bodyHtml: "<p>x</p>", status: (o.status ?? "published") as never,
    categoryId: catIds[o.catIdx], aiAuthor: o.ai, publishedAt: o.publishedAt,
  }).returning({ id: articles.id });
  articleIds.push(a.id);
  if (o.wpId) await db.insert(distributions).values({ articleId: a.id, channel: "wordpress", status: "sent", externalId: o.wpId, at: new Date() });
  return a.id;
}

describe("getPublishedArticles", () => {
  let recentId = "";
  beforeAll(async () => {
    for (const k of Object.keys(WP_ENV)) { envSnap[k] = process.env[k]; process.env[k] = (WP_ENV as Record<string,string>)[k]; }
    for (const name of ["PubTest Économie", "PubTest Sport"]) {
      const [c] = await db.insert(wpCategories).values({ name, slug: name.toLowerCase().replace(/\W+/g, "-") }).returning({ id: wpCategories.id });
      catIds.push(c.id);
    }
    // 3 published (distinct dates/cats/authors), 1 approved-never-published, 1 published-then-unpublished (approved + a wp dist).
    recentId = await mkArticle({ title: "PubTest BRVM record", catIdx: 0, ai: true, publishedAt: new Date("2026-08-06T10:00:00Z"), wpId: "501" });
    await mkArticle({ title: "PubTest Ancienne dépêche", catIdx: 1, ai: false, publishedAt: new Date("2026-08-01T10:00:00Z"), wpId: "502" });
    await mkArticle({ title: "PubTest Milieu", catIdx: 0, ai: true, publishedAt: new Date("2026-08-04T10:00:00Z"), wpId: "503" });
    await mkArticle({ title: "PubTest Brouillon", catIdx: 0, ai: true, publishedAt: null, status: "approved" });
    await mkArticle({ title: "PubTest Dépubliée", catIdx: 0, ai: true, publishedAt: null, status: "approved", wpId: "599" });
  });
  afterAll(async () => {
    if (articleIds.length) await db.delete(articles).where(inArray(articles.id, articleIds)); // cascades distributions
    if (catIds.length) await db.delete(wpCategories).where(inArray(wpCategories.id, catIds));
    for (const k of Object.keys(WP_ENV)) { if (envSnap[k] === undefined) delete process.env[k]; else process.env[k] = envSnap[k]; }
  });

  const base = { search: undefined, categoryId: undefined, from: undefined, to: undefined, author: undefined, page: 1, pageSize: 50 } as const;
  const mine = (p: Awaited<ReturnType<typeof getPublishedArticles>>) => p.rows.filter((r) => r.title.startsWith("PubTest"));

  it("returns only status='published', newest first, with wpUrl from the WP distribution", async () => {
    const p = await getPublishedArticles({ ...base });
    const rows = mine(p);
    expect(rows.map((r) => r.title)).toEqual(["PubTest BRVM record", "PubTest Milieu", "PubTest Ancienne dépêche"]);
    expect(rows.find((r) => r.id === recentId)!.wpUrl).toBe("https://wp.example.com/?p=501");
    // excluded: the approved-never-published and the unpublished one
    expect(rows.some((r) => r.title === "PubTest Brouillon" || r.title === "PubTest Dépubliée")).toBe(false);
  });
  it("filters by category, author, title search, and an inclusive end-of-day date range", async () => {
    expect(mine(await getPublishedArticles({ ...base, categoryId: catIds[1] })).map((r) => r.title)).toEqual(["PubTest Ancienne dépêche"]);
    expect(mine(await getPublishedArticles({ ...base, author: "human" })).map((r) => r.title)).toEqual(["PubTest Ancienne dépêche"]);
    expect(mine(await getPublishedArticles({ ...base, search: "record" })).map((r) => r.title)).toEqual(["PubTest BRVM record"]);
    // to = 2026-08-04 must INCLUDE an article published that day (end-of-day bound)
    const ranged = mine(await getPublishedArticles({ ...base, from: new Date("2026-08-02"), to: new Date("2026-08-04") }));
    expect(ranged.map((r) => r.title)).toEqual(["PubTest Milieu"]);
  });
  it("paginates: total counts all matches, rows are the page slice", async () => {
    const p1 = await getPublishedArticles({ ...base, pageSize: 2, page: 1 });
    expect(p1.total).toBeGreaterThanOrEqual(3);
    expect(p1.pageCount).toBeGreaterThanOrEqual(2);
    expect(PUBLISHED_PAGE_SIZE).toBe(25);
  });
});

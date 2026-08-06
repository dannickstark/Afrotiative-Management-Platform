import { db, articles, wpCategories, distributions } from "@/db";
import { and, eq, ilike, gte, lt, desc } from "drizzle-orm";
import { getWpConfig } from "@/lib/wp/config";
import { wpPostUrl } from "@/lib/wp/post-url";

export type PublishedFilters = {
  search?: string; categoryId?: string; from?: Date; to?: Date;
  author?: "ai" | "human"; page: number; pageSize: number;
};
export type PublishedRow = {
  id: string; title: string; categoryName: string | null;
  publishedAt: Date; imageUrl: string | null; aiAuthor: boolean;
  wpUrl: string | null; // live WP link, computed server-side (see getPublishedArticles)
};
export type PublishedPage = { rows: PublishedRow[]; total: number; page: number; pageCount: number };

export const PUBLISHED_PAGE_SIZE = 25;

// Pure: map raw URL search params → typed filters (no DB/DOM). Invalid dates / unknown author /
// blank strings are dropped; page clamps to >= 1; pageSize is fixed. Mirrors filterRuns/resolveRunParams.
export function parsePublishedSearchParams(
  sp: Record<string, string | string[] | undefined>,
): PublishedFilters {
  const str = (v: string | string[] | undefined): string | undefined => {
    const s = Array.isArray(v) ? v[0] : v;
    return s && s.trim() ? s.trim() : undefined;
  };
  const date = (v: string | string[] | undefined): Date | undefined => {
    const s = str(v);
    if (!s) return undefined;
    const t = Date.parse(s);
    return Number.isNaN(t) ? undefined : new Date(t);
  };
  const pageRaw = Number(str(sp.page));
  const page = Number.isFinite(pageRaw) && pageRaw >= 1 ? Math.floor(pageRaw) : 1;
  const authorRaw = str(sp.author);
  const author = authorRaw === "ai" || authorRaw === "human" ? authorRaw : undefined;
  return {
    search: str(sp.q), categoryId: str(sp.cat), from: date(sp.from), to: date(sp.to),
    author, page, pageSize: PUBLISHED_PAGE_SIZE,
  };
}

export async function getPublishedArticles(f: PublishedFilters): Promise<PublishedPage> {
  const conds = [eq(articles.status, "published")];
  if (f.search) conds.push(ilike(articles.title, `%${f.search}%`));
  if (f.categoryId) conds.push(eq(articles.categoryId, f.categoryId));
  if (f.from) conds.push(gte(articles.publishedAt, f.from));
  if (f.to) {
    // Inclusive end-of-day: a date input gives midnight, so compare < to + 1 day to include that day.
    const end = new Date(f.to); end.setDate(end.getDate() + 1);
    conds.push(lt(articles.publishedAt, end));
  }
  if (f.author) conds.push(eq(articles.aiAuthor, f.author === "ai"));
  const where = and(...conds);

  const total = await db.$count(articles, where);
  const pageCount = Math.max(1, Math.ceil(total / f.pageSize));
  const page = Math.min(Math.max(1, f.page), pageCount); // clamp into range so an over-large ?page= still returns the last page

  // At most one wordpress distribution per article (upsertDistribution keeps a single row per
  // article+channel), so this leftJoin never multiplies rows.
  const rows = await db.select({
    id: articles.id, title: articles.title, categoryName: wpCategories.name,
    publishedAt: articles.publishedAt, imageUrl: articles.featuredImageUrl, aiAuthor: articles.aiAuthor,
    wpPostId: distributions.externalId,
  }).from(articles)
    .leftJoin(wpCategories, eq(articles.categoryId, wpCategories.id))
    .leftJoin(distributions, and(eq(distributions.articleId, articles.id), eq(distributions.channel, "wordpress")))
    .where(where)
    .orderBy(desc(articles.publishedAt))
    .limit(f.pageSize)
    .offset((page - 1) * f.pageSize);

  const baseUrl = getWpConfig()?.baseUrl ?? null;
  return {
    rows: rows.map((r) => ({
      id: r.id, title: r.title, categoryName: r.categoryName,
      publishedAt: r.publishedAt!, // status='published' guarantees publishedAt is set
      imageUrl: r.imageUrl, aiAuthor: r.aiAuthor, wpUrl: wpPostUrl(baseUrl, r.wpPostId),
    })),
    total, page, pageCount,
  };
}

import { db, articles, articleSources, wpCategories } from "@/db";
import { eq, sql } from "drizzle-orm";
import { sortMissingFields, type MissingField } from "@/lib/pipeline/completeness";

export type QueueRow = {
  id: string; title: string; categoryName: string | null; sourceCount: number;
  imageUrl: string | null; generatedAt: Date | null; status: string; low: boolean;
  // 0-100 from lib/pipeline/score.ts; null until SP4 Task 6 wires scoring into stageItem.
  score: number | null;
  missingFields: MissingField[];
};

export async function getQueue(): Promise<QueueRow[]> {
  const rows = await db.select({
    id: articles.id, title: articles.title, categoryName: wpCategories.name,
    imageUrl: articles.featuredImageUrl, generatedAt: articles.generatedAt,
    status: articles.status, confidenceFlags: articles.confidenceFlags, score: articles.score,
    missingFields: articles.missingFields,
    sourceCount: sql<number>`(select count(*) from ${articleSources} s where s.article_id = ${articles.id})`,
  }).from(articles).leftJoin(wpCategories, eq(articles.categoryId, wpCategories.id))
    .orderBy(articles.generatedAt); // oldest first

  return rows.map((r) => ({
    ...r, sourceCount: Number(r.sourceCount),
    low: Boolean(r.confidenceFlags?.categoryUncertain || r.confidenceFlags?.imageMissing || r.confidenceFlags?.clusterUncertain),
    missingFields: sortMissingFields((r.missingFields ?? []) as MissingField[]),
  }));
}

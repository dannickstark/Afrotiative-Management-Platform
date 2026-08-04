import { db, articles, articleSources, articleTags, articleRevisions, wpCategories, user } from "@/db";
import { eq, asc, desc } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

export async function getArticle(id: string) {
  const locker = alias(user, "locker");
  const [a] = await db.select({
    article: articles, categoryName: wpCategories.name, lockerName: locker.name,
  }).from(articles)
    .leftJoin(wpCategories, eq(articles.categoryId, wpCategories.id))
    .leftJoin(locker, eq(articles.lockedBy, locker.id))
    .where(eq(articles.id, id));
  if (!a) return null;
  const sources = await db.select().from(articleSources).where(eq(articleSources.articleId, id));
  const tags = await db.select().from(articleTags).where(eq(articleTags.articleId, id));
  const revisions = await db.select().from(articleRevisions).where(eq(articleRevisions.articleId, id)).orderBy(desc(articleRevisions.at));
  const categories = await db.select().from(wpCategories).orderBy(asc(wpCategories.name));
  return { ...a.article, categoryName: a.categoryName, lockerName: a.lockerName, sources, tags, revisions, categories };
}

export type ArticleDetail = NonNullable<Awaited<ReturnType<typeof getArticle>>>;

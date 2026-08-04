import { db, articles, articleSources, articleTags, articleRevisions, wpCategories, user } from "@/db";
import { eq, asc, desc } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

export async function getArticle(id: string) {
  const locker = alias(user, "locker");
  const revisionActor = alias(user, "revision_actor");
  const [a] = await db.select({
    article: articles, categoryName: wpCategories.name, lockerName: locker.name,
  }).from(articles)
    .leftJoin(wpCategories, eq(articles.categoryId, wpCategories.id))
    .leftJoin(locker, eq(articles.lockedBy, locker.id))
    .where(eq(articles.id, id));
  if (!a) return null;
  const sources = await db.select().from(articleSources).where(eq(articleSources.articleId, id));
  const tags = await db.select().from(articleTags).where(eq(articleTags.articleId, id));
  // Joined against `user` (aliased) so the history panel can render "Modifié
  // par X" instead of a bare, unreadable actorId.
  const revisions = await db.select({
    id: articleRevisions.id,
    articleId: articleRevisions.articleId,
    actorId: articleRevisions.actorId,
    actorName: revisionActor.name,
    action: articleRevisions.action,
    detail: articleRevisions.detail,
    at: articleRevisions.at,
  }).from(articleRevisions)
    .leftJoin(revisionActor, eq(articleRevisions.actorId, revisionActor.id))
    .where(eq(articleRevisions.articleId, id))
    .orderBy(desc(articleRevisions.at));
  const categories = await db.select().from(wpCategories).orderBy(asc(wpCategories.name));
  return { ...a.article, categoryName: a.categoryName, lockerName: a.lockerName, sources, tags, revisions, categories };
}

export type ArticleDetail = NonNullable<Awaited<ReturnType<typeof getArticle>>>;

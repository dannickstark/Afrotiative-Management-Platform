import { db, articles, pipelineRuns, pipelineSteps } from "@/db";
import { and, desc, eq, gte, sql } from "drizzle-orm";

export async function getDashboardData() {
  const dayAgo = new Date(Date.now() - 864e5);
  const startOfWeek = new Date(Date.now() - 7 * 864e5);

  const pendingCount = await db.$count(articles, eq(articles.status, "pending"));
  const failedRuns24h = await db.$count(pipelineRuns, and(eq(pipelineRuns.status, "failed"), gte(pipelineRuns.startedAt, dayAgo)));
  const publishedWeek = await db.$count(articles, and(eq(articles.status, "published"), gte(articles.publishedAt, startOfWeek)));
  const publishedToday = await db.$count(articles, and(eq(articles.status, "published"), gte(articles.publishedAt, new Date(new Date().setHours(0,0,0,0)))));

  const [lastRun] = await db.select().from(pipelineRuns).orderBy(desc(pipelineRuns.startedAt)).limit(1);

  const latestPending = await db.select({
    id: articles.id, title: articles.title, status: articles.status, generatedAt: articles.generatedAt,
    confidenceFlags: articles.confidenceFlags,
  }).from(articles).where(eq(articles.status, "pending")).orderBy(articles.generatedAt).limit(5);

  const latestErrors = await db.select({
    id: pipelineSteps.id, name: pipelineSteps.name, message: pipelineSteps.errorMessage,
  }).from(pipelineSteps).where(eq(pipelineSteps.status, "failed")).limit(5);

  return { pendingCount, failedRuns24h, publishedToday, publishedWeek, lastRun, latestPending, latestErrors };
}

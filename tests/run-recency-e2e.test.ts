import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { db, feeds, rawItems, pipelineRuns, pipelineSteps, articles, articleSources, clusters, pipelineSettings } from "@/db";
import { eq, inArray, like } from "drizzle-orm";
import { openRun, executeRun } from "@/lib/pipeline/run";
import type { RunParams } from "@/db";

const PROVIDER_KEYS = [
  "JINA_API_KEY", "FIRECRAWL_API_KEY", "EMBED_API_KEY", "OPENROUTER_API_KEY",
  "OMNIROUTE_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY",
] as const;
function snapshotEnv(keys: readonly string[]) { return Object.fromEntries(keys.map((k) => [k, process.env[k]])); }
function restoreEnv(snap: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(snap)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
}
const ARTICLE_HTML = `<html><body><article><h1>Titre</h1><p>${"Contenu régional de référence. ".repeat(20)}</p></article></body></html>`;

describe("executeRun — phase-1 recency filter", () => {
  const envSnap = snapshotEnv(PROVIDER_KEYS);
  let settingsSnapshot: typeof pipelineSettings.$inferSelect | undefined;
  let article: ReturnType<typeof Bun.serve>;
  let rss: ReturnType<typeof Bun.serve>;
  let feedId: string;
  let runId: string | null = null;
  let recentUrl = "";

  beforeAll(async () => {
    for (const k of PROVIDER_KEYS) delete process.env[k];
    article = Bun.serve({ port: 0, fetch: () => new Response(ARTICLE_HTML, { headers: { "content-type": "text/html" } }) });
    recentUrl = `http://localhost:${article.port}/recent`;
    const oldDate = new Date(Date.now() - 10 * 24 * 3600_000).toUTCString();   // 10 days ago
    const recentDate = new Date().toUTCString();                                // now
    const items = `
      <item><title>Vieille actualité</title><link>http://localhost:${article.port}/old</link>
        <guid>test:recency:old</guid><description>Ancienne dépêche.</description><pubDate>${oldDate}</pubDate></item>
      <item><title>Actualité récente</title><link>${recentUrl}</link>
        <guid>test:recency:recent</guid><description>Dépêche récente.</description><pubDate>${recentDate}</pubDate></item>`;
    rss = Bun.serve({ port: 0, fetch: () => new Response(
      `<?xml version="1.0"?><rss version="2.0"><channel><title>Fixture récence</title>${items}</channel></rss>`,
      { headers: { "content-type": "application/xml" } }) });

    [settingsSnapshot] = await db.select().from(pipelineSettings).where(eq(pipelineSettings.id, 1));
    await db.insert(pipelineSettings).values({ id: 1, maxItemsPerRun: 10 })
      .onConflictDoUpdate({ target: pipelineSettings.id, set: { maxItemsPerRun: 10 } });

    const [f] = await db.insert(feeds).values({ name: "Fixture récence", feedUrl: `http://localhost:${rss.port}/feed`, active: true }).returning({ id: feeds.id });
    feedId = f.id;
  });

  afterAll(async () => {
    article.stop(true); rss.stop(true);
    restoreEnv(envSnap);
    await db.delete(pipelineSettings).where(eq(pipelineSettings.id, 1));
    if (settingsSnapshot) await db.insert(pipelineSettings).values(settingsSnapshot);
    // FK-safe cleanup of any article staged from the recent fixture.
    const src = await db.select({ articleId: articleSources.articleId }).from(articleSources).where(like(articleSources.url, `http://localhost:${article.port}%`));
    const ids = [...new Set(src.map((s) => s.articleId))];
    let clusterIds: string[] = [];
    if (ids.length) {
      const staged = await db.select({ clusterId: articles.clusterId }).from(articles).where(inArray(articles.id, ids));
      clusterIds = [...new Set(staged.map((a) => a.clusterId).filter((c): c is string => c !== null))];
      await db.delete(articles).where(inArray(articles.id, ids));
    }
    for (const c of clusterIds) {
      const used = await db.select({ id: articles.id }).from(articles).where(eq(articles.clusterId, c)).limit(1);
      if (!used.length) await db.delete(clusters).where(eq(clusters.id, c));
    }
    await db.delete(rawItems).where(eq(rawItems.feedId, feedId));
    if (runId) await db.delete(pipelineRuns).where(eq(pipelineRuns.id, runId));
    await db.delete(feeds).where(eq(feeds.id, feedId));
  });

  it("skips items older than the cutoff, records only the recent one, and logs a 'too old' step", async () => {
    const params: RunParams = {
      recency: { kind: "age", hours: 48, cutoffAt: new Date(Date.now() - 48 * 3600_000).toISOString() },
      feedIds: null, maxItems: 10,
    };
    runId = await openRun({ triggeredBy: "manual", feedsTotal: 1, params });
    expect(runId).not.toBeNull();
    await executeRun(runId!);

    const recorded = await db.select({ url: rawItems.url }).from(rawItems).where(eq(rawItems.feedId, feedId));
    expect(recorded.map((r) => r.url)).toEqual([recentUrl]);          // old item filtered before recording

    const steps = await db.select({ name: pipelineSteps.name }).from(pipelineSteps).where(eq(pipelineSteps.runId, runId!));
    expect(steps.some((s) => /trop anciens/i.test(s.name))).toBe(true);
  }, 20000);
});

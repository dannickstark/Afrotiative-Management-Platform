import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { db, articles, articleSources, articleEmbeddings, clusters } from "@/db";
import { eq } from "drizzle-orm";
import { stageItem } from "@/lib/pipeline/stages";
import { contentHash, type RawItem } from "@/lib/rss/parse-feed";

const TITLE = "La BRVM franchit un nouveau record historique";
const BODY_SENTENCE = "La bourse régionale ouest-africaine enregistre une progression continue portée par le secteur bancaire et les valeurs minières. ";
const FIXTURE_HTML = `<html><head><title>Ignoré</title></head><body><article>
  <h1>${TITLE}</h1>
  <p>${BODY_SENTENCE.repeat(15)}</p>
</article></body></html>`;

// End-to-end (real Neon DB) but network-free: a tiny local Bun.serve fixture stands in for the
// source article, and every external provider is forced onto its credential-free fallback
// (readability for extraction, mock for embeddings + LLM generation) so the test never makes a
// real network call. Same env-var-deletion pattern already used in tests/extract-chain.test.ts
// and tests/ai-fallback.test.ts.
describe("stageItem (end-to-end, network-free)", () => {
  const original = {
    JINA_API_KEY: process.env.JINA_API_KEY,
    FIRECRAWL_API_KEY: process.env.FIRECRAWL_API_KEY,
    EMBED_API_KEY: process.env.EMBED_API_KEY,
    OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
    OMNIROUTE_API_KEY: process.env.OMNIROUTE_API_KEY,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    GOOGLE_GENERATIVE_AI_API_KEY: process.env.GOOGLE_GENERATIVE_AI_API_KEY,
  };

  let server: ReturnType<typeof Bun.serve>;
  let articleUrl: string;
  let createdArticleId: string | null = null;
  let createdClusterId: string | null = null;

  beforeAll(() => {
    for (const k of Object.keys(original)) delete process.env[k as keyof typeof original];
    server = Bun.serve({ port: 0, fetch: () => new Response(FIXTURE_HTML, { headers: { "content-type": "text/html" } }) });
    articleUrl = `http://localhost:${server.port}/article`;
  });

  afterAll(async () => {
    server.stop(true);
    for (const [k, v] of Object.entries(original)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    // FK order: article first (cascades article_sources/article_embeddings/article_tags).
    if (createdArticleId) await db.delete(articles).where(eq(articles.id, createdArticleId));
    if (createdClusterId) {
      // Only remove the cluster if nothing else still references it — decideCluster could in
      // principle have attached to a pre-existing cluster rather than creating a fresh one.
      const stillUsed = await db.select({ id: articles.id }).from(articles).where(eq(articles.clusterId, createdClusterId)).limit(1);
      if (stillUsed.length === 0) await db.delete(clusters).where(eq(clusters.id, createdClusterId));
    }
  });

  it("stages a new RawItem into a pending, AI-authored article with source + embedding + cluster", async () => {
    const item: RawItem = {
      guid: "test:pipeline-run:brvm-record",
      url: articleUrl,
      title: TITLE,
      contentSnippet: "La bourse régionale progresse fortement.",
      isoDate: new Date().toISOString(),
      contentHash: contentHash(TITLE, "La bourse régionale progresse fortement."),
    };

    const { articleId, steps } = await stageItem(item, "Test Media", ["Économie", "Marchés"]);

    expect(articleId).not.toBeNull();
    createdArticleId = articleId;
    expect(steps.map((s) => s.name)).toEqual([
      "Extraction du contenu", "Calcul de l'embedding", "Regroupement (clustering)", "Génération IA", "Dépôt en revue",
    ]);
    expect(steps.every((s) => s.status === "success")).toBe(true);
    expect(steps.every((s) => s.durationMs >= 0)).toBe(true);

    const [article] = await db.select().from(articles).where(eq(articles.id, articleId!));
    expect(article.status).toBe("pending");
    expect(article.aiAuthor).toBe(true);
    expect(article.generatedAt).not.toBeNull();
    expect(article.clusterId).not.toBeNull();
    createdClusterId = article.clusterId;

    const sources = await db.select().from(articleSources).where(eq(articleSources.articleId, articleId!));
    expect(sources.length).toBe(1);
    expect(sources[0].mediaName).toBe("Test Media");
    expect(sources[0].url).toBe(articleUrl);

    const embeddingRows = await db.select().from(articleEmbeddings).where(eq(articleEmbeddings.articleId, articleId!));
    expect(embeddingRows.length).toBe(1);
    expect(embeddingRows[0].embedding?.length).toBe(1024);
  });
});

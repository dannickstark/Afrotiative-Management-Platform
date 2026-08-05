import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import {
  db, articles, articleSources, articleEmbeddings, articleRevisions, clusters,
  wpCategories, pipelineSettings,
} from "@/db";
import { eq, inArray } from "drizzle-orm";
import { persistArticle, stageItem, type SourceInput } from "@/lib/pipeline/stages";
import type { ArticleDraft } from "@/lib/ai";
import { contentHash, type RawItem } from "@/lib/rss/parse-feed";
import type { PipelineSettings } from "@/lib/queries/settings";

// ─────────────────────────────────────────────────────────────────────────────
// SP6 — gated auto-publish, integration coverage.
//
// WHY THIS FILE DRIVES persistArticle() DIRECTLY (not the full stageSources()/generateArticle()
// round-trip) for the POSITIVE (auto-approve) direction:
//
// Every network-free test in this suite (see tests/pipeline-run.test.ts) forces generateArticle()
// and embed() onto their deterministic mock fallbacks by deleting every provider credential —
// that's what makes them network-free. But lib/pipeline/stages.ts ALWAYS sets
// confidence.aiDegraded=true whenever either fallback fired (see stageSources's own comment), and
// shouldAutoPublish() blocks on aiDegraded unconditionally. So a fully real, network-free
// stageSources() call can NEVER reach the auto-approve branch — proving that branch through the
// full round-trip would require either a real LLM/embedding provider (not network-free) or
// elaborately faking the AI SDK's provider protocol via a shared-module-registry mock.module()
// (fragile: Bun shares ONE module registry across the whole `bun test` run — see
// tests/ai-fallback.test.ts's own extensive comments on the restoration hazard that creates).
//
// persistArticle() (exported from stages.ts) is the actual application code that DECIDES and
// WRITES the auto-approve outcome — it's exactly "the auto-approve logic" stageSources calls at
// its "Dépôt en revue" step, just with the draft/score/confidence/vector already computed rather
// than obtained via generateArticle()/embed()/decideCluster(). Calling it directly with a crafted,
// non-degraded draft therefore proves the REAL wiring (status/scheduledAt/audit-row) for the
// positive direction, against the real dev DB, with no network access and no module mocking at all.
//
// The SAFETY direction (a degraded/mock article must never auto-publish) is instead proven through
// the full, real, network-free stageItem()→stageSources() path in the second describe block below —
// with pipeline_settings flipped to the MOST permissive configuration possible
// (autoPublishEnabled=true, scoreThreshold=0, autoPublishMinSources=1), so the only thing standing
// between this article and auto-approval is the aiDegraded confidence flag itself. That is the
// genuinely load-bearing safety property SP6 must uphold, and it is exercised through the real
// production code path end to end.

const VECTOR = Array.from({ length: 1024 }, (_, i) => ((i % 17) - 8) / 1000);

function draft(overrides: Partial<ArticleDraft> = {}): ArticleDraft {
  return {
    title: "Titre suffisamment long pour un article auto-publiable",
    bodyHtml: "<p>Corps.</p>",
    excerpt: "Extrait.",
    category: "Test SP6 Auto-Publish",
    tags: ["sp6"],
    featuredImageUrl: "https://img.example/photo.jpg",
    imageCredit: "Crédit Test",
    imageSourceUrl: "https://img.example/source",
    confidence: { categoryUncertain: false, imageMissing: false, clusterUncertain: false },
    ...overrides,
  };
}

const SOURCES: SourceInput[] = [
  { mediaName: "Média A (test)", url: "https://src.example/sp6-a", text: "x" },
  { mediaName: "Média B (test)", url: "https://src.example/sp6-b", text: "x" },
];

describe("persistArticle — SP6 auto-approve wiring (direct, crafted draft, real DB)", () => {
  let categoryId: string;
  const createdArticleIds: string[] = [];
  const createdClusterIds: string[] = [];

  beforeAll(async () => {
    const [cat] = await db.insert(wpCategories)
      .values({ name: "Test SP6 Auto-Publish", slug: "test-sp6-auto-publish" })
      .returning();
    categoryId = cat.id;
  });

  afterAll(async () => {
    if (createdArticleIds.length > 0) {
      // Cascades article_sources/article_tags/article_embeddings/article_revisions.
      await db.delete(articles).where(inArray(articles.id, createdArticleIds));
    }
    for (const clusterId of createdClusterIds) {
      const stillUsed = await db.select({ id: articles.id }).from(articles).where(eq(articles.clusterId, clusterId)).limit(1);
      if (stillUsed.length === 0) await db.delete(clusters).where(eq(clusters.id, clusterId));
    }
    await db.delete(wpCategories).where(eq(wpCategories.id, categoryId));
  });

  it("auto-approves a qualifying article: status='approved', scheduledAt set, audited via article_revisions", async () => {
    const result = await persistArticle({
      draft: draft(),
      sanitizedBody: "<p>Corps assaini.</p>",
      vector: VECTOR,
      clusterId: null,
      score: 85,
      confidence: { categoryUncertain: false, imageMissing: false, clusterUncertain: false },
      sources: SOURCES,
      categoryNames: ["Test SP6 Auto-Publish"],
      autoPublish: { enabled: true, scoreThreshold: 70, minSources: 2 },
    });
    createdArticleIds.push(result.articleId);
    expect(result.autoApproved).toBe(true);

    const [row] = await db.select().from(articles).where(eq(articles.id, result.articleId));
    if (row.clusterId) createdClusterIds.push(row.clusterId);
    expect(row.status).toBe("approved");
    expect(row.scheduledAt).not.toBeNull();
    expect(row.scheduledAt!.getTime()).toBeLessThanOrEqual(Date.now());
    expect(row.score).toBe(85);
    expect(row.categoryId).toBe(categoryId);

    const revisions = await db.select().from(articleRevisions).where(eq(articleRevisions.articleId, result.articleId));
    expect(revisions).toHaveLength(1);
    expect(revisions[0].action).toBe("publié automatiquement");
    expect(revisions[0].actorId).toBeNull(); // system, not a human — the audited exception
    expect(revisions[0].detail).toContain("Score 85");
    expect(revisions[0].detail).toContain("seuil 70");
    expect(revisions[0].detail).toContain("2 source(s)");

    const srcRows = await db.select().from(articleSources).where(eq(articleSources.articleId, result.articleId));
    expect(srcRows).toHaveLength(2);
    const embRows = await db.select().from(articleEmbeddings).where(eq(articleEmbeddings.articleId, result.articleId));
    expect(embRows).toHaveLength(1);
  });

  it("leaves the article 'pending' with NO audit revision when autoPublishEnabled=false, even though every other condition qualifies", async () => {
    const result = await persistArticle({
      draft: draft(),
      sanitizedBody: "<p>Corps assaini.</p>",
      vector: VECTOR,
      clusterId: null,
      score: 95, // well above threshold
      confidence: { categoryUncertain: false, imageMissing: false, clusterUncertain: false },
      sources: SOURCES,
      categoryNames: ["Test SP6 Auto-Publish"],
      autoPublish: { enabled: false, scoreThreshold: 70, minSources: 2 },
    });
    createdArticleIds.push(result.articleId);
    expect(result.autoApproved).toBe(false);

    const [row] = await db.select().from(articles).where(eq(articles.id, result.articleId));
    if (row.clusterId) createdClusterIds.push(row.clusterId);
    expect(row.status).toBe("pending");
    expect(row.scheduledAt).toBeNull();

    const revisions = await db.select().from(articleRevisions).where(eq(articleRevisions.articleId, result.articleId));
    expect(revisions).toHaveLength(0);
  });

  it("leaves the article 'pending' with NO audit revision when a single confidence flag is set (aiDegraded), despite enabled+high score+sources+image", async () => {
    const result = await persistArticle({
      draft: draft(),
      sanitizedBody: "<p>Corps assaini.</p>",
      vector: VECTOR,
      clusterId: null,
      score: 95,
      confidence: { categoryUncertain: false, imageMissing: false, clusterUncertain: false, aiDegraded: true },
      sources: SOURCES,
      categoryNames: ["Test SP6 Auto-Publish"],
      autoPublish: { enabled: true, scoreThreshold: 70, minSources: 2 },
    });
    createdArticleIds.push(result.articleId);
    expect(result.autoApproved).toBe(false);

    const [row] = await db.select().from(articles).where(eq(articles.id, result.articleId));
    if (row.clusterId) createdClusterIds.push(row.clusterId);
    expect(row.status).toBe("pending");
    expect(row.scheduledAt).toBeNull();

    const revisions = await db.select().from(articleRevisions).where(eq(articleRevisions.articleId, result.articleId));
    expect(revisions).toHaveLength(0);
  });

  it("leaves the article 'pending' when sourceCount is below minSources, despite enabled+high score+image", async () => {
    const result = await persistArticle({
      draft: draft(),
      sanitizedBody: "<p>Corps assaini.</p>",
      vector: VECTOR,
      clusterId: null,
      score: 95,
      confidence: { categoryUncertain: false, imageMissing: false, clusterUncertain: false },
      sources: [SOURCES[0]], // only 1 source, minSources requires 2
      categoryNames: ["Test SP6 Auto-Publish"],
      autoPublish: { enabled: true, scoreThreshold: 70, minSources: 2 },
    });
    createdArticleIds.push(result.articleId);
    expect(result.autoApproved).toBe(false);

    const [row] = await db.select().from(articles).where(eq(articles.id, result.articleId));
    if (row.clusterId) createdClusterIds.push(row.clusterId);
    expect(row.status).toBe("pending");
    expect(row.scheduledAt).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Full, real, network-free stageItem()→stageSources() round-trip (same Bun.serve fixture pattern
// as tests/pipeline-run.test.ts) with pipeline_settings flipped to the MOST auto-publish-permissive
// configuration possible. The only thing that can still block auto-approval here is the
// aiDegraded confidence flag stageSources sets whenever generateArticle()/embed() fall back to
// their mock implementations (unavoidable network-free, since no provider credentials are
// configured) — this is the genuinely load-bearing safety property: SP6 must never auto-publish a
// degraded article, no matter how permissive the admin-configured thresholds are.

const TITLE = "Une histoire test pour SP6 auto-publish (chemin dégradé)";
const BODY_SENTENCE = "Contenu de test suffisamment long pour dépasser les seuils de complétude du score. ";
const FIXTURE_HTML = `<html><head><title>Ignoré</title></head><body><article>
  <h1>${TITLE}</h1>
  <p>${BODY_SENTENCE.repeat(15)}</p>
</article></body></html>`;

const PROVIDER_KEYS = [
  "JINA_API_KEY", "FIRECRAWL_API_KEY", "EMBED_API_KEY", "OPENROUTER_API_KEY",
  "OMNIROUTE_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY",
] as const;

function snapshotEnv(keys: readonly string[]): Record<string, string | undefined> {
  return Object.fromEntries(keys.map((k) => [k, process.env[k]]));
}
function restoreEnv(snap: Record<string, string | undefined>): void {
  for (const [k, v] of Object.entries(snap)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

describe("stageItem (network-free, degraded/mock path) — SP6 safety net under maximally permissive settings", () => {
  const originalEnv = snapshotEnv(PROVIDER_KEYS);
  let settingsSnapshot: PipelineSettings | null = null;
  let server: ReturnType<typeof Bun.serve>;
  let articleUrl: string;
  let createdArticleId: string | null = null;
  let createdClusterId: string | null = null;

  beforeAll(async () => {
    for (const k of PROVIDER_KEYS) delete process.env[k];
    server = Bun.serve({ port: 0, fetch: () => new Response(FIXTURE_HTML, { headers: { "content-type": "text/html" } }) });
    articleUrl = `http://localhost:${server.port}/sp6-degraded`;

    // pipeline_settings row id=1 is a shared, app-wide singleton — snapshot once, restore exactly
    // (same idiom as tests/pipeline-settings.test.ts) since this test deliberately flips it to the
    // most auto-publish-permissive configuration possible.
    const [row] = await db.select().from(pipelineSettings).where(eq(pipelineSettings.id, 1));
    settingsSnapshot = row ?? null;
    await db.delete(pipelineSettings).where(eq(pipelineSettings.id, 1));
    await db.insert(pipelineSettings).values({
      id: 1, autoPublishEnabled: true, scoreThreshold: 0, autoPublishMinSources: 1,
    });
  });

  afterAll(async () => {
    server.stop(true);
    restoreEnv(originalEnv);
    if (createdArticleId) await db.delete(articles).where(eq(articles.id, createdArticleId));
    if (createdClusterId) {
      const stillUsed = await db.select({ id: articles.id }).from(articles).where(eq(articles.clusterId, createdClusterId)).limit(1);
      if (stillUsed.length === 0) await db.delete(clusters).where(eq(clusters.id, createdClusterId));
    }
    await db.delete(pipelineSettings).where(eq(pipelineSettings.id, 1));
    if (settingsSnapshot) await db.insert(pipelineSettings).values(settingsSnapshot);
  });

  it("stays 'pending' (no auto-approve, no audit revision, no 'Publication automatique' step) even with autoPublishEnabled=true, scoreThreshold=0, minSources=1", async () => {
    const item: RawItem = {
      guid: "test:auto-publish-run:sp6-degraded",
      url: articleUrl,
      title: TITLE,
      contentSnippet: "Contenu de repli pour le test SP6.",
      isoDate: new Date().toISOString(),
      contentHash: contentHash(TITLE, "Contenu de repli pour le test SP6."),
    };

    const { articleId, steps } = await stageItem(item, "Test Media SP6", ["Économie", "Marchés"]);

    expect(articleId).not.toBeNull();
    createdArticleId = articleId;

    // The decisive assertion: NOT auto-approved, despite settings permissive enough that only the
    // aiDegraded flag (unavoidable network-free — see this describe block's comment) blocks it.
    expect(steps.some((s) => s.name === "Publication automatique")).toBe(false);

    const [article] = await db.select().from(articles).where(eq(articles.id, articleId!));
    createdClusterId = article.clusterId;
    expect(article.status).toBe("pending");
    expect(article.scheduledAt).toBeNull();
    expect(article.confidenceFlags?.aiDegraded).toBe(true);

    const revisions = await db.select().from(articleRevisions).where(eq(articleRevisions.articleId, articleId!));
    expect(revisions.find((r) => r.action === "publié automatiquement")).toBeUndefined();
  });
});

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { can } from "@/lib/rbac";
import { db, articles, articleSources, articleEmbeddings, clusters, feeds, rawItems } from "@/db";
import { eq } from "drizzle-orm";
import { stageItem } from "@/lib/pipeline/stages";
import { isSeen } from "@/lib/pipeline/dedup";
import { contentHash, type RawItem } from "@/lib/rss/parse-feed";

describe("reprocess authz", () => {
  it("only admin may reprocess", () => {
    expect(can("admin", "pipeline", "configure")).toBe(true);
    expect(can("editor", "pipeline", "configure")).toBe(false);
    expect(can("journalist", "pipeline", "configure")).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Dedup-bypass integration test (real Neon DB, network-free).
//
// reprocessRawItem's whole point is to retry an item that is ALREADY recorded in raw_items
// (e.g. after a failed run) without going through the normal isSeen()/recordRawItem() ingestion
// gate. We can't easily call reprocessRawItem itself here (it requires a real session via
// requireUser()), so — per the task brief — we exercise the exact mechanism it relies on: build
// a RawItem straight off an already-stored raw_items row (as reprocessRawItem does) and pass it
// to stageItem() directly, proving stageItem stages a pending article for an item that isSeen()
// would flag as a duplicate.
const TITLE = "La zone UEMOA annonce une réforme monétaire majeure";
const SNIPPET = "Une réforme monétaire est annoncée pour la zone UEMOA.";
const BODY_SENTENCE = "Les autorités monétaires régionales détaillent un plan de réforme visant à renforcer la stabilité du franc CFA et à approfondir l'intégration financière. ";
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

describe("reprocess: dedup bypass + pending stage (end-to-end, network-free)", () => {
  const original = snapshotEnv(PROVIDER_KEYS);
  let server: ReturnType<typeof Bun.serve>;
  let articleUrl: string;
  let feedId: string;
  let rawItemId: string;
  let createdArticleId: string | null = null;
  let createdClusterId: string | null = null;

  beforeAll(async () => {
    for (const k of PROVIDER_KEYS) delete process.env[k];
    server = Bun.serve({ port: 0, fetch: () => new Response(FIXTURE_HTML, { headers: { "content-type": "text/html" } }) });
    articleUrl = `http://localhost:${server.port}/article`;

    const [f] = await db.insert(feeds).values({
      name: "Flux de test (reprocess)", feedUrl: "http://127.0.0.1:1/rss", active: true,
    }).returning({ id: feeds.id });
    feedId = f.id;

    // Pre-record the raw_items row exactly like the normal ingestion path would have — this is
    // what makes the item "already seen" for dedup purposes.
    const [ri] = await db.insert(rawItems).values({
      feedId,
      guid: "test:reprocess:uemoa-reform",
      url: articleUrl,
      contentHash: contentHash(TITLE, SNIPPET),
      rawTitle: TITLE,
      rawBody: SNIPPET,
    }).returning({ id: rawItems.id });
    rawItemId = ri.id;
  });

  afterAll(async () => {
    server.stop(true);
    restoreEnv(original);
    // FK order: article first (cascades article_sources/article_embeddings/article_tags), then
    // cluster (if now orphaned), then the temp raw_item and feed.
    if (createdArticleId) await db.delete(articles).where(eq(articles.id, createdArticleId));
    if (createdClusterId) {
      const stillUsed = await db.select({ id: articles.id }).from(articles).where(eq(articles.clusterId, createdClusterId)).limit(1);
      if (stillUsed.length === 0) await db.delete(clusters).where(eq(clusters.id, createdClusterId));
    }
    await db.delete(rawItems).where(eq(rawItems.id, rawItemId));
    await db.delete(feeds).where(eq(feeds.id, feedId));
  });

  it("stages a pending article for an item that isSeen() already flags as a duplicate", async () => {
    // Build the item exactly the way reprocessRawItem does: straight off the stored raw_items
    // row, guid/url/contentHash unchanged from what was recorded above.
    const item: RawItem = {
      guid: "test:reprocess:uemoa-reform",
      url: articleUrl,
      title: TITLE,
      contentSnippet: SNIPPET,
      isoDate: null,
      contentHash: contentHash(TITLE, SNIPPET),
    };

    // Precondition: this item genuinely IS a duplicate by the normal ingestion gate — proves the
    // raw_items row we just inserted really would block a fresh isSeen()/recordRawItem() pass.
    expect(await isSeen(feedId, item)).toBe(true);

    // stageItem never calls isSeen()/recordRawItem() — reprocessRawItem (and this test, mirroring
    // it) hand it the item straight from the stored row, so the "already seen" status above has
    // no effect on whether it gets staged.
    const { articleId, steps } = await stageItem(item, "Flux de test (reprocess)", ["Économie", "Marchés"]);

    expect(articleId).not.toBeNull();
    createdArticleId = articleId;
    expect(steps.every((s) => s.status === "success")).toBe(true);

    const [article] = await db.select().from(articles).where(eq(articles.id, articleId!));
    expect(article.status).toBe("pending");
    expect(article.aiAuthor).toBe(true);
    createdClusterId = article.clusterId;

    const sources = await db.select().from(articleSources).where(eq(articleSources.articleId, articleId!));
    expect(sources.length).toBe(1);
    expect(sources[0].url).toBe(articleUrl);

    const embeddingRows = await db.select().from(articleEmbeddings).where(eq(articleEmbeddings.articleId, articleId!));
    expect(embeddingRows.length).toBe(1);

    // The duplicate-by-dedup precondition still holds after staging — dedup was never consulted
    // or updated by this path, only bypassed.
    expect(await isSeen(feedId, item)).toBe(true);
  });
});

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import {
  db, articles, articleSources, articleEmbeddings, clusters, feeds, rawItems,
  pipelineRuns, pipelineSteps, pipelineSettings,
} from "@/db";
import { eq, inArray, like } from "drizzle-orm";
import { openRun, executeRun } from "@/lib/pipeline/run";
import { stageSources } from "@/lib/pipeline/stages";
import { isSeen } from "@/lib/pipeline/dedup";
import { ITEM_STAGES } from "@/lib/pipeline/live";
import { type RawItem } from "@/lib/rss/parse-feed";

// ─────────────────────────────────────────────────────────────────────────────
// SP4 Task 6a — the per-story corpus-grouping restructure of executeRun. Real Neon dev DB,
// network-free: every external provider (LLM + extraction) is forced onto its credential-free
// fallback via provider-key stripping (same pattern as tests/pipeline-run.test.ts /
// tests/live-progress.test.ts), and a local Bun.serve fixture stands in for both the source
// article page AND — new here — the Jina embeddings API.
//
// WHY a fake embeddings API (not just the built-in hash-based mock): lib/embeddings/mock.ts's
// mockEmbed (used when NO embed key/endpoint is configured at all) is a hash of the exact input
// string — ANY difference in input text (even a single character) yields an uncorrelated vector
// (see tests/embeddings.test.ts). That makes it impossible to deterministically exercise "two
// DIFFERENT RSS items whose embeddings are nonetheless similar enough to be the same story" —
// which is exactly what real semantic embeddings (jina-embeddings-v3) would do for near-duplicate
// coverage of one event. Pointing EMBED_BASE_URL at a local fixture that returns a FIXED vector
// per marker token gives the same determinism the real semantic case has, without any network call.

const PROVIDER_KEYS = [
  "JINA_API_KEY", "FIRECRAWL_API_KEY", "OPENROUTER_API_KEY",
  "OMNIROUTE_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY",
] as const;
const EMBED_ENV_KEYS = ["EMBED_API_KEY", "EMBED_BASE_URL"] as const;

function snapshotEnv(keys: readonly string[]): Record<string, string | undefined> {
  return Object.fromEntries(keys.map((k) => [k, process.env[k]]));
}
function restoreEnv(snap: Record<string, string | undefined>): void {
  for (const [k, v] of Object.entries(snap)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

// Entity-escaped so JSDOM/Readability's textContent extraction DECODES it into the literal
// characters `<script>alert(1)</script>` — i.e. plain TEXT that only becomes real markup once the
// (mocked) LLM interpolates it into bodyHtml. This proves stageSources' sanitizeArticleHtml()
// wiring (SP4 Task 2, closed by Task 6a) actually strips something the model "hallucinated"
// straight out of scraped source text, rather than merely asserting on content that was always safe.
const SCRIPT_PAYLOAD = "&lt;script&gt;alert(1)&lt;/script&gt;";
const ARTICLE_HTML = `<html><head><title>Ignoré</title></head><body><article>
  <h1>Fusion bancaire régionale</h1>
  <p>${"Contenu détaillé de l'article couvrant l'actualité économique régionale. ".repeat(10)}
     ${SCRIPT_PAYLOAD}
     ${"Suite du contenu détaillé apportant des précisions supplémentaires. ".repeat(10)}</p>
</article></body></html>`;

// Deterministic pseudo-random unit vector from an integer seed — NOT semantically meaningful (no
// need to be: the embed fixture server below always returns the SAME vector for the SAME seed and
// a DIFFERENT one for a different seed, which is all cosine-similarity grouping needs).
function fixedVector(seed: number, dims: number): number[] {
  const v = Array.from({ length: dims }, (_, i) => Math.sin(seed * (i + 1.3) + i));
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}

// Stand-in for the Jina embeddings API. Keys its response on a marker substring in the request
// text: two texts sharing "STORY_SAME" get the IDENTICAL vector (cosine 1.0 — definitely groups),
// "STORY_OTHER_A"/"STORY_OTHER_B" get distinct vectors (cosine ~0 — definitely doesn't group), and
// anything else (e.g. the POST-generation embed(title+body) call inside stageSources, whose input
// is the mock-generated title/body and contains none of these markers) falls to a generic bucket.
function embedFixtureServer() {
  return Bun.serve({
    port: 0,
    fetch: async (req) => {
      const body = (await req.json()) as { input: string[]; dimensions?: number };
      const text = body.input[0] ?? "";
      let seed = 0;
      if (text.includes("STORY_SAME")) seed = 1;
      else if (text.includes("STORY_OTHER_A")) seed = 2;
      else if (text.includes("STORY_OTHER_B")) seed = 3;
      const dims = body.dimensions ?? 1024;
      return new Response(JSON.stringify({ data: [{ embedding: fixedVector(seed, dims) }] }), {
        headers: { "content-type": "application/json" },
      });
    },
  });
}

// 4-item RSS fixture: items 0+1 share the STORY_SAME marker (near-identical coverage of one
// event, by embedding — NOT by literal text, so contentHash/guid dedup keys stay distinct), items
// 2 and 3 are each their own unrelated story. All 4 link to the SAME article HTML (content doesn't
// need to differ per item — grouping is decided by the pre-extraction title+snippet embedding,
// not by extracted text).
function storyRssServer() {
  const article = Bun.serve({ port: 0, fetch: () => new Response(ARTICLE_HTML, { headers: { "content-type": "text/html" } }) });
  const defs = [
    { title: "Fusion bancaire régionale confirmée STORY_SAME", desc: "Une fusion bancaire majeure vient d'être annoncée dans la zone UEMOA." },
    { title: "Deux banques annoncent leur rapprochement STORY_SAME", desc: "Rapprochement bancaire d'ampleur régionale, selon des sources concordantes." },
    { title: "Un séisme frappe une région montagneuse STORY_OTHER_A", desc: "Un séisme de forte magnitude a été enregistré ce matin." },
    { title: "La bourse clôture en légère baisse STORY_OTHER_B", desc: "Les indices boursiers reculent légèrement en clôture de séance." },
  ];
  const items = defs.map((d, i) => `
    <item><title>${d.title}</title><link>http://localhost:${article.port}/a${i}</link>
    <guid>test:grouping:${i}:${Math.random()}</guid><description>${d.desc}</description></item>`).join("");
  const rss = Bun.serve({ port: 0, fetch: () => new Response(
    `<?xml version="1.0"?><rss version="2.0"><channel><title>Fixture story-grouping</title>${items}</channel></rss>`,
    { headers: { "content-type": "application/xml" } }) });
  return {
    rssUrl: `http://localhost:${rss.port}/feed`,
    articleBase: `http://localhost:${article.port}`,
    titles: defs.map((d) => d.title),
    stop: () => { article.stop(true); rss.stop(true); },
  };
}

describe("executeRun — per-story corpus grouping (SP4 Task 6a)", () => {
  const envSnap = snapshotEnv([...PROVIDER_KEYS, ...EMBED_ENV_KEYS]);
  let settingsSnapshot: typeof pipelineSettings.$inferSelect | undefined;
  let embedServer: ReturnType<typeof Bun.serve>;
  let fx: ReturnType<typeof storyRssServer>;
  let feedId: string;
  let runId: string | null = null;

  beforeAll(async () => {
    for (const k of PROVIDER_KEYS) delete process.env[k];
    embedServer = embedFixtureServer();
    process.env.EMBED_API_KEY = "test-embed-key";
    process.env.EMBED_BASE_URL = `http://localhost:${embedServer.port}`;

    // Pin clusterThreshold/maxItemsPerRun for this test rather than depend on whatever the shared
    // dev DB's admin-configured row currently holds — snapshot first so afterAll restores it exactly.
    [settingsSnapshot] = await db.select().from(pipelineSettings).where(eq(pipelineSettings.id, 1));
    await db.insert(pipelineSettings).values({ id: 1, maxItemsPerRun: 10, clusterThreshold: 0.7 })
      .onConflictDoUpdate({ target: pipelineSettings.id, set: { maxItemsPerRun: 10, clusterThreshold: 0.7 } });

    fx = storyRssServer();
    const [f] = await db.insert(feeds).values({ name: "Fixture story-grouping", feedUrl: fx.rssUrl, active: true }).returning({ id: feeds.id });
    feedId = f.id;
  });

  afterAll(async () => {
    fx.stop();
    embedServer.stop(true);
    restoreEnv(envSnap);
    await db.delete(pipelineSettings).where(eq(pipelineSettings.id, 1));
    if (settingsSnapshot) await db.insert(pipelineSettings).values(settingsSnapshot);

    // Full FK-safe cleanup, mirroring tests/live-progress.test.ts's two-phase-cap test.
    const sources = await db.select({ articleId: articleSources.articleId })
      .from(articleSources).where(like(articleSources.url, `${fx.articleBase}%`));
    const articleIds = [...new Set(sources.map((s) => s.articleId))];
    let clusterIds: string[] = [];
    if (articleIds.length > 0) {
      const staged = await db.select({ clusterId: articles.clusterId }).from(articles).where(inArray(articles.id, articleIds));
      clusterIds = [...new Set(staged.map((a) => a.clusterId).filter((c): c is string => c !== null))];
      await db.delete(articles).where(inArray(articles.id, articleIds)); // cascades sources/embeddings/tags
    }
    for (const clusterId of clusterIds) {
      const stillUsed = await db.select({ id: articles.id }).from(articles).where(eq(articles.clusterId, clusterId)).limit(1);
      if (stillUsed.length === 0) await db.delete(clusters).where(eq(clusters.id, clusterId));
    }
    await db.delete(rawItems).where(eq(rawItems.feedId, feedId));
    if (runId) await db.delete(pipelineRuns).where(eq(pipelineRuns.id, runId)); // cascades pipeline_steps
    await db.delete(feeds).where(eq(feeds.id, feedId));
  });

  it("collapses same-story candidates into ONE multi-source article, keeps unrelated candidates separate, records every member as seen, sanitizes+scores the result", async () => {
    runId = await openRun({ triggeredBy: "manual", feedsTotal: 1 });
    expect(runId).not.toBeNull();

    const res = await executeRun(runId!, { feedIds: [feedId] });

    // (d) Invariants: terminal status, no failures anywhere in this run.
    expect(res.status).toBe("success");
    const [row] = await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, runId!));
    expect(row.phase).toBe("finalizing");
    expect(row.currentStage).toBeNull();
    expect(row.currentItem).toBeNull();
    expect(row.finishedAt).not.toBeNull();

    // 4 candidates greedily group into 3 STORIES (2 same-story + 2 unrelated singles) —
    // total_items/processed_items count GROUPS, not raw candidates.
    expect(row.totalItems).toBe(3);
    expect(row.processedItems).toBe(3);
    expect(res.produced).toBe(3);

    // (b) All 4 members recorded as seen — the dedup-tension fix: merged members never become
    // separate articles on a later run because they were ALL recordRawItem()'d here.
    const recorded = await db.select().from(rawItems).where(eq(rawItems.feedId, feedId));
    expect(recorded.length).toBe(4);
    for (const title of fx.titles) {
      expect(recorded.some((r) => r.rawTitle === title)).toBe(true);
    }
    // None "reprocessed": every recorded row really is seen by the normal dedup gate now.
    for (const r of recorded) {
      const asItem: RawItem = {
        guid: r.guid, url: r.url, title: r.rawTitle ?? "", contentSnippet: r.rawBody ?? "",
        isoDate: null, contentHash: r.contentHash,
      };
      expect(await isSeen(feedId, asItem)).toBe(true);
    }

    // (a) Locate the 3 articles produced by this run via their article_sources.url.
    const producedSources = await db.select().from(articleSources).where(like(articleSources.url, `${fx.articleBase}%`));
    const byArticle = new Map<string, typeof producedSources>();
    for (const s of producedSources) {
      if (!byArticle.has(s.articleId)) byArticle.set(s.articleId, []);
      byArticle.get(s.articleId)!.push(s);
    }
    expect(byArticle.size).toBe(3);
    const counts = [...byArticle.values()].map((v) => v.length).sort((a, b) => a - b);
    expect(counts).toEqual([1, 1, 2]); // the STORY_SAME pair merged into one 2-source article

    const mergedArticleId = [...byArticle.entries()].find(([, v]) => v.length === 2)![0];
    const [merged] = await db.select().from(articles).where(eq(articles.id, mergedArticleId));

    // (c) Non-null score + sanitized body: <h2> from the mock's structure survives, but the
    // <script> the mock echoed straight out of the (entity-decoded) scraped text does NOT.
    expect(merged.score).not.toBeNull();
    expect(merged.score).toBeGreaterThanOrEqual(0);
    expect(merged.bodyHtml.toLowerCase()).not.toContain("<script");
    expect(merged.bodyHtml).toContain("<h2");
    expect(merged.status).toBe("pending"); // human-review barrier intact
    expect(merged.aiAuthor).toBe(true);

    const embeddingRows = await db.select().from(articleEmbeddings).where(eq(articleEmbeddings.articleId, mergedArticleId));
    expect(embeddingRows.length).toBe(1);

    // The two singleton articles are equally well-formed (sanity — not the focus of this test).
    for (const [articleId, srcs] of byArticle) {
      if (articleId === mergedArticleId) continue;
      expect(srcs.length).toBe(1);
      const [a] = await db.select().from(articles).where(eq(articles.id, articleId));
      expect(a.status).toBe("pending");
      expect(a.score).not.toBeNull();
    }

    // (e) Story-step unification (SP4 Task 6a review, Finding 2): every step of a story — the one
    // "Extraction du contenu" step AND the 4 synthesis steps — is attributed to that story's
    // PRIMARY rawItemId, so groupSteps() (lib/queries/runs.ts) buckets the whole story as ONE
    // run-detail item and the live panel shows its full 5-node stepper. Concretely: exactly 3
    // attribution buckets (one per story) even though 4 raw_items were recorded — the merged
    // story's non-primary member gets NO steps of its own — and each bucket holds all 5 stage names.
    const stepRows = await db.select({ name: pipelineSteps.name, rawItemId: pipelineSteps.rawItemId })
      .from(pipelineSteps).where(eq(pipelineSteps.runId, runId!));
    const stagesByItem = new Map<string, Set<string>>();
    for (const s of stepRows) {
      if (!s.rawItemId) continue;
      if (!stagesByItem.has(s.rawItemId)) stagesByItem.set(s.rawItemId, new Set());
      stagesByItem.get(s.rawItemId)!.add(s.name);
    }
    expect(stagesByItem.size).toBe(3); // one bucket per story (< 4 recorded raw_items)
    for (const names of stagesByItem.values()) {
      for (const stage of ITEM_STAGES) expect(names.has(stage)).toBe(true); // full 5-node stepper
    }
  }, 20000);
});

// ─────────────────────────────────────────────────────────────────────────────
// SP4 Task 6a review, Finding 3 — stageSources dedupes its sources by URL before inserting
// article_sources, so two grouped members sharing a URL (e.g. one article syndicated through two
// feeds) don't produce duplicate reference entries in the published post. Fully network-free: ALL
// provider keys (incl. embed) stripped → generateArticle + embed both use their built-in mocks,
// so no fixture server is needed.
describe("stageSources dedupes sources by URL (SP4 Task 6a review, Finding 3)", () => {
  const envSnap = snapshotEnv([...PROVIDER_KEYS, ...EMBED_ENV_KEYS]);
  let createdArticleId: string | null = null;
  let createdClusterId: string | null = null;

  beforeAll(() => { for (const k of [...PROVIDER_KEYS, ...EMBED_ENV_KEYS]) delete process.env[k]; });
  afterAll(async () => {
    restoreEnv(envSnap);
    if (createdArticleId) await db.delete(articles).where(eq(articles.id, createdArticleId)); // cascades sources/embeddings/tags
    if (createdClusterId) {
      const stillUsed = await db.select({ id: articles.id }).from(articles).where(eq(articles.clusterId, createdClusterId)).limit(1);
      if (stillUsed.length === 0) await db.delete(clusters).where(eq(clusters.id, createdClusterId));
    }
  });

  it("writes ONE article_sources row per distinct URL, keeping the first occurrence's media name", async () => {
    const url = "https://example.com/syndicated-story";
    const longText = "Texte de source suffisamment long pour la génération d'un article. ".repeat(10);
    const { articleId } = await stageSources(
      [
        { mediaName: "Ecofin", url, text: longText },
        { mediaName: "Jeune Afrique", url, text: longText }, // SAME url, different media — a syndication dup
      ],
      ["Économie"],
    );
    expect(articleId).not.toBeNull();
    createdArticleId = articleId;
    const [a] = await db.select({ clusterId: articles.clusterId }).from(articles).where(eq(articles.id, articleId!));
    createdClusterId = a?.clusterId ?? null;

    const srcs = await db.select().from(articleSources).where(eq(articleSources.articleId, articleId!));
    expect(srcs.length).toBe(1);              // deduped: one row for the single distinct URL
    expect(srcs[0].url).toBe(url);
    expect(srcs[0].mediaName).toBe("Ecofin"); // FIRST occurrence kept
  });
});

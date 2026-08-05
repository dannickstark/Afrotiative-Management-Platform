import { describe, it, expect, afterAll, beforeAll } from "bun:test";
import { db, pipelineRuns, pipelineSteps, articles, clusters, feeds, rawItems, articleSources, pipelineSettings } from "@/db";
import { eq, inArray, like } from "drizzle-orm";

// File-scoped self-heal: a bun-test TIMEOUT in the two-phase cap test below abandons the test
// promise WITHOUT running its `finally`, which can strand a status:"running" pipeline_runs row (+
// "Fixture cap%" fixture rows). On the NEXT invocation, the very first test in this file inserts a
// "running" row directly and would 23505-fail against that stray one — so heal BEFORE any test runs
// here, not just inside the two-phase describe. (`healFixtureResidue`/`reclaimStaleRuns` are hoisted
// module bindings; safe to reference from this top-level hook.)
beforeAll(async () => { await healFixtureResidue(); });

describe("pipeline_runs progress columns + pipeline_steps.at (migration 0003)", () => {
  let runId: string | null = null;
  let bareId: string | null = null;
  afterAll(async () => {
    if (runId) await db.delete(pipelineRuns).where(eq(pipelineRuns.id, runId)); // cascades steps
    if (bareId) await db.delete(pipelineRuns).where(eq(pipelineRuns.id, bareId));
  });

  it("persists and reads back the new progress fields with correct defaults", async () => {
    const [run] = await db.insert(pipelineRuns).values({
      triggeredBy: "manual", status: "running",
      phase: "processing_items", feedsTotal: 6, totalItems: 20,
      processedItems: 8, currentStage: "Génération IA", currentItem: "« Titre test »",
    }).returning({ id: pipelineRuns.id });
    runId = run.id;

    const [row] = await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, runId));
    expect(row.phase).toBe("processing_items");
    expect(row.feedsTotal).toBe(6);
    expect(row.totalItems).toBe(20);
    expect(row.processedItems).toBe(8);
    expect(row.currentStage).toBe("Génération IA");
    expect(row.currentItem).toBe("« Titre test »");

    await db.insert(pipelineSteps).values({ runId, name: "Étape test", status: "success", durationMs: 5 });
    const [step] = await db.select().from(pipelineSteps).where(eq(pipelineSteps.runId, runId));
    expect(step.at).not.toBeNull(); // default now()

    // processed_items default is 0 on a bare insert
    const [bare] = await db.insert(pipelineRuns).values({ triggeredBy: "manual", status: "failed", finishedAt: new Date() }).returning();
    bareId = bare.id; // capture before asserting so afterAll always cleans up, even if the assertion throws
    expect(bare.processedItems).toBe(0);
  });
});

import { stageItem } from "@/lib/pipeline/stages";
import { ITEM_STAGES } from "@/lib/pipeline/live";
import { contentHash, type RawItem } from "@/lib/rss/parse-feed";

const PROVIDER_KEYS = [
  "JINA_API_KEY", "FIRECRAWL_API_KEY", "EMBED_API_KEY", "OPENROUTER_API_KEY",
  "OMNIROUTE_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY",
] as const;
const T = "La BRVM franchit un nouveau record historique";
const HTML = `<html><body><article><h1>${T}</h1><p>${"La bourse régionale progresse fortement, portée par les valeurs bancaires. ".repeat(15)}</p></article></body></html>`;

describe("stageItem live hooks", () => {
  const snap = Object.fromEntries(PROVIDER_KEYS.map((k) => [k, process.env[k]]));
  let server: ReturnType<typeof Bun.serve>;
  let url: string;
  let articleId: string | null = null;
  let clusterId: string | null = null;

  beforeAll(() => {
    for (const k of PROVIDER_KEYS) delete process.env[k];
    server = Bun.serve({ port: 0, fetch: () => new Response(HTML, { headers: { "content-type": "text/html" } }) });
    url = `http://localhost:${server.port}/a`;
  });
  afterAll(async () => {
    server.stop(true);
    for (const [k, v] of Object.entries(snap)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    // FK order: article first (cascades sources/embeddings/tags), then its cluster if now unused.
    if (articleId) await db.delete(articles).where(eq(articles.id, articleId));
    if (clusterId) {
      const stillUsed = await db.select({ id: articles.id }).from(articles).where(eq(articles.clusterId, clusterId)).limit(1);
      if (stillUsed.length === 0) await db.delete(clusters).where(eq(clusters.id, clusterId));
    }
  });

  it("fires onStageStart before each stage and onStageEnd after, in the ACTUAL execution order (ITEM_STAGES names, SP4 Task 6a order)", async () => {
    const item: RawItem = { guid: "test:hooks", url, title: T, contentSnippet: "La bourse progresse.", isoDate: null, contentHash: contentHash(T, "hooks") };
    const starts: string[] = [];
    const ends: string[] = [];
    const res = await stageItem(item, "Test Media", ["Économie"], {
      onStageStart: (n) => { starts.push(n); },
      onStageEnd: (s) => { ends.push(s.name); },
    });
    articleId = res.articleId;
    expect(res.articleId).not.toBeNull();
    if (articleId) {
      const [article] = await db.select({ clusterId: articles.clusterId }).from(articles).where(eq(articles.id, articleId));
      clusterId = article?.clusterId ?? null;
    }
    // SP4 Task 6a's stageSources embeds the GENERATED title+body (not the raw source text), so
    // génération now runs BEFORE embedding/clustering — see the ORDER NOTE on stageSources in
    // lib/pipeline/stages.ts. The SET of 5 stage names is unchanged (still exactly ITEM_STAGES,
    // which drives the live stepper's fixed 5 slots), only the chronological order differs.
    const expectedOrder = [
      "Extraction du contenu", "Génération IA", "Calcul de l'embedding", "Regroupement (clustering)", "Dépôt en revue",
    ];
    expect(new Set(starts)).toEqual(new Set(ITEM_STAGES));
    expect(starts).toEqual(expectedOrder);
    expect(ends).toEqual(expectedOrder);
  });
});

import { openRun, executeRun } from "@/lib/pipeline/run";
import { reclaimStaleRuns } from "@/lib/pipeline/overlap";
import { getActiveRun } from "@/lib/queries/runs";

// Self-heal any residue a PRIOR aborted run of this suite may have left. A bun-test TIMEOUT (unlike
// a JS throw) abandons the test promise WITHOUT running the per-test `finally`, which can strand a
// status:"running" pipeline_runs row (blocking every later openRun/runPipeline for up to
// RUN_STALE_MINUTES and cascading failures into the same `bun test` invocation) plus leftover
// "Fixture cap%" feeds and their raw_items. Running this before AND after the suite makes it
// order- and rerun-independent, without disturbing the per-test `finally` cleanup below.
async function healFixtureResidue(): Promise<void> {
  await reclaimStaleRuns(); // finalizes any genuinely stale (>threshold) running row to "failed"
  // A *recent* stray fixture run (from a timed-out prior run of the two-phase test) isn't old
  // enough for reclaimStaleRuns to catch, yet its still-"running" row holds the one-running slot.
  // Delete it — but ONLY runs this fixture owns, never a real in-flight run or another test's
  // deliberate running row. A fixture run is identifiable by the feed-read step it inserts at the
  // very start of phase 1 (long before the slow phase-2 staging), whose name references the
  // "Fixture cap …" feed. Deleting those run rows cascades their pipeline_steps.
  const strayRunIds = await db.select({ id: pipelineSteps.runId }).from(pipelineSteps)
    .where(like(pipelineSteps.name, "Lecture du flux « Fixture cap%"));
  if (strayRunIds.length) await db.delete(pipelineRuns).where(inArray(pipelineRuns.id, strayRunIds.map((r) => r.id)));
  const strays = await db.select({ id: feeds.id }).from(feeds).where(like(feeds.name, "Fixture cap%"));
  for (const s of strays) {
    await db.delete(rawItems).where(eq(rawItems.feedId, s.id));
    await db.delete(feeds).where(eq(feeds.id, s.id));
  }
}

// A feed fixture that serves an RSS document with N distinct items pointing at a local article
// server. Exposes `articleBase` (not just `rssUrl`) so tests can find + clean up every article
// staged from it via article_sources.url LIKE `${articleBase}%`.
function rssServer(itemCount: number) {
  const article = Bun.serve({ port: 0, fetch: () => new Response(HTML, { headers: { "content-type": "text/html" } }) });
  const items = Array.from({ length: itemCount }, (_, i) => `
    <item><title>${T} #${i}</title><link>http://localhost:${article.port}/a${i}</link>
    <guid>test:exec:${i}:${Math.random()}</guid><description>Bourse ${i}</description></item>`).join("");
  const rss = Bun.serve({ port: 0, fetch: () => new Response(
    `<?xml version="1.0"?><rss version="2.0"><channel><title>Fixture</title>${items}</channel></rss>`,
    { headers: { "content-type": "application/xml" } }) });
  return {
    rssUrl: `http://localhost:${rss.port}/feed`,
    articleBase: `http://localhost:${article.port}`,
    stop: () => { article.stop(true); rss.stop(true); },
  };
}

describe("executeRun two-phase progress + cap", () => {
  const snap = Object.fromEntries(PROVIDER_KEYS.map((k) => [k, process.env[k]]));
  beforeAll(async () => { for (const k of PROVIDER_KEYS) delete process.env[k]; await healFixtureResidue(); });
  afterAll(async () => {
    for (const [k, v] of Object.entries(snap)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    await healFixtureResidue();
  });

  it("reads all feeds, caps recorded items, records ONLY what it processes, and lands progress fields", async () => {
    // The cap now comes from the DB-backed pipeline_settings singleton (SP1's executeRun wiring),
    // not the env var — drive it via row id=1. It's a shared row (a real admin-configured value
    // may exist), so snapshot before mutating and restore exactly (present or absent) in `finally`.
    const [settingsSnapshot] = await db.select().from(pipelineSettings).where(eq(pipelineSettings.id, 1));
    await db.insert(pipelineSettings).values({ id: 1, maxItemsPerRun: 2 })
      .onConflictDoUpdate({ target: pipelineSettings.id, set: { maxItemsPerRun: 2 } });
    const fx = rssServer(4); // 4 new items, cap 2 — two full stageItem passes, so allow more than the 5s default.
    const [f] = await db.insert(feeds).values({ name: "Fixture cap", feedUrl: fx.rssUrl, active: true }).returning({ id: feeds.id });
    let runId: string | null = null;
    try {
      runId = await openRun({ triggeredBy: "manual", feedsTotal: 1 });
      expect(runId).not.toBeNull();
      const res = await executeRun(runId!, { feedIds: [f.id] });

      expect(res.status).toBe("partial");           // cap hit → partial
      const [row] = await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, runId!));
      expect(row.phase).toBe("finalizing");
      expect(row.totalItems).toBe(2);               // exact denominator after phase 1
      expect(row.processedItems).toBe(2);
      expect(row.currentStage).toBeNull();          // pointer cleared on finalize
      expect(row.finishedAt).not.toBeNull();

      const steps = await db.select().from(pipelineSteps).where(eq(pipelineSteps.runId, runId!));
      expect(steps.some((s) => s.name === "Limite d'éléments atteinte")).toBe(true);
      expect(steps.some((s) => s.name.startsWith("Lecture du flux"))).toBe(true);

      // "record only what we process": exactly 2 raw_items for this feed, not 4.
      const recorded = await db.select().from(rawItems).where(eq(rawItems.feedId, f.id));
      expect(recorded.length).toBe(2);
    } finally {
      await db.delete(pipelineSettings).where(eq(pipelineSettings.id, 1));
      if (settingsSnapshot) await db.insert(pipelineSettings).values(settingsSnapshot);
      fx.stop();

      // Full FK-safe cleanup — this test must leave the DB exactly as it found it.
      // (1) Find articles staged from this fixture's article server, capture their clusterIds,
      //     then delete the articles (cascades article_sources/article_embeddings/article_tags).
      const sources = await db.select({ articleId: articleSources.articleId })
        .from(articleSources).where(like(articleSources.url, `${fx.articleBase}%`));
      const articleIds = sources.map((s) => s.articleId);
      let clusterIds: string[] = [];
      if (articleIds.length > 0) {
        const staged = await db.select({ clusterId: articles.clusterId }).from(articles).where(inArray(articles.id, articleIds));
        clusterIds = staged.map((a) => a.clusterId).filter((c): c is string => c !== null);
        await db.delete(articles).where(inArray(articles.id, articleIds));
      }
      // (2) Delete now-orphaned clusters (no article references them anymore).
      for (const clusterId of clusterIds) {
        const stillUsed = await db.select({ id: articles.id }).from(articles).where(eq(articles.clusterId, clusterId)).limit(1);
        if (stillUsed.length === 0) await db.delete(clusters).where(eq(clusters.id, clusterId));
      }
      // (3) raw_items recorded for the fixture feed.
      await db.delete(rawItems).where(eq(rawItems.feedId, f.id));
      // (4) the run row (cascades pipeline_steps).
      if (runId) await db.delete(pipelineRuns).where(eq(pipelineRuns.id, runId));
      // (5) the feed itself.
      await db.delete(feeds).where(eq(feeds.id, f.id));
    }
  }, 20000);
});

describe("getActiveRun", () => {
  let runId: string | null = null;
  afterAll(async () => { if (runId) await db.delete(pipelineRuns).where(eq(pipelineRuns.id, runId)); });

  it("returns null when nothing is running", async () => {
    // (assumes no run is active in the dev DB at this point in the suite)
    expect(await getActiveRun()).toBeNull();
  });

  it("returns the running run with progress fields and grouped steps", async () => {
    const [run] = await db.insert(pipelineRuns).values({
      triggeredBy: "manual", status: "running", phase: "processing_items",
      feedsTotal: 1, totalItems: 3, processedItems: 1, currentStage: "Génération IA", currentItem: "« X »",
    }).returning({ id: pipelineRuns.id });
    runId = run.id;
    await db.insert(pipelineSteps).values([
      { runId, name: "Lecture du flux « A »", status: "success", durationMs: 5 },
      { runId, name: "Extraction du contenu", status: "success", durationMs: 7, rawItemId: null },
    ]);

    const active = await getActiveRun();
    expect(active).not.toBeNull();
    expect(active!.run.id).toBe(runId);
    expect(active!.run.currentStage).toBe("Génération IA");
    expect(active!.run.processedItems).toBe(1);
    expect(active!.feedSteps.length).toBeGreaterThanOrEqual(1);
  });
});

describe("openRun overlap", () => {
  it("returns null when a run is already active", async () => {
    const [run] = await db.insert(pipelineRuns).values({ triggeredBy: "scheduled", status: "running" }).returning({ id: pipelineRuns.id });
    try {
      expect(await openRun({ triggeredBy: "manual" })).toBeNull();
    } finally {
      await db.delete(pipelineRuns).where(eq(pipelineRuns.id, run.id));
    }
  });
});

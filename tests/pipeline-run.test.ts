import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { db, articles, articleSources, articleEmbeddings, clusters, feeds, pipelineRuns, pipelineSteps } from "@/db";
import { eq, sql } from "drizzle-orm";
import { stageItem } from "@/lib/pipeline/stages";
import { runPipeline } from "@/lib/pipeline/run";
import { hasRunningRun } from "@/lib/pipeline/overlap";
import { contentHash, type RawItem } from "@/lib/rss/parse-feed";

const TITLE = "La BRVM franchit un nouveau record historique";
const BODY_SENTENCE = "La bourse régionale ouest-africaine enregistre une progression continue portée par le secteur bancaire et les valeurs minières. ";
const FIXTURE_HTML = `<html><head><title>Ignoré</title></head><body><article>
  <h1>${TITLE}</h1>
  <p>${BODY_SENTENCE.repeat(15)}</p>
</article></body></html>`;

// The set of provider credentials deleted for the duration of a network-free test, so
// extract()/embed()/generateArticle() fall onto their readability/mock fallbacks instead of
// calling real APIs (this project's .env.local has live keys). Same pattern already used in
// tests/extract-chain.test.ts and tests/ai-fallback.test.ts.
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

// ─────────────────────────────────────────────────────────────────────────────
// End-to-end (real Neon DB) but network-free: a tiny local Bun.serve fixture stands in for the
// source article, and every external provider is forced onto its credential-free fallback so no
// real network call is made (only loopback traffic to the fixture server).
describe("stageItem (end-to-end, network-free)", () => {
  const original = snapshotEnv(PROVIDER_KEYS);
  let server: ReturnType<typeof Bun.serve>;
  let articleUrl: string;
  let createdArticleId: string | null = null;
  let createdClusterId: string | null = null;

  beforeAll(() => {
    for (const k of PROVIDER_KEYS) delete process.env[k];
    server = Bun.serve({ port: 0, fetch: () => new Response(FIXTURE_HTML, { headers: { "content-type": "text/html" } }) });
    articleUrl = `http://localhost:${server.port}/article`;
  });

  afterAll(async () => {
    server.stop(true);
    restoreEnv(original);
    // FK order: article first (cascades article_sources/article_embeddings/article_tags).
    if (createdArticleId) await db.delete(articles).where(eq(articles.id, createdArticleId));
    if (createdClusterId) {
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
    // SP4 Task 6a reordered stageSources's internal steps: génération now runs BEFORE embedding/
    // clustering (it embeds the GENERATED title+body, which requires a draft to exist first —
    // see the ORDER NOTE on stageSources in lib/pipeline/stages.ts), not after as before Task 6a.
    expect(steps.map((s) => s.name)).toEqual([
      "Extraction du contenu", "Génération IA", "Calcul de l'embedding", "Regroupement (clustering)", "Dépôt en revue",
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

// ─────────────────────────────────────────────────────────────────────────────
// Verifies the db.transaction() rollback in stageItem's "Dépôt en revue" step: a failure while
// writing the article's rows must leave NO orphaned article/cluster behind. We inject the failure
// realistically — EMBED_DIMENSIONS=512 makes the mock embedder produce a 512-dim vector, which the
// article_embeddings insert (a vector(1024) column) rejects with a dimension mismatch. That insert
// runs AFTER the cluster + article + source inserts inside the same transaction, so a correct
// rollback must undo all of them. (Separate describe so the first suite's afterAll has already
// deleted its 1024-dim embedding — otherwise decideCluster would hit the mismatch first, before
// the transaction is ever entered, and we wouldn't be exercising the rollback path.)
describe("stageItem transaction rollback (no orphaned rows on mid-transaction failure)", () => {
  const original = snapshotEnv([...PROVIDER_KEYS, "EMBED_DIMENSIONS"]);
  let server: ReturnType<typeof Bun.serve>;
  let articleUrl: string;

  beforeAll(() => {
    for (const k of PROVIDER_KEYS) delete process.env[k];
    process.env.EMBED_DIMENSIONS = "512"; // wrong dim → article_embeddings insert fails inside the tx
    server = Bun.serve({ port: 0, fetch: () => new Response(FIXTURE_HTML, { headers: { "content-type": "text/html" } }) });
    articleUrl = `http://localhost:${server.port}/article`;
  });

  afterAll(() => {
    server.stop(true);
    restoreEnv(original);
  });

  it("rolls back the article + cluster when the embedding insert fails inside the transaction", async () => {
    const beforeArticles = await db.$count(articles);
    const beforeClusters = await db.$count(clusters);

    const item: RawItem = {
      guid: "test:pipeline-run:rollback",
      url: articleUrl,
      title: TITLE,
      contentSnippet: "La bourse régionale progresse fortement.",
      isoDate: new Date().toISOString(),
      contentHash: contentHash(TITLE, "rollback-variant"),
    };

    const { articleId, steps } = await stageItem(item, "Test Media", ["Économie", "Marchés"]);

    // Aborted, and the abort happened at the transactional write step (not earlier), proving we
    // actually entered and rolled back the transaction.
    expect(articleId).toBeNull();
    const failed = steps.find((s) => s.status === "failed");
    expect(failed?.name).toBe("Dépôt en revue");

    // The decisive assertion: no rows leaked past the rollback.
    expect(await db.$count(articles)).toBe(beforeArticles);
    expect(await db.$count(clusters)).toBe(beforeClusters);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Overlap guard (both layers).
describe("runPipeline overlap guard", () => {
  let manualRunId: string | null = null;

  afterAll(async () => {
    if (manualRunId) await db.delete(pipelineRuns).where(eq(pipelineRuns.id, manualRunId));
  });

  it("returns 'skipped' (app check) and the DB partial unique index blocks a 2nd running row", async () => {
    const [run] = await db.insert(pipelineRuns).values({ triggeredBy: "scheduled", status: "running" }).returning({ id: pipelineRuns.id });
    manualRunId = run.id;

    expect(await hasRunningRun()).toBe(true);

    // App-level backstop: runPipeline bails out before opening a second run.
    const res = await runPipeline({ triggeredBy: "manual" });
    expect(res).toEqual({ runId: null, status: "skipped", produced: 0 });

    // DB-level interlock: a direct second "running" insert violates pipeline_runs_one_running.
    // Drizzle wraps the pg error in DrizzleQueryError, so the SQLSTATE is on `.cause`.
    let code: string | undefined;
    try {
      await db.insert(pipelineRuns).values({ triggeredBy: "manual", status: "running" });
    } catch (e) {
      code = (e as { code?: string }).code ?? (e as { cause?: { code?: string } }).cause?.code;
    }
    expect(code).toBe("23505");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Always-finalize: even when a feed can't be read, the run row must reach a terminal status (never
// stuck "running") and the overlap slot must be freed. Uses a connection-refused feed URL so
// parseFeed fails deterministically offline (no external network).
describe("runPipeline always finalizes the run row", () => {
  let feedId: string;
  let runId: string | null = null;

  beforeAll(async () => {
    const [f] = await db.insert(feeds).values({
      name: "Flux injoignable (test)", feedUrl: "http://127.0.0.1:1/rss", active: true,
    }).returning({ id: feeds.id });
    feedId = f.id;
  });

  afterAll(async () => {
    if (runId) await db.delete(pipelineRuns).where(eq(pipelineRuns.id, runId)); // cascades pipeline_steps
    await db.delete(feeds).where(eq(feeds.id, feedId));
  });

  it("finalizes to 'failed' with finishedAt set and frees the running slot when a feed can't be read", async () => {
    expect(await hasRunningRun()).toBe(false);

    const res = await runPipeline({ triggeredBy: "manual", feedIds: [feedId] });
    runId = res.runId;

    expect(res.runId).not.toBeNull();
    expect(res.status).toBe("failed"); // the only feed failed to parse → allFeedsFailed
    expect(res.produced).toBe(0);

    const [row] = await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, res.runId!));
    expect(row.status).toBe("failed");
    expect(row.finishedAt).not.toBeNull(); // run row never left "running"

    // A failed feed still records its own failed step for the operator.
    const steps = await db.execute(sql`select 1 from pipeline_steps where run_id = ${res.runId!} and status = 'failed'`);
    expect(steps.rows.length).toBeGreaterThan(0);

    // Slot is free again — the next run is not blocked.
    expect(await hasRunningRun()).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Stale-run reaper: a hard process kill (route maxDuration timeout, deploy, OOM) skips
// runPipeline's try/finally, leaving a pipeline_runs row stuck "running" forever — after which
// hasRunningRun() would always be true and the pipeline_runs_one_running unique index would
// block every future run with no recovery. hasRunningRun() must reclaim (finalize to "failed")
// any "running" row older than RUN_STALE_MINUTES (default 15) before answering. Network-free:
// only touches the real Neon DB, no external HTTP.
describe("hasRunningRun reclaims stale running rows", () => {
  let staleRunId: string | null = null;

  afterAll(async () => {
    if (staleRunId) await db.delete(pipelineRuns).where(eq(pipelineRuns.id, staleRunId));
  });

  it("finalizes a 'running' row older than the stale threshold to 'failed', freeing the slot", async () => {
    const [run] = await db.insert(pipelineRuns).values({
      triggeredBy: "scheduled",
      status: "running",
      startedAt: new Date(Date.now() - 30 * 60_000), // 30 min ago — past the 15-min default threshold
    }).returning({ id: pipelineRuns.id });
    staleRunId = run.id;

    // Precondition: the raw row really is "running" before the reclaim runs.
    const [before] = await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, staleRunId));
    expect(before.status).toBe("running");
    expect(before.finishedAt).toBeNull();

    // hasRunningRun() reclaims stale rows first, then answers — a stale row must not count as
    // "genuinely running", so this must return false even though a "running" row exists.
    expect(await hasRunningRun()).toBe(false);

    const [after] = await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, staleRunId));
    expect(after.status).toBe("failed");
    expect(after.finishedAt).not.toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Activity-based reclaim: startPipelineRun (lib/actions/pipeline-actions.ts) fires executeRun
// DETACHED, so a manual run has no maxDuration ceiling — a legitimately long-running run can
// outlive RUN_STALE_MINUTES while still alive. reclaimStaleRuns() must NOT reap a "running" row
// whose startedAt is past the stale cutoff if it has produced a pipeline_steps row recently
// (executeRun inserts steps every few seconds while alive) — only age-AND-no-recent-activity
// counts as dead.
describe("hasRunningRun does not reclaim a stale-by-age row with recent step activity", () => {
  let liveRunId: string | null = null;

  afterAll(async () => {
    // Cascades pipeline_steps (run_id FK is ON DELETE CASCADE).
    if (liveRunId) await db.delete(pipelineRuns).where(eq(pipelineRuns.id, liveRunId));
  });

  it("leaves the row 'running' when a recent pipeline_steps row proves it's still alive", async () => {
    const [run] = await db.insert(pipelineRuns).values({
      triggeredBy: "manual",
      status: "running",
      startedAt: new Date(Date.now() - 30 * 60_000), // 30 min ago — past the 15-min default threshold
    }).returning({ id: pipelineRuns.id });
    liveRunId = run.id;

    // A step inserted just now — proof of life despite the old startedAt.
    await db.insert(pipelineSteps).values({
      runId: liveRunId, name: "Lecture du flux « Test »", status: "success", durationMs: 10, at: new Date(),
    });

    // Must NOT be reclaimed: recent activity overrides the age-based cutoff.
    expect(await hasRunningRun()).toBe(true);

    const [after] = await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, liveRunId));
    expect(after.status).toBe("running");
    expect(after.finishedAt).toBeNull();
  });
});

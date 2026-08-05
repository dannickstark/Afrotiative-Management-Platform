import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import {
  db, articles, articleSources, clusters, feeds, rawItems, pipelineRuns, pipelineSteps,
} from "@/db";
import { and, eq, inArray, isNull, like } from "drizzle-orm";
import { can } from "@/lib/rbac";
import { openRun, executeRun } from "@/lib/pipeline/run";
import { hasRunningRun } from "@/lib/pipeline/overlap";

// ─────────────────────────────────────────────────────────────────────────────
// SP5 Task 3 — Stop/cancel a running pipeline run. Real Neon dev DB, network-free: every external
// provider (LLM + embedding + extraction) is forced onto its credential-free fallback via
// provider-key stripping (same pattern as tests/pipeline-run.test.ts, tests/pipeline-grouping.
// test.ts, tests/pipeline-timeout.test.ts), and local Bun.serve fixtures stand in for RSS feeds and
// source articles — no real network call is ever made.

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

// FK-safe cleanup for any article(s) staged from a fixture article server, mirroring the pattern
// used throughout tests/pipeline-grouping.test.ts / tests/live-progress.test.ts.
async function cleanupArticlesFrom(articleBase: string): Promise<void> {
  const sources = await db.select({ articleId: articleSources.articleId })
    .from(articleSources).where(like(articleSources.url, `${articleBase}%`));
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
}

// ─────────────────────────────────────────────────────────────────────────────
// Checkpoint (a) — "after phase 1 (read+group) / before phase 2 begins": the cancel_requested flag
// is already true by the time executeRun is invoked at all, so it MUST be observed at the very
// first opportunity, before a single story is processed. Deliberately the simplest possible
// fixture (a single new candidate, no article server needed at all — extraction is never reached).
describe("executeRun cooperative cancel — checkpoint (a): before phase 2 begins", () => {
  const envSnap = snapshotEnv(PROVIDER_KEYS);
  let rss: ReturnType<typeof Bun.serve>;
  let feedId: string;

  beforeAll(async () => {
    for (const k of PROVIDER_KEYS) delete process.env[k]; // grouping's embed() falls to its mock
    const guid = `test:cancel-a:${Math.random()}`;
    const body = `<?xml version="1.0"?><rss version="2.0"><channel><title>Fixture cancel A</title>
      <item><title>Histoire jamais traitée (annulée avant la phase 2)</title>
      <link>https://example.invalid/never-fetched</link>
      <guid>${guid}</guid><description>Cette histoire ne doit jamais être extraite.</description></item>
    </channel></rss>`;
    rss = Bun.serve({ port: 0, fetch: () => new Response(body, { headers: { "content-type": "application/xml" } }) });
    const [f] = await db.insert(feeds).values({ name: "Fixture cancel A", feedUrl: `http://localhost:${rss.port}/feed`, active: true }).returning({ id: feeds.id });
    feedId = f.id;
  });

  afterAll(async () => {
    rss.stop(true);
    restoreEnv(envSnap);
    await db.delete(rawItems).where(eq(rawItems.feedId, feedId));
    await db.delete(feeds).where(eq(feeds.id, feedId));
  });

  it("finalizes to 'cancelled', frees the interlock, and processes zero stories", async () => {
    let runId: string | null = null;
    let secondRunId: string | null = null;
    try {
      runId = await openRun({ triggeredBy: "manual", feedsTotal: 1 });
      expect(runId).not.toBeNull();

      // Mirrors cancelRun's DB write (the action itself can't be invoked outside a Next.js request
      // scope — see the "cancelRun's DB mechanism" describe below). Set BEFORE executeRun even
      // starts, so it is guaranteed to be observed by the checkpoint (a) re-read.
      await db.update(pipelineRuns).set({ cancelRequested: true }).where(eq(pipelineRuns.id, runId!));

      const res = await executeRun(runId!, { feedIds: [feedId] });

      expect(res.status).toBe("cancelled");
      expect(res.produced).toBe(0);

      const [row] = await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, runId!));
      expect(row.status).toBe("cancelled");
      expect(row.finishedAt).not.toBeNull();  // terminal — interlock slot freed
      expect(row.currentStage).toBeNull();
      expect(row.currentItem).toBeNull();
      expect(row.totalItems).toBe(1);          // phase 1 + grouping DID complete (1 candidate → 1 group)
      expect(row.processedItems).toBe(0);      // but NO story was processed — stopped at checkpoint (a)

      // The story's member was never recordRawItem()'d — it resurfaces as a fresh candidate on the
      // next run, exactly like any other un-processed story.
      const recorded = await db.select().from(rawItems).where(eq(rawItems.feedId, feedId));
      expect(recorded.length).toBe(0);

      // The neutral French cancellation step was recorded.
      const steps = await db.select().from(pipelineSteps).where(eq(pipelineSteps.runId, runId!));
      const cancelStep = steps.find((s) => s.name === "Exécution annulée par l'utilisateur");
      expect(cancelStep).toBeDefined();
      expect(cancelStep!.status).toBe("partial");

      // Interlock: the slot is freed — a genuinely NEW run can open right after.
      expect(await hasRunningRun()).toBe(false);
      secondRunId = await openRun({ triggeredBy: "manual" });
      expect(secondRunId).not.toBeNull();
    } finally {
      if (secondRunId) await db.delete(pipelineRuns).where(eq(pipelineRuns.id, secondRunId));
      if (runId) await db.delete(pipelineRuns).where(eq(pipelineRuns.id, runId)); // cascades pipeline_steps
    }
  }, 20000);
});

// ─────────────────────────────────────────────────────────────────────────────
// Checkpoint (b) — "at the top of each story iteration": cancel_requested flips to true DURING
// story A's own processing (as a side effect of its extraction fetch, so the ordering is causal,
// never timing-dependent/racy) — proving story A still completes in full, while story B (queued
// right after it) is never even started. This is the "≥2 stories, cancel lands between them"
// variant the plan calls out as an alternative to checkpoint (a) alone.
const TITLE_A = "Une fusion bancaire régionale est annoncée (histoire déclencheuse)";
const TITLE_B = "Une histoire qui ne doit jamais être traitée (contrôle)";
const BODY_SENTENCE = "Contenu détaillé de l'article couvrant l'actualité économique régionale. ";
const ARTICLE_HTML = (title: string) => `<html><head><title>Ignoré</title></head><body><article>
  <h1>${title}</h1>
  <p>${BODY_SENTENCE.repeat(15)}</p>
</article></body></html>`;

function cancelMidRunFixture() {
  let capturedRunId: string | null = null;
  let controlFetched = false;
  const article = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const url = new URL(req.url);
      if (url.pathname === "/trigger") {
        // Deterministic, non-racy: this side effect runs IN-PROCESS, synchronously awaited by
        // story A's own extraction call — so it lands strictly before phase 2's next loop
        // iteration (story B) can begin, with no reliance on timers/sleeps.
        if (capturedRunId) {
          await db.update(pipelineRuns).set({ cancelRequested: true }).where(eq(pipelineRuns.id, capturedRunId));
        }
        return new Response(ARTICLE_HTML(TITLE_A), { headers: { "content-type": "text/html" } });
      }
      controlFetched = true; // must NEVER happen — story B must never reach extraction
      return new Response(ARTICLE_HTML(TITLE_B), { headers: { "content-type": "text/html" } });
    },
  });
  const items = [
    { title: TITLE_A, path: "/trigger", desc: "Une fusion bancaire majeure vient d'être annoncée." },
    { title: TITLE_B, path: "/control", desc: "Cette histoire ne doit jamais être traitée." },
  ];
  const rssItems = items.map((d, i) => `
    <item><title>${d.title}</title><link>http://localhost:${article.port}${d.path}</link>
    <guid>test:cancel-b:${i}:${Math.random()}</guid><description>${d.desc}</description></item>`).join("");
  const rss = Bun.serve({ port: 0, fetch: () => new Response(
    `<?xml version="1.0"?><rss version="2.0"><channel><title>Fixture cancel B</title>${rssItems}</channel></rss>`,
    { headers: { "content-type": "application/xml" } }) });
  return {
    rssUrl: `http://localhost:${rss.port}/feed`,
    articleBase: `http://localhost:${article.port}`,
    setRunId: (id: string) => { capturedRunId = id; },
    wasControlFetched: () => controlFetched,
    stop: () => { article.stop(true); rss.stop(true); },
  };
}

describe("executeRun cooperative cancel — checkpoint (b): between two stories", () => {
  const envSnap = snapshotEnv(PROVIDER_KEYS);
  let fx: ReturnType<typeof cancelMidRunFixture>;
  let feedId: string;

  beforeAll(async () => {
    for (const k of PROVIDER_KEYS) delete process.env[k];
    fx = cancelMidRunFixture();
    const [f] = await db.insert(feeds).values({ name: "Fixture cancel B", feedUrl: fx.rssUrl, active: true }).returning({ id: feeds.id });
    feedId = f.id;
  });

  afterAll(async () => {
    fx.stop();
    restoreEnv(envSnap);
    await cleanupArticlesFrom(fx.articleBase);
    await db.delete(rawItems).where(eq(rawItems.feedId, feedId));
    await db.delete(feeds).where(eq(feeds.id, feedId));
  });

  it("fully processes story A (which triggers the cancel), never touches story B, and finalizes 'cancelled'", async () => {
    let runId: string | null = null;
    let secondRunId: string | null = null;
    try {
      runId = await openRun({ triggeredBy: "manual", feedsTotal: 1 });
      expect(runId).not.toBeNull();
      fx.setRunId(runId!);

      const res = await executeRun(runId!, { feedIds: [feedId] });

      expect(res.status).toBe("cancelled");
      expect(fx.wasControlFetched()).toBe(false); // story B's article URL was never fetched

      const [row] = await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, runId!));
      expect(row.status).toBe("cancelled");
      expect(row.finishedAt).not.toBeNull();
      expect(row.currentStage).toBeNull();
      expect(row.currentItem).toBeNull();
      expect(row.totalItems).toBe(2);        // 2 distinct stories grouped in phase 1
      expect(row.processedItems).toBe(1);    // only story A, processed BEFORE the mid-loop cancel

      // Story A's member was recorded (it was actually processed); story B's was NOT — it
      // resurfaces as a fresh candidate on a future run.
      const recorded = await db.select().from(rawItems).where(eq(rawItems.feedId, feedId));
      expect(recorded.length).toBe(1);
      expect(recorded[0].rawTitle).toBe(TITLE_A);

      // Story A really did produce a pending article (human-review barrier intact).
      const producedSources = await db.select().from(articleSources).where(like(articleSources.url, `${fx.articleBase}%`));
      expect(producedSources.length).toBe(1);
      const [producedArticle] = await db.select().from(articles).where(eq(articles.id, producedSources[0].articleId));
      expect(producedArticle.status).toBe("pending");

      const steps = await db.select().from(pipelineSteps).where(eq(pipelineSteps.runId, runId!));
      expect(steps.some((s) => s.name === "Exécution annulée par l'utilisateur")).toBe(true);

      expect(await hasRunningRun()).toBe(false);
      secondRunId = await openRun({ triggeredBy: "manual" });
      expect(secondRunId).not.toBeNull(); // interlock freed
    } finally {
      if (secondRunId) await db.delete(pipelineRuns).where(eq(pipelineRuns.id, secondRunId));
      if (runId) await db.delete(pipelineRuns).where(eq(pipelineRuns.id, runId));
    }
  }, 20000);
});

// ─────────────────────────────────────────────────────────────────────────────
// cancelRun (lib/actions/pipeline-actions.ts) is RBAC-guarded (pipeline:configure).
describe("cancelRun authz", () => {
  it("only admin may cancel a run", () => {
    expect(can("admin", "pipeline", "configure")).toBe(true);
    expect(can("editor", "pipeline", "configure")).toBe(false);
    expect(can("journalist", "pipeline", "configure")).toBe(false);
  });
});

// cancelRun itself starts with requireUser() → next/headers(), which needs a real Next.js request
// context unavailable under plain `bun test` — verified empirically (throws "`headers` was called
// outside a request scope"), same constraint documented in tests/reprocess.test.ts and
// tests/feed-actions.test.ts for their own RBAC-guarded actions. So this exercises the EXACT
// drizzle predicates cancelRun runs. SP5 Task 4 review I4/C2 split cancelRun into two status-guarded
// branches: a PAUSED target is FINALIZED directly (there is no in-flight executeRun to observe a
// flag), a RUNNING target gets cancel_requested=true (cooperative, Task 3). Both are true no-ops on
// an already-terminal row.
describe("cancelRun's DB mechanism (real Neon, network-free)", () => {
  it("sets cancel_requested=true on an active 'running' run (cooperative branch)", async () => {
    const [run] = await db.insert(pipelineRuns).values({ triggeredBy: "manual", status: "running" }).returning({ id: pipelineRuns.id });
    try {
      const updated = await db.update(pipelineRuns).set({ cancelRequested: true })
        .where(and(eq(pipelineRuns.id, run.id), eq(pipelineRuns.status, "running"), isNull(pipelineRuns.finishedAt)))
        .returning({ id: pipelineRuns.id });
      expect(updated.length).toBe(1);

      const [row] = await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, run.id));
      expect(row.cancelRequested).toBe(true);
    } finally {
      await db.delete(pipelineRuns).where(eq(pipelineRuns.id, run.id));
    }
  });

  it("FINALIZES a 'paused' run directly (Stop on a paused run) — SP5 Task 4 review I4/C2", async () => {
    // A paused run has no in-flight executeRun to observe a cooperative flag, so cancelRun's paused
    // branch finalizes it directly (status='cancelled' + finished_at, clearing checkpoint/flags) —
    // this is the exact status-guarded UPDATE cancelRun now runs for a paused target. Freeing the
    // interlock slot is what lets Task 5's Stop button work on a paused run (and recovers any
    // stranded paused run).
    const [run] = await db.insert(pipelineRuns).values({
      triggeredBy: "manual", status: "paused", pauseRequested: true, checkpoint: { stories: [] },
    }).returning({ id: pipelineRuns.id });
    try {
      const finalized = await db.update(pipelineRuns)
        .set({ status: "cancelled", finishedAt: new Date(), checkpoint: null, pauseRequested: false, cancelRequested: false })
        .where(and(eq(pipelineRuns.id, run.id), eq(pipelineRuns.status, "paused")))
        .returning({ id: pipelineRuns.id });
      expect(finalized.length).toBe(1);

      const [row] = await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, run.id));
      expect(row.status).toBe("cancelled");
      expect(row.finishedAt).not.toBeNull(); // terminal — interlock slot freed
      expect(row.checkpoint).toBeNull();
      expect(row.pauseRequested).toBe(false);
    } finally {
      await db.delete(pipelineRuns).where(eq(pipelineRuns.id, run.id));
    }
  });

  it("no-ops (0 rows touched) on an already-terminal run — both branches miss", async () => {
    const [run] = await db.insert(pipelineRuns).values({
      triggeredBy: "manual", status: "success", finishedAt: new Date(),
    }).returning({ id: pipelineRuns.id });
    try {
      // Paused branch: WHERE status='paused' → 0 rows on a 'success' row.
      const finalizedPaused = await db.update(pipelineRuns)
        .set({ status: "cancelled", finishedAt: new Date(), checkpoint: null, pauseRequested: false, cancelRequested: false })
        .where(and(eq(pipelineRuns.id, run.id), eq(pipelineRuns.status, "paused")))
        .returning({ id: pipelineRuns.id });
      expect(finalizedPaused.length).toBe(0);
      // Running branch: WHERE status='running' AND finished_at IS NULL → 0 rows too.
      const flagged = await db.update(pipelineRuns).set({ cancelRequested: true })
        .where(and(eq(pipelineRuns.id, run.id), eq(pipelineRuns.status, "running"), isNull(pipelineRuns.finishedAt)))
        .returning({ id: pipelineRuns.id });
      expect(flagged.length).toBe(0); // matches cancelRun's { ok: false, message: "L'exécution est déjà terminée." } path

      const [row] = await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, run.id));
      expect(row.status).toBe("success"); // untouched
      expect(row.cancelRequested).toBe(false); // untouched
    } finally {
      await db.delete(pipelineRuns).where(eq(pipelineRuns.id, run.id));
    }
  });
});

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import {
  db, articles, articleSources, clusters, feeds, rawItems, pipelineRuns, pipelineSteps,
  type RunCheckpoint,
} from "@/db";
import { and, eq, inArray, isNull, like } from "drizzle-orm";
import { can } from "@/lib/rbac";
import { openRun, executeRun } from "@/lib/pipeline/run";
import { hasRunningRun, reclaimStaleRuns } from "@/lib/pipeline/overlap";
import { getActiveRun } from "@/lib/queries/runs";

// ─────────────────────────────────────────────────────────────────────────────
// SP5 Task 4 — Pause a running pipeline run (checkpoint) and Resume it later. Real Neon dev DB,
// network-free: every external provider (LLM + embedding + extraction) is forced onto its
// credential-free fallback via provider-key stripping (same pattern as tests/pipeline-cancel.
// test.ts / tests/pipeline-grouping.test.ts), and local Bun.serve fixtures stand in for RSS feeds
// and source articles — no real network call is ever made.

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
// used throughout tests/pipeline-cancel.test.ts / tests/pipeline-grouping.test.ts.
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

const BODY_SENTENCE = "Contenu détaillé de l'article couvrant l'actualité économique régionale. ";
const ARTICLE_HTML = (title: string) => `<html><head><title>Ignoré</title></head><body><article>
  <h1>${title}</h1>
  <p>${BODY_SENTENCE.repeat(15)}</p>
</article></body></html>`;

// ─────────────────────────────────────────────────────────────────────────────
// Checkpoint (a) — pause_requested is already true by the time executeRun is invoked at all, so it
// MUST be observed at the very first boundary, right after phase 1 (read + group) but before a
// single story is processed. Single-candidate fixture — an article server IS needed here (unlike
// cancel's checkpoint-(a) test) because, unlike cancel, this run later RESUMES and really does
// extract/synthesize that one story.
const TITLE_ONE = "Une seule histoire, mise en pause avant d'être traitée";

function pauseCheckpointAFixture() {
  const article = Bun.serve({ port: 0, fetch: () => new Response(ARTICLE_HTML(TITLE_ONE), { headers: { "content-type": "text/html" } }) });
  const guid = `test:pause-a:${Math.random()}`;
  const rss = Bun.serve({
    port: 0,
    fetch: () => new Response(
      `<?xml version="1.0"?><rss version="2.0"><channel><title>Fixture pause A</title>
      <item><title>${TITLE_ONE}</title><link>http://localhost:${article.port}/a</link>
      <guid>${guid}</guid><description>Une histoire unique pour le test de pause avant la phase 2.</description></item>
      </channel></rss>`,
      { headers: { "content-type": "application/xml" } },
    ),
  });
  return {
    rssUrl: `http://localhost:${rss.port}/feed`,
    articleBase: `http://localhost:${article.port}`,
    stop: () => { article.stop(true); rss.stop(true); },
  };
}

describe("executeRun cooperative pause — checkpoint (a): before phase 2 begins, then resume", () => {
  const envSnap = snapshotEnv(PROVIDER_KEYS);
  let fx: ReturnType<typeof pauseCheckpointAFixture>;
  let feedId: string;

  beforeAll(async () => {
    for (const k of PROVIDER_KEYS) delete process.env[k]; // grouping's embed() + generateArticle() fall to their mocks
    fx = pauseCheckpointAFixture();
    const [f] = await db.insert(feeds).values({ name: "Fixture pause A", feedUrl: fx.rssUrl, active: true }).returning({ id: feeds.id });
    feedId = f.id;
  });

  afterAll(async () => {
    fx.stop();
    restoreEnv(envSnap);
    await cleanupArticlesFrom(fx.articleBase);
    await db.delete(rawItems).where(eq(rawItems.feedId, feedId));
    await db.delete(feeds).where(eq(feeds.id, feedId));
  });

  it("pauses with a checkpoint holding the one un-started story, holds the interlock, then resumes to completion", async () => {
    let runId: string | null = null;
    let blockedRunId: string | null = null;
    try {
      runId = await openRun({ triggeredBy: "manual", feedsTotal: 1 });
      expect(runId).not.toBeNull();

      // Mirrors pauseRun's DB write (the action itself can't be invoked outside a Next.js request
      // scope — see the "pauseRun's DB mechanism" describe below). Set BEFORE executeRun even
      // starts, so it is guaranteed to be observed by the checkpoint (a) re-read.
      await db.update(pipelineRuns).set({ pauseRequested: true }).where(eq(pipelineRuns.id, runId!));

      // ---- Phase 1: pause ----
      const res1 = await executeRun(runId!, { feedIds: [feedId] });
      expect(res1.status).toBe("paused");
      expect(res1.produced).toBe(0);

      const [row1] = await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, runId!));
      expect(row1.status).toBe("paused");
      expect(row1.finishedAt).toBeNull(); // NOT terminal — the interlock slot is still held
      expect(row1.currentStage).toBeNull();
      expect(row1.currentItem).toBeNull();
      expect(row1.totalItems).toBe(1);        // phase 1 + grouping DID complete (1 candidate → 1 group)
      expect(row1.processedItems).toBe(0);    // but NO story was processed — stopped at checkpoint (a)

      // The checkpoint holds exactly the one un-started story, in the expected shape.
      expect(row1.checkpoint).not.toBeNull();
      const stories = row1.checkpoint!.stories;
      expect(stories.length).toBe(1);
      expect(stories[0].length).toBe(1);
      expect(stories[0][0].item.title).toBe(TITLE_ONE);
      expect(stories[0][0].feedId).toBe(feedId);

      // Its member was never recordRawItem()'d — untouched, exactly as captured in the checkpoint.
      const recordedBefore = await db.select().from(rawItems).where(eq(rawItems.feedId, feedId));
      expect(recordedBefore.length).toBe(0);

      // The neutral French pause step was recorded.
      const steps1 = await db.select().from(pipelineSteps).where(eq(pipelineSteps.runId, runId!));
      const pauseStep = steps1.find((s) => s.name === "Exécution mise en pause");
      expect(pauseStep).toBeDefined();
      expect(pauseStep!.status).toBe("partial");

      // ---- Interlock while paused: the slot is still held — a second run cannot open. ----
      expect(await hasRunningRun()).toBe(true);
      blockedRunId = await openRun({ triggeredBy: "manual" });
      expect(blockedRunId).toBeNull();

      // ---- Phase 2: resume — directly, for determinism (resumeRun itself fires this detached).
      // Mirrors resumeRun's own clear-before-call ordering (lib/actions/pipeline-actions.ts): the
      // flag/checkpoint MUST be cleared before the call, or executeRun's very first boundary check
      // would immediately observe the still-true pause_requested and re-pause without processing
      // anything.
      await db.update(pipelineRuns).set({ pauseRequested: false, checkpoint: null, status: "running" })
        .where(eq(pipelineRuns.id, runId!));
      const res2 = await executeRun(runId!, { resumeStories: stories });
      expect(res2.status).toBe("success");
      expect(res2.produced).toBe(1);

      const [row2] = await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, runId!));
      expect(row2.status).toBe("success");
      expect(row2.finishedAt).not.toBeNull(); // NOW terminal — interlock slot freed
      expect(row2.processedItems).toBe(1);    // continued from 0 (processedStart), not reset
      expect(row2.totalItems).toBe(1);        // untouched by the resume call

      // The member IS now recorded (processed during resume), and produced a pending article.
      const recordedAfter = await db.select().from(rawItems).where(eq(rawItems.feedId, feedId));
      expect(recordedAfter.length).toBe(1);
      expect(recordedAfter[0].rawTitle).toBe(TITLE_ONE);

      const producedSources = await db.select().from(articleSources).where(like(articleSources.url, `${fx.articleBase}%`));
      expect(producedSources.length).toBe(1);
      const [producedArticle] = await db.select().from(articles).where(eq(articles.id, producedSources[0].articleId));
      expect(producedArticle.status).toBe("pending"); // human-review barrier intact

      // SP5 Task 4 review C1: the resume path inserts an immediate "Reprise de l'exécution" step
      // (fresh activity so reclaimStaleRuns can't reap a just-resumed run before its first extraction).
      const steps2 = await db.select().from(pipelineSteps).where(eq(pipelineSteps.runId, runId!));
      expect(steps2.some((s) => s.name === "Reprise de l'exécution")).toBe(true);

      // Interlock freed now that the run is genuinely terminal.
      expect(await hasRunningRun()).toBe(false);
    } finally {
      if (blockedRunId) await db.delete(pipelineRuns).where(eq(pipelineRuns.id, blockedRunId));
      if (runId) await db.delete(pipelineRuns).where(eq(pipelineRuns.id, runId)); // cascades pipeline_steps
    }
  }, 20000);
});

// ─────────────────────────────────────────────────────────────────────────────
// Checkpoint (b) — pause_requested flips to true DURING story A's own processing (as a side effect
// of its extraction fetch, so the ordering is causal, never timing-dependent/racy) — proving story
// A still completes in full, while story B (queued right after it) is captured into the checkpoint
// UN-touched, then genuinely processed once resumed.
const TITLE_A = "Une annonce commerciale majeure est publiée (histoire déclencheuse — pause)";
const TITLE_B = "Une histoire qui attend son tour (à reprendre après la pause)";

function pauseMidRunFixture() {
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
          await db.update(pipelineRuns).set({ pauseRequested: true }).where(eq(pipelineRuns.id, capturedRunId));
        }
        return new Response(ARTICLE_HTML(TITLE_A), { headers: { "content-type": "text/html" } });
      }
      controlFetched = true; // must NEVER happen before the pause — only once resumed
      return new Response(ARTICLE_HTML(TITLE_B), { headers: { "content-type": "text/html" } });
    },
  });
  const items = [
    { title: TITLE_A, path: "/trigger", desc: "Une grande enseigne annonce un rapprochement commercial régional." },
    { title: TITLE_B, path: "/control", desc: "Cette histoire patiente, capturée dans le point de reprise." },
  ];
  const rssItems = items.map((d, i) => `
    <item><title>${d.title}</title><link>http://localhost:${article.port}${d.path}</link>
    <guid>test:pause-b:${i}:${Math.random()}</guid><description>${d.desc}</description></item>`).join("");
  const rss = Bun.serve({ port: 0, fetch: () => new Response(
    `<?xml version="1.0"?><rss version="2.0"><channel><title>Fixture pause B</title>${rssItems}</channel></rss>`,
    { headers: { "content-type": "application/xml" } }) });
  return {
    rssUrl: `http://localhost:${rss.port}/feed`,
    articleBase: `http://localhost:${article.port}`,
    setRunId: (id: string) => { capturedRunId = id; },
    wasControlFetched: () => controlFetched,
    stop: () => { article.stop(true); rss.stop(true); },
  };
}

describe("executeRun cooperative pause — checkpoint (b): between two stories, then resume", () => {
  const envSnap = snapshotEnv(PROVIDER_KEYS);
  let fx: ReturnType<typeof pauseMidRunFixture>;
  let feedId: string;

  beforeAll(async () => {
    for (const k of PROVIDER_KEYS) delete process.env[k];
    fx = pauseMidRunFixture();
    const [f] = await db.insert(feeds).values({ name: "Fixture pause B", feedUrl: fx.rssUrl, active: true }).returning({ id: feeds.id });
    feedId = f.id;
  });

  afterAll(async () => {
    fx.stop();
    restoreEnv(envSnap);
    await cleanupArticlesFrom(fx.articleBase);
    await db.delete(rawItems).where(eq(rawItems.feedId, feedId));
    await db.delete(feeds).where(eq(feeds.id, feedId));
  });

  it("fully processes story A (which triggers the pause), captures story B untouched, holds the interlock, then resume processes story B and finalizes", async () => {
    let runId: string | null = null;
    let blockedRunId: string | null = null;
    try {
      runId = await openRun({ triggeredBy: "manual", feedsTotal: 1 });
      expect(runId).not.toBeNull();
      fx.setRunId(runId!);

      // ---- Phase 1: process story A, pause before story B ----
      const res1 = await executeRun(runId!, { feedIds: [feedId] });
      expect(res1.status).toBe("paused");
      expect(res1.produced).toBe(1); // story A DID produce an article before the pause landed
      expect(fx.wasControlFetched()).toBe(false); // story B's article URL was never fetched

      const [row1] = await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, runId!));
      expect(row1.status).toBe("paused");
      expect(row1.finishedAt).toBeNull();
      expect(row1.currentStage).toBeNull();
      expect(row1.currentItem).toBeNull();
      expect(row1.totalItems).toBe(2);        // 2 distinct stories grouped in phase 1
      expect(row1.processedItems).toBe(1);    // only story A, processed BEFORE the mid-loop pause

      // Checkpoint holds EXACTLY story B (the un-processed remainder), not story A.
      expect(row1.checkpoint).not.toBeNull();
      const stories = row1.checkpoint!.stories;
      expect(stories.length).toBe(1);
      expect(stories[0].some((m) => m.item.title === TITLE_B)).toBe(true);
      expect(stories[0].some((m) => m.item.title === TITLE_A)).toBe(false);

      // Story A's member was recorded (it was actually processed); story B's was NOT.
      const recordedBefore = await db.select().from(rawItems).where(eq(rawItems.feedId, feedId));
      expect(recordedBefore.length).toBe(1);
      expect(recordedBefore[0].rawTitle).toBe(TITLE_A);

      // Story A really did produce a pending article (human-review barrier intact) — ONLY the
      // pre-pause story produced anything at this point.
      const producedBefore = await db.select().from(articleSources).where(like(articleSources.url, `${fx.articleBase}%`));
      expect(producedBefore.length).toBe(1);

      const stepsAfterPause = await db.select().from(pipelineSteps).where(eq(pipelineSteps.runId, runId!));
      const pauseStep = stepsAfterPause.find((s) => s.name === "Exécution mise en pause");
      expect(pauseStep).toBeDefined();
      expect(pauseStep!.status).toBe("partial");

      // ---- Interlock while paused ----
      expect(await hasRunningRun()).toBe(true);
      blockedRunId = await openRun({ triggeredBy: "manual" });
      expect(blockedRunId).toBeNull();

      // ---- Resume: story B now gets fetched, recorded, and processed ----
      // Mirrors resumeRun's own clear-before-call ordering — see the checkpoint-(a) test above.
      await db.update(pipelineRuns).set({ pauseRequested: false, checkpoint: null, status: "running" })
        .where(eq(pipelineRuns.id, runId!));
      const res2 = await executeRun(runId!, { resumeStories: stories });
      expect(res2.status).toBe("success");
      expect(res2.produced).toBe(1); // story B, produced on this call
      expect(fx.wasControlFetched()).toBe(true); // story B's article URL WAS fetched once resumed

      const [row2] = await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, runId!));
      expect(row2.status).toBe("success");
      expect(row2.finishedAt).not.toBeNull();
      expect(row2.processedItems).toBe(2); // continues from 1 → 2, not reset to 0/1
      expect(row2.totalItems).toBe(2);     // untouched by the resume call

      const recordedAfter = await db.select().from(rawItems).where(eq(rawItems.feedId, feedId));
      expect(recordedAfter.length).toBe(2);
      expect(recordedAfter.some((r) => r.rawTitle === TITLE_B)).toBe(true);

      const producedAfter = await db.select().from(articleSources).where(like(articleSources.url, `${fx.articleBase}%`));
      expect(producedAfter.length).toBe(2); // both stories' articles now exist

      expect(await hasRunningRun()).toBe(false); // interlock freed — genuinely terminal now
    } finally {
      if (blockedRunId) await db.delete(pipelineRuns).where(eq(pipelineRuns.id, blockedRunId));
      if (runId) await db.delete(pipelineRuns).where(eq(pipelineRuns.id, runId));
    }
  }, 20000);
});

// ─────────────────────────────────────────────────────────────────────────────
// pauseRun/resumeRun (lib/actions/pipeline-actions.ts) are RBAC-guarded (pipeline:configure) —
// same permission matrix as cancelRun.
describe("pauseRun/resumeRun authz", () => {
  it("only admin may pause or resume a run", () => {
    expect(can("admin", "pipeline", "configure")).toBe(true);
    expect(can("editor", "pipeline", "configure")).toBe(false);
    expect(can("journalist", "pipeline", "configure")).toBe(false);
  });
});

// pauseRun/resumeRun themselves start with requireUser() → next/headers(), which needs a real
// Next.js request context unavailable under plain `bun test` — same constraint documented in
// tests/pipeline-cancel.test.ts (cancelRun) and tests/reprocess.test.ts/tests/feed-actions.test.ts
// for their own RBAC-guarded actions. So these exercise the EXACT drizzle predicates/writes
// pauseRun/resumeRun run.
describe("pauseRun's DB mechanism (real Neon, network-free)", () => {
  it("sets pause_requested=true on an active 'running' run", async () => {
    const [run] = await db.insert(pipelineRuns).values({ triggeredBy: "manual", status: "running" }).returning({ id: pipelineRuns.id });
    try {
      const updated = await db.update(pipelineRuns).set({ pauseRequested: true })
        .where(and(eq(pipelineRuns.id, run.id), eq(pipelineRuns.status, "running"), isNull(pipelineRuns.finishedAt)))
        .returning({ id: pipelineRuns.id });
      expect(updated.length).toBe(1);

      const [row] = await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, run.id));
      expect(row.pauseRequested).toBe(true);
    } finally {
      await db.delete(pipelineRuns).where(eq(pipelineRuns.id, run.id));
    }
  });

  it("no-ops (0 rows touched) on an already-'paused' run — pauseRun only targets 'running'", async () => {
    const [run] = await db.insert(pipelineRuns).values({ triggeredBy: "manual", status: "paused" }).returning({ id: pipelineRuns.id });
    try {
      const updated = await db.update(pipelineRuns).set({ pauseRequested: true })
        .where(and(eq(pipelineRuns.id, run.id), eq(pipelineRuns.status, "running"), isNull(pipelineRuns.finishedAt)))
        .returning({ id: pipelineRuns.id });
      expect(updated.length).toBe(0);

      const [row] = await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, run.id));
      expect(row.pauseRequested).toBe(false); // untouched
    } finally {
      await db.delete(pipelineRuns).where(eq(pipelineRuns.id, run.id));
    }
  });

  it("no-ops (0 rows touched) on an already-terminal run", async () => {
    const [run] = await db.insert(pipelineRuns).values({
      triggeredBy: "manual", status: "success", finishedAt: new Date(),
    }).returning({ id: pipelineRuns.id });
    try {
      const updated = await db.update(pipelineRuns).set({ pauseRequested: true })
        .where(and(eq(pipelineRuns.id, run.id), eq(pipelineRuns.status, "running"), isNull(pipelineRuns.finishedAt)))
        .returning({ id: pipelineRuns.id });
      expect(updated.length).toBe(0);
    } finally {
      await db.delete(pipelineRuns).where(eq(pipelineRuns.id, run.id));
    }
  });
});

describe("resumeRun's DB mechanism (real Neon, network-free)", () => {
  it("loads a 'paused' run's checkpoint, then clears pause_requested/checkpoint and flips status back to 'running'", async () => {
    const checkpoint: RunCheckpoint = {
      stories: [[{
        feedId: "feed-x", feedName: "Flux X",
        item: { guid: "g1", url: "https://example.com/x", title: "T", contentSnippet: "S", isoDate: null, contentHash: "h1" },
      }]],
    };
    const [run] = await db.insert(pipelineRuns).values({
      triggeredBy: "manual", status: "paused", pauseRequested: true, checkpoint,
    }).returning({ id: pipelineRuns.id });
    try {
      const [loaded] = await db.select({ status: pipelineRuns.status, checkpoint: pipelineRuns.checkpoint })
        .from(pipelineRuns).where(eq(pipelineRuns.id, run.id));
      expect(loaded.status).toBe("paused");
      expect(loaded.checkpoint?.stories.length).toBe(1); // resumeRun would proceed with these stories

      await db.update(pipelineRuns).set({ pauseRequested: false, checkpoint: null, status: "running" })
        .where(eq(pipelineRuns.id, run.id));

      const [after] = await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, run.id));
      expect(after.status).toBe("running");
      expect(after.pauseRequested).toBe(false);
      expect(after.checkpoint).toBeNull();
    } finally {
      await db.delete(pipelineRuns).where(eq(pipelineRuns.id, run.id));
    }
  });

  it("no-op gate: a 'running' (not paused) run — resumeRun bails before touching anything", async () => {
    const [run] = await db.insert(pipelineRuns).values({ triggeredBy: "manual", status: "running" }).returning({ id: pipelineRuns.id });
    try {
      const [loaded] = await db.select({ status: pipelineRuns.status }).from(pipelineRuns).where(eq(pipelineRuns.id, run.id));
      expect(loaded.status).not.toBe("paused"); // matches resumeRun's { ok: false, message: "n'est pas en pause" } path
    } finally {
      await db.delete(pipelineRuns).where(eq(pipelineRuns.id, run.id));
    }
  });

  it("no-op gate: a 'paused' run with an empty checkpoint has no story to resume", async () => {
    const [run] = await db.insert(pipelineRuns).values({
      triggeredBy: "manual", status: "paused", checkpoint: { stories: [] },
    }).returning({ id: pipelineRuns.id });
    try {
      const [loaded] = await db.select({ status: pipelineRuns.status, checkpoint: pipelineRuns.checkpoint })
        .from(pipelineRuns).where(eq(pipelineRuns.id, run.id));
      expect(loaded.status).toBe("paused");
      expect(loaded.checkpoint?.stories.length ?? 0).toBe(0); // matches resumeRun's "aucun point de reprise" no-op path
    } finally {
      await db.delete(pipelineRuns).where(eq(pipelineRuns.id, run.id));
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SP5 Task 4 REVIEW fixes (C1 reaper-safe resume, C2 zero-work strand, I4 cancel-paused, I3 atomic
// resume). These exercise the exact drizzle mechanisms the reviewed actions run (the actions
// themselves can't be invoked under plain `bun test` — requireUser() → next/headers).
describe("SP5 Task 4 review — pause/resume invariant fixes", () => {
  // C1 — a paused run older than runStaleMinutes, once resumed (status→running + started_at
  // REFRESHED, as resumeRun's atomic flip does), must NOT be reaped by reclaimStaleRuns(). Before
  // the fix it kept its old started_at and had no fresh step, so the reaper (which runs on every
  // getActiveRun poll) matched it and freed the interlock slot mid-resume.
  it("C1: a just-resumed run with a refreshed started_at is not reaped by reclaimStaleRuns()", async () => {
    const checkpoint: RunCheckpoint = {
      stories: [[{
        feedId: "feed-c1", feedName: "Flux C1",
        item: { guid: "g-c1", url: "https://example.com/c1", title: "T", contentSnippet: "S", isoDate: null, contentHash: "h-c1" },
      }]],
    };
    // Paused, started 24h ago (well past the 15-min default stale cutoff), no steps at all.
    const [run] = await db.insert(pipelineRuns).values({
      triggeredBy: "manual", status: "paused", startedAt: new Date(Date.now() - 24 * 60 * 60_000), checkpoint,
    }).returning({ id: pipelineRuns.id });
    try {
      // resumeRun's atomic, status-guarded claim: flips to running AND refreshes started_at.
      const claimed = await db.update(pipelineRuns)
        .set({ status: "running", startedAt: new Date(), pauseRequested: false, checkpoint: null })
        .where(and(eq(pipelineRuns.id, run.id), eq(pipelineRuns.status, "paused")))
        .returning({ id: pipelineRuns.id });
      expect(claimed.length).toBe(1);

      // The reaper runs on every getActiveRun/hasRunningRun poll — it must leave this run alone
      // because started_at is now recent (even with zero steps yet).
      await reclaimStaleRuns();

      const [after] = await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, run.id));
      expect(after.status).toBe("running");   // NOT reaped to "failed"
      expect(after.finishedAt).toBeNull();     // slot still held by the live resume
    } finally {
      await db.delete(pipelineRuns).where(eq(pipelineRuns.id, run.id));
    }
  });

  // I3 — two concurrent resumeRun calls both pass the SELECT gate, but only the FIRST atomic
  // status-guarded flip matches a 'paused' row; the second sees 0 rows and no-ops (so only one
  // executeRun fires → no duplicate articles).
  it("I3: a second concurrent resume claim finds 0 rows (only one executeRun fires)", async () => {
    const checkpoint: RunCheckpoint = {
      stories: [[{
        feedId: "feed-i3", feedName: "Flux I3",
        item: { guid: "g-i3", url: "https://example.com/i3", title: "T", contentSnippet: "S", isoDate: null, contentHash: "h-i3" },
      }]],
    };
    const [run] = await db.insert(pipelineRuns).values({
      triggeredBy: "manual", status: "paused", checkpoint,
    }).returning({ id: pipelineRuns.id });
    try {
      const flip = () => db.update(pipelineRuns)
        .set({ status: "running", startedAt: new Date(), pauseRequested: false, checkpoint: null })
        .where(and(eq(pipelineRuns.id, run.id), eq(pipelineRuns.status, "paused")))
        .returning({ id: pipelineRuns.id });
      const first = await flip();
      const second = await flip();
      expect(first.length).toBe(1);  // winner claims the resume
      expect(second.length).toBe(0); // loser no-ops — would NOT fire a duplicate executeRun
    } finally {
      await db.delete(pipelineRuns).where(eq(pipelineRuns.id, run.id));
    }
  });

  // I4/C2 recovery — cancelRun's paused branch finalizes a paused run directly (terminal 'cancelled'
  // + finished_at, clearing checkpoint/flags), freeing the interlock slot so a genuinely new run can
  // open right after. This is what makes Stop work on a paused run and recovers a stranded one.
  it("I4/C2: cancelling a paused run finalizes it and frees the interlock slot", async () => {
    const checkpoint: RunCheckpoint = {
      stories: [[{
        feedId: "feed-i4", feedName: "Flux I4",
        item: { guid: "g-i4", url: "https://example.com/i4", title: "T", contentSnippet: "S", isoDate: null, contentHash: "h-i4" },
      }]],
    };
    const [run] = await db.insert(pipelineRuns).values({
      triggeredBy: "manual", status: "paused", pauseRequested: true, checkpoint,
    }).returning({ id: pipelineRuns.id });
    let secondRunId: string | null = null;
    try {
      expect(await hasRunningRun()).toBe(true); // paused holds the slot

      // cancelRun's paused branch.
      const finalized = await db.update(pipelineRuns)
        .set({ status: "cancelled", finishedAt: new Date(), checkpoint: null, pauseRequested: false, cancelRequested: false })
        .where(and(eq(pipelineRuns.id, run.id), eq(pipelineRuns.status, "paused")))
        .returning({ id: pipelineRuns.id });
      expect(finalized.length).toBe(1);

      const [row] = await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, run.id));
      expect(row.status).toBe("cancelled");
      expect(row.finishedAt).not.toBeNull();
      expect(row.checkpoint).toBeNull();

      // Slot freed — a brand-new run can open right after.
      expect(await hasRunningRun()).toBe(false);
      secondRunId = await openRun({ triggeredBy: "manual" });
      expect(secondRunId).not.toBeNull();
    } finally {
      if (secondRunId) await db.delete(pipelineRuns).where(eq(pipelineRuns.id, secondRunId));
      await db.delete(pipelineRuns).where(eq(pipelineRuns.id, run.id));
    }
  });
});

// C2 — a zero-work run (every candidate a duplicate / feed empty) with pause_requested set must
// NOT enter the paused state (an empty checkpoint would strand the slot forever). It finalizes
// NORMALLY instead. Fixture: an EMPTY RSS feed (zero items → zero candidates → zero groups).
describe("SP5 Task 4 review C2 — pausing a zero-work run finalizes normally (does not park)", () => {
  const envSnap = snapshotEnv(PROVIDER_KEYS);
  let rss: ReturnType<typeof Bun.serve>;
  let feedId: string;

  beforeAll(async () => {
    for (const k of PROVIDER_KEYS) delete process.env[k];
    rss = Bun.serve({
      port: 0,
      fetch: () => new Response(
        `<?xml version="1.0"?><rss version="2.0"><channel><title>Fixture vide</title></channel></rss>`,
        { headers: { "content-type": "application/xml" } },
      ),
    });
    const [f] = await db.insert(feeds).values({ name: "Fixture vide", feedUrl: `http://localhost:${rss.port}/feed`, active: true }).returning({ id: feeds.id });
    feedId = f.id;
  });

  afterAll(async () => {
    rss.stop(true);
    restoreEnv(envSnap);
    await db.delete(rawItems).where(eq(rawItems.feedId, feedId));
    await db.delete(feeds).where(eq(feeds.id, feedId));
  });

  it("finalizes to a terminal status (NOT 'paused'), sets finished_at, writes no checkpoint, frees the slot", async () => {
    let runId: string | null = null;
    try {
      runId = await openRun({ triggeredBy: "manual", feedsTotal: 1 });
      expect(runId).not.toBeNull();

      // Pause requested BEFORE executeRun — but there is zero remaining work, so boundary (a) must
      // decline to park and let the run finalize normally.
      await db.update(pipelineRuns).set({ pauseRequested: true }).where(eq(pipelineRuns.id, runId!));

      const res = await executeRun(runId!, { feedIds: [feedId] });
      expect(res.status).not.toBe("paused"); // NOT parked
      expect(res.status).toBe("success");    // quiet run (no candidates, feed read OK) → success

      const [row] = await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, runId!));
      expect(row.status).toBe("success");
      expect(row.finishedAt).not.toBeNull(); // terminal — slot freed
      expect(row.checkpoint).toBeNull();     // no checkpoint written
      expect(row.totalItems).toBe(0);        // zero groups

      // No "Exécution mise en pause" step (it never paused).
      const steps = await db.select().from(pipelineSteps).where(eq(pipelineSteps.runId, runId!));
      expect(steps.some((s) => s.name === "Exécution mise en pause")).toBe(false);

      expect(await hasRunningRun()).toBe(false); // interlock freed, not stranded
    } finally {
      if (runId) await db.delete(pipelineRuns).where(eq(pipelineRuns.id, runId));
    }
  }, 20000);
});

// ─────────────────────────────────────────────────────────────────────────────
// getActiveRun() (lib/queries/runs.ts) now includes 'paused' runs (SP5 Task 4), mirroring
// tests/live-progress.test.ts's existing "getActiveRun" describe for the 'running' case.
describe("getActiveRun() includes a 'paused' run", () => {
  let runId: string | null = null;
  afterAll(async () => { if (runId) await db.delete(pipelineRuns).where(eq(pipelineRuns.id, runId)); });

  it("returns the paused run with its progress fields and grouped steps", async () => {
    const [run] = await db.insert(pipelineRuns).values({
      triggeredBy: "manual", status: "paused", phase: "finalizing",
      totalItems: 3, processedItems: 1,
    }).returning({ id: pipelineRuns.id });
    runId = run.id;
    await db.insert(pipelineSteps).values({ runId, name: "Exécution mise en pause", status: "partial", durationMs: null });

    const active = await getActiveRun();
    expect(active).not.toBeNull();
    expect(active!.run.id).toBe(runId);
    expect(active!.run.status).toBe("paused");
    expect(active!.run.processedItems).toBe(1);
    expect(active!.feedSteps.length).toBeGreaterThanOrEqual(1);
  });
});

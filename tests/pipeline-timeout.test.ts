import { describe, it, expect, beforeAll, afterAll, spyOn, mock } from "bun:test";
import { withTimeout } from "@/lib/pipeline/timeout";

// ─────────────────────────────────────────────────────────────────────────────
// SP5 Task 2 — per-operation timeout. Part 1: pure unit tests of withTimeout, network- and
// DB-free — every case uses tiny millisecond values so the suite stays fast (no waiting minutes).
describe("withTimeout", () => {
  it("resolves normally when the promise settles before the timeout", async () => {
    const p = new Promise<string>((resolve) => setTimeout(() => resolve("ok"), 5));
    await expect(withTimeout(p, 2000, "Test")).resolves.toBe("ok");
  });

  it("rejects quickly with the French timeout message when the promise never resolves", async () => {
    const hung = new Promise<never>(() => {}); // never settles — simulates a stuck provider call
    const ms = 20;
    const t0 = Date.now();
    await expect(withTimeout(hung, ms, "Génération IA")).rejects.toThrow(
      `L'opération « Génération IA » a dépassé le délai de ${Math.round(ms / 1000)} s.`
    );
    // "quickly" — well under a second, nowhere near the 5-minute production default.
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it("applies no timeout when ms <= 0 (guard: a misconfigured 0 disables timeouts rather than instantly failing everything)", async () => {
    const p1 = new Promise<string>((resolve) => setTimeout(() => resolve("slow-ish"), 30));
    await expect(withTimeout(p1, 0, "Test")).resolves.toBe("slow-ish");

    const p2 = new Promise<string>((resolve) => setTimeout(() => resolve("slow-ish-2"), 30));
    await expect(withTimeout(p2, -5, "Test")).resolves.toBe("slow-ish-2");

    const p3 = new Promise<string>((resolve) => setTimeout(() => resolve("slow-ish-3"), 30));
    await expect(withTimeout(p3, NaN, "Test")).resolves.toBe("slow-ish-3");
  });

  it("calls clearTimeout on the resolve path (no dangling handle)", async () => {
    // Real regression guard (SP5 Task 2 review, Finding 2): spy on clearTimeout and assert the
    // finally block actually clears the timer — with a 60 s timeout, a leaked handle would
    // otherwise keep the event loop alive far past this fast-resolving promise.
    const spy = spyOn(globalThis, "clearTimeout");
    try {
      const p = new Promise<string>((resolve) => setTimeout(() => resolve("done"), 5));
      await expect(withTimeout(p, 60000, "Test")).resolves.toBe("done");
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("calls clearTimeout on the timeout path too (the timer that already fired is still cleared)", async () => {
    const spy = spyOn(globalThis, "clearTimeout");
    try {
      const hung = new Promise<never>(() => {});
      await expect(withTimeout(hung, 20, "Test")).rejects.toThrow("a dépassé le délai");
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Part 2: a SYNTHESIS-STAGE timeout, exercised directly through stageSources (no pipeline_runs
// scaffolding needed — this path never reaches a DB write, so there's nothing to clean up).
// Reuses the embedFixtureServer pattern from tests/pipeline-grouping.test.ts, but the fixture here
// deliberately SLEEPS past the tiny timeoutMs passed to stageSources, standing in for a stuck
// embeddings provider.
import { stageSources } from "@/lib/pipeline/stages";

// generateArticle() (lib/ai/generate-article.ts) no longer short-circuits on a missing
// OPENROUTER_API_KEY: it now ALWAYS consults the OpenRouter token pool (lib/ai/with-token-pool.ts),
// which in production reads the `openrouter_tokens` table — that's the fix for operators who only
// configured tokens via Réglages. In THIS test no token exists anywhere (env or DB), so the real
// pool would still correctly resolve to "unconfigured" and fall through to the fast in-process
// mock — but only after a real round-trip to the remote Neon database, which blows well past the
// tiny timeoutMs this test uses. Faking runWithOpenRouterPool below skips that round-trip while
// keeping the SAME "unconfigured" answer the real pool would give here, so "Génération IA" stays
// fast for the right reason rather than by a loosened threshold. Same capture→mock.module()→
// afterAll-restore pattern as tests/ai-fallback.test.ts / tests/ai-improve.test.ts — mock.module()
// mutates the module's exports object in place and is NOT undone by mock.restore(), so without an
// explicit afterAll restore this patch would leak into every test file that runs afterwards in the
// same `bun test` process.
const { runWithOpenRouterPool: realRunWithOpenRouterPool } = await import("@/lib/ai/with-token-pool");
let runWithOpenRouterPoolImpl: typeof realRunWithOpenRouterPool = realRunWithOpenRouterPool;
mock.module("@/lib/ai/with-token-pool", () => ({
  runWithOpenRouterPool: (
    op: Parameters<typeof realRunWithOpenRouterPool>[0],
    isFlaky: Parameters<typeof realRunWithOpenRouterPool>[1],
    deps?: Parameters<typeof realRunWithOpenRouterPool>[2],
  ) => runWithOpenRouterPoolImpl(op, isFlaky, deps),
}));

describe("stageSources — a synthesis stage that runs long past its timeout fails that stage and aborts the story (SP5 Task 2)", () => {
  const PROVIDER_KEYS = [
    "JINA_API_KEY", "FIRECRAWL_API_KEY", "OPENROUTER_API_KEY",
    "OMNIROUTE_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY",
  ] as const;
  const EMBED_ENV_KEYS = ["EMBED_API_KEY", "EMBED_BASE_URL"] as const;
  const envSnap: Record<string, string | undefined> = {};
  let slowEmbedServer: ReturnType<typeof Bun.serve>;

  beforeAll(() => {
    for (const k of [...PROVIDER_KEYS, ...EMBED_ENV_KEYS]) envSnap[k] = process.env[k];
    for (const k of PROVIDER_KEYS) delete process.env[k]; // génération IA falls to its fast mock

    // Fait renvoyer "unconfigured" instantanément, sans toucher la base — exactement la réponse que
    // le pool réel donnerait ici (aucun jeton en base, aucune clé d'environnement), mais sans le
    // aller-retour réseau. Voir le commentaire au-dessus de ce describe pour le contexte complet.
    runWithOpenRouterPoolImpl = async () => ({ ok: false, reason: "unconfigured" });

    // Stands in for a stuck embeddings provider: always takes far longer to respond than the
    // tiny timeoutMs used below, but still short enough to keep this test fast (no real network).
    slowEmbedServer = Bun.serve({
      port: 0,
      fetch: async () => {
        await Bun.sleep(150);
        return new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3] }] }), {
          headers: { "content-type": "application/json" },
        });
      },
    });
    process.env.EMBED_API_KEY = "test-embed-key";
    process.env.EMBED_BASE_URL = `http://localhost:${slowEmbedServer.port}`;
  });

  afterAll(() => {
    slowEmbedServer.stop(true);
    for (const [k, v] of Object.entries(envSnap)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    runWithOpenRouterPoolImpl = realRunWithOpenRouterPool; // ne pas laisser fuiter vers les fichiers suivants
  });

  it("records 'Calcul de l'embedding' failed with the timeout message, leaves 'Génération IA' successful, and aborts (articleId null) before later stages run", async () => {
    const longText = "Texte de source suffisamment long pour la génération d'un article de test. ".repeat(10);
    const timeoutMs = 30;

    const res = await stageSources(
      [{ mediaName: "Test Media", url: "https://example.com/timeout-test", text: longText }],
      ["Économie"],
      {},
      timeoutMs,
    );

    expect(res.articleId).toBeNull(); // story aborts — human-review barrier: nothing gets written
    const byName = new Map(res.steps.map((s) => [s.name, s]));
    // Rapide car runWithOpenRouterPool est neutralisé plus haut (répond "unconfigured" sans DB) : la
    // génération retombe aussitôt sur mockGenerateArticle, un mock JS pur, sans réseau.
    expect(byName.get("Génération IA")?.status).toBe("success");

    const embStep = byName.get("Calcul de l'embedding");
    expect(embStep?.status).toBe("failed");
    expect(embStep?.errorMessage).toContain(
      `L'opération « Calcul de l'embedding » a dépassé le délai de ${Math.round(timeoutMs / 1000)} s.`
    );

    // Aborted BEFORE later stages — clustering/dépôt en revue never ran (no DB rows to clean up).
    expect(byName.has("Regroupement (clustering)")).toBe(false);
    expect(byName.has("Dépôt en revue")).toBe(false);
  }, 5000);
});

// ─────────────────────────────────────────────────────────────────────────────
// Part 3: an EXTRACTION timeout, exercised through the full executeRun runner — proves the
// per-member withTimeout wrapping in lib/pipeline/run.ts (a) bounds a hung fetch instead of
// stalling the run for as long as the provider takes, and (b) the run still finalizes to a
// terminal status (never left "running") exactly like an ordinary extraction failure today.
import { openRun, executeRun } from "@/lib/pipeline/run";
import { db, feeds, pipelineRuns, pipelineSteps, pipelineSettings, rawItems } from "@/db";
import { eq } from "drizzle-orm";

describe("executeRun — a member extraction call past perOperationTimeoutMs is skipped best-effort, and the run still finalizes (SP5 Task 2)", () => {
  const PROVIDER_KEYS = [
    "JINA_API_KEY", "FIRECRAWL_API_KEY", "EMBED_API_KEY", "OPENROUTER_API_KEY",
    "OMNIROUTE_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY",
  ] as const;
  const envSnap: Record<string, string | undefined> = {};
  let settingsSnapshot: typeof pipelineSettings.$inferSelect | undefined;
  let articleServer: ReturnType<typeof Bun.serve>;
  let rssServer: ReturnType<typeof Bun.serve>;
  let feedId: string;
  let runId: string | null = null;

  beforeAll(async () => {
    for (const k of PROVIDER_KEYS) envSnap[k] = process.env[k];
    for (const k of PROVIDER_KEYS) delete process.env[k]; // génération/embedding fall to fast mocks

    // Snapshot the shared pipeline_settings singleton (a real admin-configured row may exist) so
    // afterAll restores it exactly — same pattern as tests/pipeline-grouping.test.ts.
    [settingsSnapshot] = await db.select().from(pipelineSettings).where(eq(pipelineSettings.id, 1));
    await db.insert(pipelineSettings).values({ id: 1, perOperationTimeoutMs: 30 })
      .onConflictDoUpdate({ target: pipelineSettings.id, set: { perOperationTimeoutMs: 30 } });

    // The article fetch deliberately sleeps far past the 30ms perOperationTimeoutMs above — a
    // stand-in for a hung source fetch/extract.
    articleServer = Bun.serve({
      port: 0,
      fetch: async () => {
        await Bun.sleep(200);
        return new Response(
          "<html><body><article><h1>Histoire lente</h1><p>Contenu.</p></article></body></html>",
          { headers: { "content-type": "text/html" } },
        );
      },
    });
    const itemUrl = `http://localhost:${articleServer.port}/a`;
    const rss = `<?xml version="1.0"?><rss version="2.0"><channel><title>Fixture timeout</title>
      <item><title>Histoire lente</title><link>${itemUrl}</link>
      <guid>test:timeout:${Math.random()}</guid><description>Un résumé.</description></item>
    </channel></rss>`;
    rssServer = Bun.serve({ port: 0, fetch: () => new Response(rss, { headers: { "content-type": "application/xml" } }) });

    const [f] = await db.insert(feeds)
      .values({ name: "Fixture timeout", feedUrl: `http://localhost:${rssServer.port}/feed`, active: true })
      .returning({ id: feeds.id });
    feedId = f.id;
  });

  afterAll(async () => {
    articleServer.stop(true);
    rssServer.stop(true);
    for (const [k, v] of Object.entries(envSnap)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    await db.delete(pipelineSettings).where(eq(pipelineSettings.id, 1));
    if (settingsSnapshot) await db.insert(pipelineSettings).values(settingsSnapshot);
    await db.delete(rawItems).where(eq(rawItems.feedId, feedId));
    if (runId) await db.delete(pipelineRuns).where(eq(pipelineRuns.id, runId)); // cascades pipeline_steps
    await db.delete(feeds).where(eq(feeds.id, feedId));
  });

  it("bounds the hung extraction call, records the story's extraction step failed with the timeout trace, and still finalizes the run", async () => {
    runId = await openRun({ triggeredBy: "manual", feedsTotal: 1 });
    expect(runId).not.toBeNull();

    const t0 = Date.now();
    const res = await executeRun(runId!, { feedIds: [feedId] });
    // Proves the hung fetch (200ms) didn't stall the run for anywhere near its own delay, let
    // alone minutes — the timeout (30ms) won the race.
    expect(Date.now() - t0).toBeLessThan(5000);

    // The run still lands a terminal status — never stuck "running" — even though its only story
    // failed outright (its sole source's extraction timed out, same as any extraction failure).
    expect(["failed", "partial"]).toContain(res.status);
    const [row] = await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, runId!));
    expect(row.phase).toBe("finalizing");
    expect(row.currentStage).toBeNull();
    expect(row.currentItem).toBeNull();
    expect(row.finishedAt).not.toBeNull();

    const steps = await db.select().from(pipelineSteps).where(eq(pipelineSteps.runId, runId!));
    const extractionStep = steps.find((s) => s.name === "Extraction du contenu");
    expect(extractionStep?.status).toBe("failed");
    expect(extractionStep?.errorTechnical ?? "").toContain("a dépassé le délai de");
  }, 10000);
});

import { describe, it, expect, afterAll, beforeAll } from "bun:test";
import { db, pipelineRuns, pipelineSteps } from "@/db";
import { eq } from "drizzle-orm";

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
import { articles } from "@/db";

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
  const clean: string[] = [];

  beforeAll(() => {
    for (const k of PROVIDER_KEYS) delete process.env[k];
    server = Bun.serve({ port: 0, fetch: () => new Response(HTML, { headers: { "content-type": "text/html" } }) });
    url = `http://localhost:${server.port}/a`;
  });
  afterAll(async () => {
    server.stop(true);
    for (const [k, v] of Object.entries(snap)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    const { db: dbClean, articles: articlesClean } = await import("@/db");
    const { eq: eqClean } = await import("drizzle-orm");
    if (articleId) await dbClean.delete(articlesClean).where(eqClean(articlesClean.id, articleId));
  });

  it("fires onStageStart before each stage and onStageEnd after, in ITEM_STAGES order", async () => {
    const item: RawItem = { guid: "test:hooks", url, title: T, contentSnippet: "La bourse progresse.", isoDate: null, contentHash: contentHash(T, "hooks") };
    const starts: string[] = [];
    const ends: string[] = [];
    const res = await stageItem(item, "Test Media", ["Économie"], {
      onStageStart: (n) => { starts.push(n); },
      onStageEnd: (s) => { ends.push(s.name); },
    });
    articleId = res.articleId;
    expect(res.articleId).not.toBeNull();
    expect(starts).toEqual([...ITEM_STAGES]);
    expect(ends).toEqual([...ITEM_STAGES]);
  });
});

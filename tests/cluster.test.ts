import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { chooseCluster, decideCluster } from "@/lib/pipeline/cluster";
import { db, clusters, articles, articleEmbeddings } from "@/db";
import { mockEmbed } from "@/lib/embeddings";
import { eq } from "drizzle-orm";

describe("chooseCluster", () => {
  it("attaches when score ≥ threshold, else new", () => {
    expect(chooseCluster(0.9, 0.83)).toBe("attach");
    expect(chooseCluster(0.7, 0.83)).toBe("new");
  });

  it("attaches exactly at the threshold boundary", () => {
    expect(chooseCluster(0.83, 0.83)).toBe("attach");
  });
});

// Exercises the raw pgvector SQL in decideCluster against the real Neon DB.
// Self-cleaning: inserts a temp cluster + article + embedding, deletes them in afterAll.
describe("decideCluster (pgvector integration)", () => {
  const near = mockEmbed("dedup-cluster-integration-topic-alpha", 1024);
  const far = mockEmbed("dedup-cluster-integration-topic-zzz-unrelated-999", 1024);
  let clusterId: string;
  let articleId: string;

  beforeAll(async () => {
    const [c] = await db.insert(clusters).values({ label: "test:decideCluster" }).returning({ id: clusters.id });
    clusterId = c.id;
    const [a] = await db.insert(articles).values({
      title: "test:decideCluster article", clusterId, generatedAt: new Date(),
    }).returning({ id: articles.id });
    articleId = a.id;
    await db.insert(articleEmbeddings).values({ articleId, embedding: near });
  });

  afterAll(async () => {
    // deleting the article cascades the articleEmbeddings row (FK onDelete: cascade)
    await db.delete(articles).where(eq(articles.id, articleId));
    await db.delete(clusters).where(eq(clusters.id, clusterId));
  });

  it("attaches to the existing cluster for a near-identical embedding", async () => {
    const result = await decideCluster(near);
    expect(result.clusterId).toBe(clusterId);
    expect(result.isNew).toBe(false);
    expect(result.bestScore).toBeGreaterThanOrEqual(0.83);
  });

  it("proposes a new cluster for an unrelated embedding", async () => {
    const result = await decideCluster(far);
    expect(result.clusterId).toBeNull();
    expect(result.isNew).toBe(true);
    expect(result.bestScore).toBeLessThan(0.83);
  });
});

// Deterministic guard for decideCluster's try/catch hardening: when the comparison table holds an
// embedding whose dimension differs from the query vector, pgvector's `<=>` raises "different vector
// dimensions". decideCluster must swallow that and fall back to a NEW cluster (never abort staging).
// We force it by inserting a valid 1024-dim row, then querying with a 512-length vector. Own fixture
// (independent of the suite above) so the comparison row is guaranteed present and in-window.
describe("decideCluster dimension-mismatch fallback", () => {
  const stored = mockEmbed("dedup-cluster-dim-mismatch-guard", 1024); // valid stored embedding
  const mismatched = mockEmbed("dedup-cluster-dim-mismatch-query", 512); // wrong dimension → pgvector error
  let clusterId: string | null = null;
  let articleId: string | null = null;

  beforeAll(async () => {
    const [c] = await db.insert(clusters).values({ label: "test:decideCluster:dim-mismatch" }).returning({ id: clusters.id });
    clusterId = c.id;
    const [a] = await db.insert(articles).values({
      title: "test:decideCluster dim-mismatch article", clusterId, generatedAt: new Date(),
    }).returning({ id: articles.id });
    articleId = a.id;
    await db.insert(articleEmbeddings).values({ articleId, embedding: stored });
  });

  afterAll(async () => {
    // deleting the article cascades the articleEmbeddings row (FK onDelete: cascade)
    if (articleId) await db.delete(articles).where(eq(articles.id, articleId));
    if (clusterId) await db.delete(clusters).where(eq(clusters.id, clusterId));
  });

  it("returns a new-cluster fallback (does not throw) when the similarity query hits a dimension mismatch", async () => {
    const result = await decideCluster(mismatched);
    expect(result).toEqual({ clusterId: null, isNew: true, bestScore: 0 });
  });
});

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
    expect(result.bestScore).toBeGreaterThanOrEqual(0.83);
  });

  it("proposes a new cluster for an unrelated embedding", async () => {
    const result = await decideCluster(far);
    expect(result.clusterId).toBeNull();
    expect(result.bestScore).toBeLessThan(0.83);
  });
});

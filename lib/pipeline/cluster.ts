import { db, articles, articleEmbeddings } from "@/db";
import { sql } from "drizzle-orm";
import { getPipelineConfig } from "@/lib/config/pipeline-config";

export function chooseCluster(bestScore: number, threshold: number): "attach" | "new" {
  return bestScore >= threshold ? "attach" : "new";
}

type NearestRow = { cluster_id: string; score: number | string };

// nearest existing article embedding within the recency window, by cosine distance (pgvector <=>)
export async function decideCluster(embedding: number[]): Promise<{ clusterId: string | null; bestScore: number }> {
  const cfg = getPipelineConfig();
  const since = new Date(Date.now() - cfg.windowHours * 3600_000);
  const vec = `[${embedding.join(",")}]`;
  const result = await db.execute<NearestRow>(sql`
    select a.cluster_id as cluster_id, 1 - (e.embedding <=> ${vec}::vector) as score
    from ${articleEmbeddings} e join ${articles} a on a.id = e.article_id
    where a.generated_at >= ${since} and a.cluster_id is not null
    order by e.embedding <=> ${vec}::vector asc limit 1`);
  const top = result.rows[0];
  const bestScore = top ? Number(top.score) : 0;
  if (top && chooseCluster(bestScore, cfg.clusterThreshold) === "attach") return { clusterId: top.cluster_id, bestScore };
  return { clusterId: null, bestScore };
}

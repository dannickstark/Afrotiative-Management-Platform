import { db, articles, articleEmbeddings } from "@/db";
import { sql } from "drizzle-orm";
import { getPipelineConfig } from "@/lib/config/pipeline-config";

export function chooseCluster(bestScore: number, threshold: number): "attach" | "new" {
  return bestScore >= threshold ? "attach" : "new";
}

type NearestRow = { cluster_id: string; score: number | string };

// nearest existing article embedding within the recency window, by cosine distance (pgvector <=>)
export async function decideCluster(embedding: number[]): Promise<{ clusterId: string | null; isNew: boolean; bestScore: number }> {
  const cfg = getPipelineConfig();
  const since = new Date(Date.now() - cfg.windowHours * 3600_000);
  const vec = `[${embedding.join(",")}]`;
  // Best-effort clustering: a failed similarity query must NEVER abort staging. In particular, if
  // the table holds an embedding of a different dimension than this vector (e.g. a stray row, or a
  // misconfigured EMBED_DIMENSIONS), pgvector's `<=>` raises "different vector dimensions" — treat
  // any such failure as "no similar cluster found" (start a new cluster) instead of throwing. Under
  // normal operation every embedding is the same configured dimension, so this is a safety net, not
  // a hot path; it also keeps clustering resilient to transient DB errors.
  let top: NearestRow | undefined;
  try {
    const result = await db.execute<NearestRow>(sql`
      select a.cluster_id as cluster_id, 1 - (e.embedding <=> ${vec}::vector) as score
      from ${articleEmbeddings} e join ${articles} a on a.id = e.article_id
      where a.generated_at >= ${since} and a.cluster_id is not null
      order by e.embedding <=> ${vec}::vector asc limit 1`);
    top = result.rows[0];
  } catch (e) {
    console.warn(`[pipeline] requête de clustering échouée — article traité comme nouveau cluster : ${(e as Error).message}`);
    return { clusterId: null, isNew: true, bestScore: 0 };
  }
  const bestScore = top ? Number(top.score) : 0;
  if (top && chooseCluster(bestScore, cfg.clusterThreshold) === "attach") return { clusterId: top.cluster_id, isNew: false, bestScore };
  return { clusterId: null, isNew: true, bestScore };
}

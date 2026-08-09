import { db, distributions } from "@/db";
import { desc, eq } from "drizzle-orm";

export type DistributionRow = typeof distributions.$inferSelect;

// Every distribution row for one article, most recent first, across every channel (including
// 'wordpress') — the raw feed the future Diffusion panel (D1 Lot 2, spec §4) groups per channel to
// show "jamais envoyé / envoyé le … / échec". No RBAC check here: like every other
// lib/queries/*.ts read (getFeeds, getTaxonomy, getPipelineSettings — see lib/queries/settings.ts),
// access is gated at the page/layout level, not inside the query itself.
export async function listDistributionsForArticle(articleId: string): Promise<DistributionRow[]> {
  return db.select().from(distributions)
    .where(eq(distributions.articleId, articleId))
    .orderBy(desc(distributions.at));
}

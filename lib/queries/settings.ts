import { db, feeds, user, wpCategories, wpTags, distributions, pipelineRuns } from "@/db";
import { desc, eq } from "drizzle-orm";
import { getWpConfig } from "@/lib/wp/config";
import { getPipelineConfig } from "@/lib/config/pipeline-config";

export async function getFeeds() {
  return db.select().from(feeds).orderBy(feeds.name);
}

export async function getMembers() {
  return db.select({
    id: user.id, name: user.name, email: user.email, role: user.role,
    banned: user.banned, lastLoginAt: user.lastLoginAt,
  }).from(user).orderBy(user.createdAt);
}

export async function getTaxonomy() {
  const [categories, tags] = await Promise.all([
    db.select().from(wpCategories).orderBy(wpCategories.name),
    db.select().from(wpTags).orderBy(wpTags.name),
  ]);
  return { categories, tags };
}

export async function getIntegrationStatus() {
  const cfg = getPipelineConfig();
  const [lastPub] = await db.select({ at: distributions.at }).from(distributions)
    .where(eq(distributions.status, "sent")).orderBy(desc(distributions.at)).limit(1);
  const [lastRun] = await db.select({ at: pipelineRuns.startedAt, status: pipelineRuns.status })
    .from(pipelineRuns).orderBy(desc(pipelineRuns.startedAt)).limit(1);
  return {
    wordpress: { configured: !!getWpConfig(), lastSuccessAt: lastPub?.at ?? null },
    omniroute: { configured: !!cfg.omniroute },
    openrouter: { configured: !!cfg.openrouter },
    jina: { configured: !!cfg.jina },
    firecrawl: { configured: !!cfg.firecrawl },
    lastRun: lastRun ?? null,
  };
}

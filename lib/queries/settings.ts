import { db, feeds, user, wpCategories, wpTags, distributions, pipelineRuns, pipelineSettings } from "@/db";
import { and, desc, eq } from "drizzle-orm";
import { getWpConfig } from "@/lib/wp/config";
import { getPipelineConfig } from "@/lib/config/pipeline-config";

export type Feed = Awaited<ReturnType<typeof getFeeds>>[number];

export async function getFeeds() {
  return db.select().from(feeds).orderBy(feeds.name);
}

export type Member = Awaited<ReturnType<typeof getMembers>>[number];

export async function getMembers() {
  return db.select({
    id: user.id, name: user.name, email: user.email, role: user.role,
    banned: user.banned, lastLoginAt: user.lastLoginAt,
  }).from(user).orderBy(user.createdAt);
}

export type Taxonomy = Awaited<ReturnType<typeof getTaxonomy>>;

export async function getTaxonomy() {
  const [categories, tags] = await Promise.all([
    db.select().from(wpCategories).orderBy(wpCategories.name),
    db.select().from(wpTags).orderBy(wpTags.name),
  ]);
  return { categories, tags };
}

export async function getIntegrationStatus() {
  const cfg = getPipelineConfig();
  // Channel-scoped: once SP6 adds other distribution channels, a non-WordPress "sent" row must
  // never surface as the WordPress card's last successful publication.
  const [lastPub] = await db.select({ at: distributions.at }).from(distributions)
    .where(and(eq(distributions.channel, "wordpress"), eq(distributions.status, "sent")))
    .orderBy(desc(distributions.at)).limit(1);
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

export type PipelineSettings = typeof pipelineSettings.$inferSelect;

// DB source of truth for run-behavior knobs (maxItemsPerRun, clusterThreshold, auto-publish,
// schedule, …) — getPipelineConfig() (sync, env) stays authoritative for providers/secrets/order.
// Row id=1 is a fixed singleton, seeded once from the current env defaults so an existing
// MAX_ITEMS_PER_RUN/CLUSTER_THRESHOLD env is honored as the initial value; after that the DB row
// is authoritative and env is ignored. Idempotent: a second call after the row exists (or after a
// concurrent seed race loses via onConflictDoNothing) just reads the row back.
export async function getPipelineSettings(): Promise<PipelineSettings> {
  const [row] = await db.select().from(pipelineSettings).where(eq(pipelineSettings.id, 1));
  if (row) return row;
  const cfg = getPipelineConfig();
  const [created] = await db.insert(pipelineSettings).values({
    id: 1, maxItemsPerRun: cfg.maxItemsPerRun, clusterThreshold: cfg.clusterThreshold,
  }).onConflictDoNothing().returning();
  if (created) return created;
  const [again] = await db.select().from(pipelineSettings).where(eq(pipelineSettings.id, 1));
  return again;
}

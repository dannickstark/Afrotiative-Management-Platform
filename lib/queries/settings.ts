import { db, feeds, user, wpCategories, wpTags, distributions, pipelineRuns, pipelineSettings } from "@/db";
import { and, desc, eq } from "drizzle-orm";
import { getWpConfig } from "@/lib/wp/config";
import { getPipelineConfig } from "@/lib/config/pipeline-config";
import { getStudioConfig } from "@/lib/studio/config";
import { deriveFeedHealth } from "@/lib/pipeline/feed-health";
import { INTEGRATION_META, computeIntegrationConfigured, type IntegrationName } from "@/lib/config/integration-config";
import { getOpenRouterTokensMasked } from "@/lib/queries/openrouter-tokens";

export type Feed = Awaited<ReturnType<typeof getFeeds>>[number];

// SP8 — each row gets a `health` field (deriveFeedHealth's pure state, computed HERE server-side)
// on top of the raw columns (which already include lastFetchAt/lastFetchStatus/itemsCaptured7d/
// consecutiveFailures — a plain `select()` picks up every column, incl. the new
// consecutive_failures added by this same story's migration, with no explicit column list to
// update). Computed in this server-only query module — not in the "use client" feeds-table.tsx —
// so that component never needs a runtime import of lib/pipeline/feed-health.ts (which pulls in
// the DB client via updateFeedHealth); it only imports FeedHealth as a type.
export async function getFeeds() {
  const rows = await db.select().from(feeds).orderBy(feeds.name);
  return rows.map((row) => ({ ...row, health: deriveFeedHealth(row) }));
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

// Task 8 — extended from the original 5 (wordpress/omniroute/openrouter/jina/firecrawl) to the
// full registry in lib/config/integration-config.ts. The `configured` booleans themselves come
// from the PURE computeIntegrationConfigured() (unit-tested directly in
// tests/integration-status.test.ts); this function's own job is resolving the live signals
// (PipelineConfig, wordpress/r2 presence, search-provider env keys) and the two DB reads the
// existing 5 cards already relied on (WordPress's last publication, the pipeline's last run),
// plus — for the openrouter card only — a token-pool summary Task 9's card renders.
export async function getIntegrationStatus() {
  const cfg = getPipelineConfig();
  const configured = computeIntegrationConfigured(cfg, {
    braveApiKey: process.env.BRAVE_SEARCH_API_KEY,
    exaApiKey: process.env.EXA_API_KEY,
    resendApiKey: process.env.RESEND_API_KEY,
    wordpressConfigured: !!getWpConfig(),
    r2Configured: !!getStudioConfig(),
  });

  // Channel-scoped: once SP6 adds other distribution channels, a non-WordPress "sent" row must
  // never surface as the WordPress card's last successful publication.
  const [lastPub] = await db.select({ at: distributions.at }).from(distributions)
    .where(and(eq(distributions.channel, "wordpress"), eq(distributions.status, "sent")))
    .orderBy(desc(distributions.at)).limit(1);
  const [lastRun] = await db.select({ at: pipelineRuns.startedAt, status: pipelineRuns.status })
    .from(pipelineRuns).orderBy(desc(pipelineRuns.startedAt)).limit(1);
  const tokens = await getOpenRouterTokensMasked();
  const now = new Date();
  const tokenSummary = {
    active: tokens.filter((t) => t.active && !(t.cooldownUntil && t.cooldownUntil > now)).length,
    cooldown: tokens.filter((t) => t.active && t.cooldownUntil && t.cooldownUntil > now).length,
  };

  const base = {} as Record<IntegrationName, { configured: boolean; kind: (typeof INTEGRATION_META)[IntegrationName]["kind"]; management: (typeof INTEGRATION_META)[IntegrationName]["management"] }>;
  for (const name of Object.keys(INTEGRATION_META) as IntegrationName[]) {
    base[name] = { configured: configured[name], ...INTEGRATION_META[name] };
  }

  return {
    ...base,
    wordpress: { ...base.wordpress, lastSuccessAt: lastPub?.at ?? null },
    openrouter: { ...base.openrouter, tokenSummary },
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
    openrouterMinContentChars: 400,
  }).onConflictDoNothing().returning();
  if (created) return created;
  const [again] = await db.select().from(pipelineSettings).where(eq(pipelineSettings.id, 1));
  return again;
}

import {
  pgTable, pgEnum, text, boolean, timestamp, integer, real, jsonb, uuid, vector, index, uniqueIndex, check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type { RawItem } from "@/lib/rss/parse-feed";

// ---- SP5 Task 4: pause/resume checkpoint payload ----
// The REMAINING stories (groups) not yet processed when a run is paused. Each story is an array
// of members — the exact shape executeRun's per-story loop already works with (a story = a group
// of same-story candidates), so no conversion is needed on pause (capture) or resume (consume).
// Fully JSON-serializable: RawItem (lib/rss/parse-feed.ts) is plain data (strings only), and
// lib/rss/parse-feed.ts has no dependency on this file (or the db layer at all), so this import
// creates no cycle with db/index.ts's `export * from "./schema"`.
export type RunCheckpoint = {
  stories: { feedId: string; feedName: string; item: RawItem }[][];
};

// ---- run trigger parameters (persisted per run; resolved at trigger time) ----
// Single source of truth for what a run used: recency cutoff (resolved to an instant), the feed
// subset (null = all active feeds), and the item cap. executeRun reads this off the row.
export type RunParams = {
  recency:
    | { kind: "age"; hours: number; cutoffAt: string }  // "last N h" — cutoffAt resolved at open
    | { kind: "since"; cutoffAt: string }               // absolute ISO datetime
    | { kind: "none" };                                  // no cutoff
  feedIds: string[] | null;
  maxItems: number;
};

// ---- enums ----
export const articleStatus = pgEnum("article_status", [
  "draft", "pending", "in_review", "approved", "published", "rejected",
]);
export const feedFetchStatus = pgEnum("feed_fetch_status", ["ok", "error", "never"]);
export const pipelineStatus = pgEnum("pipeline_status", [
  "success", "partial", "failed", "running",
  // ---- SP5: run control ----
  "cancelled", // Stop: finalized by the user mid-run (Task 3)
  "paused",    // Pause: parked mid-run with a checkpoint, resumable (Task 4)
]);
export const distributionStatus = pgEnum("distribution_status", ["stubbed", "pending", "sent", "failed"]);
export const userRole = pgEnum("user_role", ["admin", "editor", "journalist"]);

// ---- Better-Auth tables ----
export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  role: userRole("role").notNull().default("journalist"),
  banned: boolean("banned").notNull().default(false),
  banReason: text("ban_reason"),
  banExpires: timestamp("ban_expires"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  lastLoginAt: timestamp("last_login_at"),
});

export const session = pgTable("session", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  token: text("token").notNull().unique(),
  expiresAt: timestamp("expires_at").notNull(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  impersonatedBy: text("impersonated_by"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const account = pgTable("account", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  password: text("password"),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: timestamp("access_token_expires_at"),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at"),
  scope: text("scope"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const verification = pgTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// ---- taxonomy mirror ----
export const wpCategories = pgTable("wp_categories", {
  id: uuid("id").primaryKey().defaultRandom(),
  wpId: integer("wp_id"),
  name: text("name").notNull(),
  slug: text("slug").notNull(),
  articleCount: integer("article_count").notNull().default(0),
});

export const wpTags = pgTable("wp_tags", {
  id: uuid("id").primaryKey().defaultRandom(),
  wpId: integer("wp_id"),
  name: text("name").notNull(),
  slug: text("slug").notNull(),
  articleCount: integer("article_count").notNull().default(0),
});

// ---- feeds & raw items ----
export const feeds = pgTable("feeds", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  feedUrl: text("feed_url").notNull(),
  siteUrl: text("site_url"),
  active: boolean("active").notNull().default(true),
  lastFetchAt: timestamp("last_fetch_at"),
  lastFetchStatus: feedFetchStatus("last_fetch_status").notNull().default("never"),
  itemsCaptured7d: integer("items_captured_7d").notNull().default(0),
  // ---- SP8: failure-streak tracking ----
  // Consecutive FAILED parse attempts, maintained by lib/pipeline/feed-health.ts's
  // updateFeedHealth() (called from executeRun's phase-1 feed-read loop, lib/pipeline/run.ts):
  // reset to 0 on a successful read, incremented atomically on a failed one. Feeds
  // deriveFeedHealth's "failing" (>=3) / "degraded" (1-2) thresholds.
  consecutiveFailures: integer("consecutive_failures").notNull().default(0),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const rawItems = pgTable("raw_items", {
  id: uuid("id").primaryKey().defaultRandom(),
  feedId: uuid("feed_id").notNull().references(() => feeds.id, { onDelete: "cascade" }),
  guid: text("guid").notNull(),
  url: text("url").notNull(),
  contentHash: text("content_hash").notNull(),
  rawTitle: text("raw_title"),
  rawBody: text("raw_body"),
  fetchedAt: timestamp("fetched_at").notNull().defaultNow(),
}, (t) => [index("raw_items_hash_idx").on(t.contentHash)]);

// ---- clusters ----
export const clusters = pgTable("clusters", {
  id: uuid("id").primaryKey().defaultRandom(),
  label: text("label"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// ---- articles ----
export const articles = pgTable("articles", {
  id: uuid("id").primaryKey().defaultRandom(),
  title: text("title").notNull(),
  bodyHtml: text("body_html").notNull().default(""),
  excerpt: text("excerpt"),
  status: articleStatus("status").notNull().default("pending"),
  categoryId: uuid("category_id").references(() => wpCategories.id),
  featuredImageUrl: text("featured_image_url"),
  imageCredit: text("image_credit"),
  imageSourceUrl: text("image_source_url"),
  aiAuthor: boolean("ai_author").notNull().default(true),
  createdBy: text("created_by").references(() => user.id),
  clusterId: uuid("cluster_id").references(() => clusters.id),
  // 0-100 quality score from lib/pipeline/score.ts (corroboration, cluster cohesion,
  // completeness, image presence, confidence penalties — see that file for the weighting).
  // Nullable: null until computed. SP4 Task 6 wires this into stageItem's insert; SP6's
  // auto-publish gate reads it against pipelineSettings.scoreThreshold.
  score: integer("score"),
  confidenceFlags: jsonb("confidence_flags").$type<{
    categoryUncertain?: boolean; imageMissing?: boolean; clusterUncertain?: boolean;
    // Set by the pipeline when a provider outage forced a mock LLM/embedding fallback, so the
    // review queue can visibly flag the article as produced under degraded conditions.
    aiDegraded?: boolean;
  }>().notNull().default({}),
  lockedBy: text("locked_by").references(() => user.id),
  lockedAt: timestamp("locked_at"),
  rejectReason: text("reject_reason"),
  generatedAt: timestamp("generated_at"),
  scheduledAt: timestamp("scheduled_at"),
  publishedAt: timestamp("published_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => [
  index("articles_status_idx").on(t.status),
  // Published articles must record when they were published; non-published rows
  // (draft/pending/approved/rejected/...) legitimately keep published_at NULL.
  check("articles_published_has_date", sql`${t.status} <> 'published' OR ${t.publishedAt} IS NOT NULL`),
]);

export const articleSources = pgTable("article_sources", {
  id: uuid("id").primaryKey().defaultRandom(),
  articleId: uuid("article_id").notNull().references(() => articles.id, { onDelete: "cascade" }),
  mediaName: text("media_name").notNull(),
  url: text("url").notNull(),
});

export const articleTags = pgTable("article_tags", {
  id: uuid("id").primaryKey().defaultRandom(),
  articleId: uuid("article_id").notNull().references(() => articles.id, { onDelete: "cascade" }),
  tagName: text("tag_name").notNull(),
  isNew: boolean("is_new").notNull().default(false),
});

export const articleRevisions = pgTable("article_revisions", {
  id: uuid("id").primaryKey().defaultRandom(),
  articleId: uuid("article_id").notNull().references(() => articles.id, { onDelete: "cascade" }),
  actorId: text("actor_id").references(() => user.id),
  action: text("action").notNull(), // e.g. "généré", "modifié", "approuvé", "rejeté"
  detail: text("detail"),
  at: timestamp("at").notNull().defaultNow(),
});

export const articleEmbeddings = pgTable("article_embeddings", {
  articleId: uuid("article_id").primaryKey().references(() => articles.id, { onDelete: "cascade" }),
  embedding: vector("embedding", { dimensions: 1024 }),
}, (t) => [index("article_embeddings_hnsw").using("hnsw", t.embedding.op("vector_cosine_ops"))]);

// ---- pipeline observability ----
export const pipelineRuns = pgTable("pipeline_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  triggeredBy: text("triggered_by").notNull().default("scheduled"), // scheduled | manual
  status: pipelineStatus("status").notNull().default("running"),
  feedsRead: integer("feeds_read").notNull().default(0),
  newItems: integer("new_items").notNull().default(0),
  published: integer("published").notNull().default(0),
  startedAt: timestamp("started_at").notNull().defaultNow(),
  finishedAt: timestamp("finished_at"),
  // ---- live progress (written incrementally by executeRun) ----
  phase: text("phase"), // reading_feeds | processing_items | finalizing
  feedsTotal: integer("feeds_total"),
  totalItems: integer("total_items"),
  processedItems: integer("processed_items").notNull().default(0),
  currentStage: text("current_stage"),
  currentItem: text("current_item"),
  // ---- SP5: run control (cooperative — polled by executeRun at safe boundaries) ----
  cancelRequested: boolean("cancel_requested").notNull().default(false), // Stop (Task 3)
  pauseRequested: boolean("pause_requested").notNull().default(false),   // Pause (Task 4)
  // Remaining-stories payload for pause/resume (SP5 Task 4): null until a run is paused; cleared
  // again on resume (resumeRun clears it before re-invoking executeRun). See RunCheckpoint above.
  checkpoint: jsonb("checkpoint").$type<RunCheckpoint>(),
  // Parameters this run used (recency/feeds/maxItems), resolved at trigger time. NULL for runs
  // created before this feature. See RunParams above.
  params: jsonb("params").$type<RunParams>(),
}, (t) => [
  // DB-level overlap interlock: at most one row may be 'running' OR 'paused' at any time — a
  // paused run still holds the single slot (no new run starts while one is parked). A concurrent
  // runPipeline that races past the hasRunningRun() app check will hit a unique violation on
  // its opening insert and back off (returns status "skipped"). runPipeline's try/finally
  // always moves the row to a terminal status, so this can never dead-lock the slot.
  //
  // IMPORTANT: indexed on the constant `(1)`, NOT on any real column. A unique index on `status`
  // would only forbid two rows sharing the SAME value (e.g. two 'running' rows), NOT one 'running'
  // + one 'paused' coexisting. A unique index on `finished_at` wouldn't work either: NULLs are
  // distinct in a unique index, so many finished_at-NULL rows could coexist. Indexing a constant
  // makes every row that satisfies the WHERE predicate map to the SAME value `1`, so at most one
  // such row can ever exist.
  //
  // PREDICATE = `finished_at is null` (NOT `status in ('running','paused')`). Two reasons, both
  // load-bearing:
  //  1. Semantics: a run is active (holds the slot) exactly while unfinalized. executeRun's
  //     always-finalize `finally` (lib/pipeline/run.ts) writes a terminal status AND finished_at
  //     together; a paused run (SP5 Task 4) leaves finished_at null by design. So `finished_at is
  //     null` ⟺ status ∈ {running, paused}. reclaimStaleRuns() (lib/pipeline/overlap.ts) already
  //     uses this same `isNull(finished_at)` signal for "not yet finalized" — this predicate is the
  //     existing idiom, not a new invariant.
  //  2. Fresh-deploy safety (SQLSTATE 55P04): drizzle's migrate() applies ALL pending migrations in
  //     ONE transaction. On a fresh DB that transaction contains the ALTER TYPE ... ADD VALUE
  //     'paused'/'cancelled' migration. PostgreSQL forbids REFERENCING a newly-added enum value in
  //     the same transaction that added it, so any enum-literal predicate would abort the whole
  //     deploy. A `status::text` cast does NOT rescue it — the enum→text cast is not IMMUTABLE and
  //     is rejected in an index predicate (SQLSTATE 42P17). `finished_at is null` references no
  //     enum value at all, so it is immutable and deploy-safe. (Both failures verified empirically
  //     against Neon in a rolled-back transaction — see .superpowers/sp5-t1-report.md.)
  uniqueIndex("pipeline_runs_one_running").on(sql`(1)`).where(sql`${t.finishedAt} is null`),
]);

export const pipelineSteps = pgTable("pipeline_steps", {
  id: uuid("id").primaryKey().defaultRandom(),
  runId: uuid("run_id").notNull().references(() => pipelineRuns.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  status: pipelineStatus("status").notNull(),
  durationMs: integer("duration_ms"),
  errorMessage: text("error_message"),   // human-readable
  errorTechnical: text("error_technical"), // stack/detail behind "voir détails"
  // Per-item attribution for the run-detail view: null for feed-/run-level steps (RSS read, feed
  // failure, cap-reached); set to the raw_items.id for steps produced while staging one item.
  rawItemId: uuid("raw_item_id").references(() => rawItems.id, { onDelete: "set null" }),
  at: timestamp("at").notNull().defaultNow(),
});

// ---- pipeline settings (DB-backed, admin-editable singleton — SP1) ----
// Always exactly one row, id=1. Env vars (MAX_ITEMS_PER_RUN, CLUSTER_THRESHOLD, …) remain the seed
// default for the very first read (see getPipelineSettings()); after that this table is the
// runtime source of truth for run-behavior knobs. Secrets/provider creds/order stay env-only via
// getPipelineConfig() — never move those here.
export const pipelineSettings = pgTable("pipeline_settings", {
  id: integer("id").primaryKey().default(1),
  maxItemsPerRun: integer("max_items_per_run").notNull().default(20),
  perOperationTimeoutMs: integer("per_operation_timeout_ms").notNull().default(300000), // 5 min — wired in SP5
  clusterThreshold: real("cluster_threshold").notNull().default(0.83), // wired in SP4
  scoreThreshold: integer("score_threshold").notNull().default(70), // auto-publish min score — wired in SP6
  autoPublishEnabled: boolean("auto_publish_enabled").notNull().default(false), // wired in SP6
  autoPublishMinSources: integer("auto_publish_min_sources").notNull().default(2), // wired in SP6
  // Default recency cutoff (relative, hours) for a run. NULL = no cutoff (backward-compatible ship
  // default). The trigger dialog pre-fills from this; scheduled runs inherit it.
  defaultMaxItemAgeHours: integer("default_max_item_age_hours"),
  webSearchEnabled: boolean("web_search_enabled").notNull().default(false), // wired in SP4
  scheduleCron: text("schedule_cron"), // null = no in-app schedule — wired in SP2
  // ---- SP9a: optional email notification for alerts (default OFF, no-op without RESEND_API_KEY) ----
  alertEmailEnabled: boolean("alert_email_enabled").notNull().default(false),
  alertEmailRecipients: text("alert_email_recipients"), // comma-separated emails; null/empty = none
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// ---- alerts (SP9a — best-effort run_failed / feed_dark notifications) ----
// Written ONLY by lib/alerts/notify.ts's createAlert(), called from two best-effort sites:
// lib/pipeline/run.ts's executeRun finalize (type "run_failed", on a genuine terminal 'failed'
// status — never partial/cancelled/success/paused) and lib/pipeline/feed-health.ts's
// updateFeedHealth (type "feed_dark", on the failure-streak TRANSITION to the failing threshold,
// 3 — not on every subsequent failed read past it). `type` is plain TEXT, deliberately not a pg
// enum: this table's migration stays a trivial additive CREATE TABLE with no ALTER TYPE ADD VALUE
// landmine (see the pipeline_runs_one_running comment above for why that's unsafe inside drizzle's
// single-transaction migrate() on a fresh DB) — a TS union (AlertType, lib/alerts/notify.ts) already
// gives compile-time safety at the one write site.
// `entityId` is intentionally NOT a foreign key: it points at either a pipeline_runs.id or a
// feeds.id depending on `type`, and this table must keep alerting for a run/feed that itself gets
// deleted later (history, not a live join) — nullable for a hypothetical future alert with no
// single associated entity.
export const alerts = pgTable("alerts", {
  id: uuid("id").primaryKey().defaultRandom(),
  type: text("type").notNull(), // 'run_failed' | 'feed_dark' — see lib/alerts/notify.ts's AlertType
  title: text("title").notNull(), // French, short — e.g. "Exécution du pipeline échouée"
  detail: text("detail").notNull(), // French, one-sentence specifics (counts / feed name)
  entityId: uuid("entity_id"), // the run or feed id this alert is about
  read: boolean("read").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [index("alerts_read_created_idx").on(t.read, t.createdAt)]);

// ---- distributions (pluggable publish targets) ----
export const distributions = pgTable("distributions", {
  id: uuid("id").primaryKey().defaultRandom(),
  articleId: uuid("article_id").notNull().references(() => articles.id, { onDelete: "cascade" }),
  channel: text("channel").notNull().default("wordpress"),
  status: distributionStatus("status").notNull().default("stubbed"),
  externalId: text("external_id"),
  at: timestamp("at").notNull().defaultNow(),
}, (t) => [
  // At most one 'wordpress' distribution row per article (upsertDistribution's invariant,
  // lib/wp/publish.ts): guards against a theoretical race-created duplicate that would double a
  // row in the /published list. Partial (WHERE channel = 'wordpress') so other channels are
  // unconstrained — modeled on pipeline_runs_one_running above.
  uniqueIndex("distributions_one_wordpress_per_article").on(t.articleId).where(sql`${t.channel} = 'wordpress'`),
]);

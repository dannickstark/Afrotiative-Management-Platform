import {
  pgTable, pgEnum, text, boolean, timestamp, integer, jsonb, uuid, vector, index, uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// ---- enums ----
export const articleStatus = pgEnum("article_status", [
  "draft", "pending", "in_review", "approved", "published", "rejected",
]);
export const feedFetchStatus = pgEnum("feed_fetch_status", ["ok", "error", "never"]);
export const pipelineStatus = pgEnum("pipeline_status", ["success", "partial", "failed", "running"]);
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
}, (t) => [index("articles_status_idx").on(t.status)]);

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
}, (t) => [
  // DB-level overlap interlock: at most one run may be 'running' at any time. A concurrent
  // runPipeline that races past the hasRunningRun() app check will hit a unique violation on
  // its opening insert and back off (returns status "skipped"). runPipeline's try/finally
  // always moves the row to a terminal status, so this can never dead-lock the slot.
  uniqueIndex("pipeline_runs_one_running").on(t.status).where(sql`${t.status} = 'running'`),
]);

export const pipelineSteps = pgTable("pipeline_steps", {
  id: uuid("id").primaryKey().defaultRandom(),
  runId: uuid("run_id").notNull().references(() => pipelineRuns.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  status: pipelineStatus("status").notNull(),
  durationMs: integer("duration_ms"),
  errorMessage: text("error_message"),   // human-readable
  errorTechnical: text("error_technical"), // stack/detail behind "voir détails"
});

// ---- distributions (pluggable publish targets) ----
export const distributions = pgTable("distributions", {
  id: uuid("id").primaryKey().defaultRandom(),
  articleId: uuid("article_id").notNull().references(() => articles.id, { onDelete: "cascade" }),
  channel: text("channel").notNull().default("wordpress"),
  status: distributionStatus("status").notNull().default("stubbed"),
  externalId: text("external_id"),
  at: timestamp("at").notNull().defaultNow(),
});

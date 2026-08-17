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
  categoryIds: string[] | null;
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
  // Jeton {{category.color}} du studio (V1). Nullable : une catégorie sans couleur retombe sur
  // DEFAULT_CATEGORY_COLOR côté rendu, jamais sur une erreur.
  color: text("color"),
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

// Image candidate scrapée, avec sa provenance : le crédit et le lien source d'un choix MANUEL en
// découlent directement, ce qui est plus fiable qu'un crédit deviné par le modèle.
export type ImageCandidate = { url: string; sourceUrl: string; mediaName: string };

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
  // Images candidates en attente d'un choix manuel (mode `manual` du renvoi à l'IA). NULL = rien à
  // choisir. C'est cette seule colonne qui alimente le bac, le badge et le filtre du /queue — l'état
  // vit sur l'article, pas sur le job, pour survivre à la purge de celui-ci.
  pendingImageCandidates: jsonb("pending_image_candidates").$type<ImageCandidate[]>(),
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
  // SP « complétion » — la liste de travail des informations manquantes, calculée par
  // lib/pipeline/completeness.ts à la génération puis recalculée à chaque correction manuelle.
  // Volontairement DISTINCTE de confidenceFlags : celle-ci exprime un doute de l'IA sur la
  // qualité, celle-là énumère ce qui manque factuellement — les mélanger empêcherait de
  // distinguer « l'IA n'était pas sûre de la catégorie » de « il n'y a pas de catégorie ».
  // Ordre canonique garanti (MISSING_FIELD_KEYS).
  missingFields: jsonb("missing_fields").$type<string[]>().notNull().default([]),
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

// ---- « Renvoyer à l'IA » asynchrone (job détaché + progression sondée) ----
// Volontairement SÉPARÉ de pipeline_runs : l'index unique partiel « un seul run actif » de cette
// table doit rester valable, et une régénération doit pouvoir tourner PENDANT une ingestion.
// Les colonnes de statut sont en `text` et non en pgEnum : drizzle applique toutes les migrations
// en attente dans UNE transaction, et PostgreSQL interdit de référencer une valeur d'enum ajoutée
// dans cette même transaction (SQLSTATE 55P04) — voir le long commentaire sur pipeline_runs.
export const regenJobs = pgTable("regen_jobs", {
  id: uuid("id").primaryKey().defaultRandom(),
  actorId: text("actor_id").references(() => user.id),
  fields: jsonb("fields").notNull(),        // RegenerateFieldsInput
  imageMode: text("image_mode").notNull().default("auto"), // auto | manual (câblé en phase 3)
  total: integer("total").notNull(),
  done: integer("done").notNull().default(0),
  status: text("status").notNull().default("running"), // running | done | failed | cancelled
  cancelRequested: boolean("cancel_requested").notNull().default(false),
  startedAt: timestamp("started_at").notNull().defaultNow(),
  finishedAt: timestamp("finished_at"),
});

export const regenJobItems = pgTable("regen_job_items", {
  id: uuid("id").primaryKey().defaultRandom(),
  jobId: uuid("job_id").notNull().references(() => regenJobs.id, { onDelete: "cascade" }),
  articleId: uuid("article_id").notNull().references(() => articles.id, { onDelete: "cascade" }),
  title: text("title").notNull(),           // instantané, pour un rapport d'échec lisible
  stage: text("stage").notNull().default("queued"), // queued | extracting | generating | writing
  status: text("status").notNull().default("pending"), // pending | ok | failed | awaiting_image
  message: text("message"),
  startedAt: timestamp("started_at"),
  finishedAt: timestamp("finished_at"),
}, (t) => [
  // Un article est dans AU PLUS un item non terminé : deux jobs ne peuvent pas régénérer le même
  // article en même temps (double écriture, révisions entrelacées). Prédicat sur `finished_at is
  // null` et non sur `status`, pour la même raison d'immutabilité que pipeline_runs_one_running.
  // `awaiting_image` est TERMINAL : finished_at est renseigné, l'article redevient éligible — le
  // choix d'image en attente vit dans articles.pending_image_candidates, pas dans le job.
  uniqueIndex("regen_job_items_one_inflight_per_article").on(t.articleId).where(sql`${t.finishedAt} is null`),
  index("regen_job_items_job_idx").on(t.jobId),
]);

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
  // Minimum scraped-content length (chars) before an item is considered usable for generation —
  // below this, the pipeline falls back the same way it does for a failed/empty scrape. Tuning
  // knob for the OpenRouter token pool work; not env-seeded (like scoreThreshold above), so the
  // column default below is this setting's only source of truth on first seed.
  openrouterMinContentChars: integer("openrouter_min_content_chars").notNull().default(400),
  // Mode de choix de l'image à la une lors d'un renvoi à l'IA : `auto` = generateArticle choisit
  // lui-même parmi les images scrapées, via son chemin de génération partielle sensible à la
  // sélection (lib/ai/generate-article.ts) — aucun appel LLM dédié à part ; `manual` = les
  // candidats sont garés sur l'article et l'éditeur tranche depuis le bac du /queue. `text` et non
  // pgEnum — voir la contrainte globale du plan. Détail du choix : lib/pipeline/regen-plan.ts.
  regenerateImageMode: text("regenerate_image_mode").notNull().default("auto"),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// ---- OpenRouter token pool (DB-stored, encrypted — rotation/fallback across multiple keys) ----
// Each `tokenCiphertext` is the output of lib/diffusion/crypto.ts's encryptSecret (a self-
// describing "iv:authTag:ciphertext" string), same convention as socialChannelSettings.credentials
// above — never store a raw OpenRouter key in plaintext. `active` + `sortOrder` let an admin
// disable/reorder tokens without deleting history; `cooldownUntil`/`lastStatus`/`lastError` are
// written by the rotation logic (later task) when a token gets rate-limited or errors out.
export const openrouterTokens = pgTable("openrouter_tokens", {
  id: uuid("id").primaryKey().defaultRandom(),
  label: text("label").notNull(),
  tokenCiphertext: text("token_ciphertext").notNull(),
  active: boolean("active").notNull().default(true),
  sortOrder: integer("sort_order").notNull().default(0),
  cooldownUntil: timestamp("cooldown_until"),
  lastStatus: text("last_status"),
  lastUsedAt: timestamp("last_used_at"),
  lastError: text("last_error"),
  createdBy: text("created_by").references(() => user.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => [index("openrouter_tokens_active_order_idx").on(t.active, t.sortOrder)]);

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
  type: text("type").notNull(), // 'run_failed' | 'feed_dark' | 'diffusion_blocked' | 'token_expiring' — see lib/alerts/notify.ts's AlertType
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
  // ---- D1: social-channel diffusion (lib/diffusion/) — StubChannel today, D2→D6 replace only the
  // `send` behind each registry entry. All columns below are nullable / defaulted so the existing
  // WordPress insert (lib/wp/publish.ts's upsertDistribution, which never sets any of them) keeps
  // working completely unchanged. ----
  // The studio render (renders.id) that was actually distributed. NOT a foreign key, for the same
  // reason renders.subjectId isn't one (see its comment below): this is diffusion HISTORY, not a
  // live join, and must outlive a pruned render row. IMMUTABLE once a send has happened — it
  // materializes spec §1's "never re-render after a send": a retry re-sends this SAME image.
  renderId: uuid("render_id"),
  // The caption actually sent, as edited by the operator (AI proposes, human disposes — spec §3).
  caption: text("caption"),
  attempts: integer("attempts").notNull().default(0),
  // Last failure message, in French — surfaced next to the "Réessayer" button (spec §4/§7).
  lastError: text("last_error"),
  // Set only for a scheduler-created row awaiting its due time; null for a manual send (spec §1).
  scheduledFor: timestamp("scheduled_for"),
  sentAt: timestamp("sent_at"),
  // 'manual' | 'scheduled' — audit trail (spec §1/§7). Free TEXT, not a Postgres enum: same
  // reasoning as alerts.type above (no ALTER TYPE ADD VALUE landmine in drizzle's single-
  // transaction migrate() on a fresh DB). Null for every row written before this column existed
  // (all 'wordpress' rows — lib/wp/publish.ts never sets it, and is not touched by D1).
  triggeredBy: text("triggered_by"),
  // Who clicked "Publier sur {canal}" — null for a scheduled send (spec §1).
  actorId: text("actor_id").references(() => user.id),
}, (t) => [
  // At most one 'wordpress' distribution row per article (upsertDistribution's invariant,
  // lib/wp/publish.ts): guards against a theoretical race-created duplicate that would double a
  // row in the /published list. Partial (WHERE channel = 'wordpress') so other channels are
  // unconstrained — modeled on pipeline_runs_one_running above.
  uniqueIndex("distributions_one_wordpress_per_article").on(t.articleId).where(sql`${t.channel} = 'wordpress'`),
  // D1 §1's hard guarantee: at most one row per (article, non-wordpress channel) that is currently
  // 'pending' or already 'sent'. This is what stops the automatic scheduler (D1 Lot 4) from
  // doubling an operator's manual send, and vice-versa — whichever insert wins a race, the loser
  // hits SQLSTATE 23505 instead of silently creating a second live row. 'failed' rows do NOT hold
  // this slot, so a retry (a fresh insert for the same article+channel) is never blocked by a prior
  // failure. `status` is compared against enum literals ('pending'/'sent') that already existed in
  // distribution_status before this migration (see db/migrations/0000_curious_wong.sql) — unlike
  // the pipeline_runs_one_running predicate's ALTER-TYPE-in-the-same-transaction trap documented
  // above, referencing an ALREADY-EXISTING enum value in a predicate is safe on a fresh DB. No
  // NULLS NOT DISTINCT needed either (unlike render_templates_scope below): article_id and channel
  // are both NOT NULL here, so Postgres's default null-distinctness never comes into play.
  uniqueIndex("distributions_one_active_per_article_channel")
    .on(t.articleId, t.channel)
    .where(sql`${t.channel} <> 'wordpress' AND ${t.status} in ('pending', 'sent')`),
]);

// ---- D1: per-channel diffusion settings — one row per social channel, created LAZILY on first
// read (lib/diffusion/settings-core.ts's getChannelSettings) from that channel's registry defaults
// (lib/diffusion/channels.ts) rather than seeded here. `channel` is free TEXT (matches
// distributions.channel and render_templates.channel), not a foreign key to anything: there is no
// channels table, CHANNELS (lib/studio/tokens.ts) is the single source of truth for valid keys.
export const socialChannelSettings = pgTable("social_channel_settings", {
  channel: text("channel").primaryKey(),
  enabled: boolean("enabled").notNull().default(true),
  // Bounded (never exceeded) by that channel's captionLimits.max — enforced in
  // lib/diffusion/settings-core.ts's updateChannelSettingsCore, not at the DB layer, so the refusal
  // carries a French message naming the bound instead of a raw constraint violation.
  captionMaxChars: integer("caption_max_chars").notNull(),
  // Optional operator override of the AI caption prompt for this channel; null = use the default
  // prompt (spec §3).
  captionPrompt: text("caption_prompt"),
  // ---- automatic scheduler knobs (D1 Lot 4 — table ships now, scheduler wires into it later) ----
  // Off by default, like pipelineSettings.autoPublishEnabled: no channel auto-sends until an admin
  // opts in from /settings/social/[channel].
  autoEnabled: boolean("auto_enabled").notNull().default(false),
  autoIntervalHours: integer("auto_interval_hours").notNull().default(6),
  autoMaxBacklogDays: integer("auto_max_backlog_days").notNull().default(3),
  // Business-hours window default (08h–20h) — spec §5: "un média ne poste pas à 4 h du matin".
  autoWindowStartHour: integer("auto_window_start_hour").notNull().default(8),
  autoWindowEndHour: integer("auto_window_end_hour").notNull().default(20),
  lastAutoSendAt: timestamp("last_auto_send_at"),
  // ---- Task 1 (D2+D3): encrypted credential storage ----
  // Generic key→ciphertext map, NOT per-platform columns — Facebook needs a page id + token,
  // Instagram an IG user id + the SAME token, a future LinkedIn an organization URN, WhatsApp
  // none at all. Every value is the output of lib/diffusion/crypto.ts's encryptSecret (a
  // self-describing "iv:authTag:ciphertext" string), even for fields that aren't secrets by
  // themselves (e.g. a Facebook Page id) — one uniform "everything in here is encrypted"
  // invariant is much harder to violate by accident than a per-field "is this one sensitive?"
  // judgment call made separately for every new channel. Field NAMES are the adapter's business
  // (Task 2+ — e.g. lib/diffusion/meta/facebook.ts), never this schema's: adding LinkedIn's URN
  // later is a new key in this same jsonb blob, in application code, never a migration — the
  // criterion the brief sets for this design.
  credentials: jsonb("credentials").$type<Record<string, string>>(),
  // Plaintext, UI-only: when `credentials` was last written, so /settings/social/[channel] can
  // render "Défini le …" / "Non défini" without ever touching the encrypted blob itself (the
  // Server Component page never even reads `credentials` off this row for that reason — see
  // lib/diffusion/settings-core.ts's SocialChannelSettings type, which omits it). Cleared back to
  // null by "Supprimer" alongside `credentials`.
  credentialsSetAt: timestamp("credentials_set_at"),
  // ---- Task 2 (D7): token-expiry tracking (spec §4) ----
  // Plaintext, deliberately OUTSIDE `credentials`: a date is not a secret, and the settings form
  // must display/edit it directly (lib/diffusion/settings-core.ts's SocialChannelSettings type
  // therefore keeps it, unlike the encrypted blob it omits). Neither Meta nor LinkedIn exposes an
  // expiry on a cheap read, so this is TRACKED, not discovered: setChannelCredentialsCore defaults
  // it to now + 60 days on every credential write, and an admin can correct it here from LinkedIn's
  // token generator or Meta's Access Token Debugger. Null until credentials have ever been saved.
  tokenExpiresAt: timestamp("token_expires_at"),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// ---- V1 studio de gabarits ----
// AUCUN nouvel enum PostgreSQL, volontairement : colonnes `text` + unions TypeScript. Même
// raisonnement que `alerts.type` plus haut — un ALTER TYPE ... ADD VALUE est un piège dans le
// migrate() mono-transaction de drizzle sur une base neuve. Les unions vivent dans
// lib/studio/tokens.ts (TemplateContext, Channel) et lib/studio/formats.ts (FormatKey).
export const renderTemplates = pgTable("render_templates", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  context: text("context").notNull(),
  // null = gabarit par défaut du contexte (tous canaux). Les valeurs viennent de CHANNELS.
  channel: text("channel"),
  // null = gabarit par défaut du couple (contexte, canal).
  categoryId: uuid("category_id").references(() => wpCategories.id, { onDelete: "cascade" }),
  format: text("format").notNull(),
  // FIGÉES à la création depuis FORMAT_PRESETS : modifier un préréglage ne doit jamais changer
  // les dimensions d'un gabarit existant, cela casserait sa mise en page.
  width: integer("width").notNull(),
  height: integer("height").notNull(),
  // COPIE DE TRAVAIL (le brouillon). Le résolveur ne lit JAMAIS cette colonne — il lit
  // render_template_versions. C'est ce qui donne un sens réel au couple brouillon/publié.
  scene: jsonb("scene").notNull(),
  // Numéro (pas identifiant) de la version en vigueur ; null = jamais publié. Volontairement SANS
  // clé étrangère : une FK créerait un cycle render_templates -> versions -> render_templates,
  // pénible à migrer et sans bénéfice, puisque (template_id, version) est déjà unique.
  // « Publié » ⟺ publishedVersion IS NOT NULL — pas de colonne `status`, qui serait une seconde
  // source de vérité : un gabarit publié AVEC des modifications en cours est l'état normal.
  publishedVersion: integer("published_version"),
  archived: boolean("archived").notNull().default(false),
  createdBy: text("created_by").references(() => user.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => [
  // Unicité de la portée de résolution. ATTENTION : drizzle 0.45 n'expose PAS .nullsNotDistinct()
  // sur uniqueIndex(), et sans ce modificateur l'index est INEFFICACE ici — PostgreSQL traite les
  // NULL comme distincts, donc deux gabarits (social_post, facebook, NULL) coexisteraient. Le
  // modificateur est ajouté à la main dans la migration (CREATE UNIQUE INDEX ... NULLS NOT
  // DISTINCT ..., db/migrations/0015_slow_selene.sql — la table est neuve dans cette migration,
  // donc un simple CREATE suffit ; pas de DROP INDEX préalable ici). Une régénération naïve de la
  // migration (bun run db:generate) PERDRAIT ce modificateur : si le schéma bouge à nouveau, il
  // faudra le rajouter à la main dans la nouvelle migration générée.
  uniqueIndex("render_templates_scope")
    .on(t.context, t.channel, t.categoryId)
    .where(sql`${t.archived} = false`),
  index("render_templates_lookup_idx").on(t.context, t.channel),
]);

export const renderTemplateVersions = pgTable("render_template_versions", {
  id: uuid("id").primaryKey().defaultRandom(),
  templateId: uuid("template_id").notNull().references(() => renderTemplates.id, { onDelete: "cascade" }),
  version: integer("version").notNull(),
  // INSTANTANÉ IMMUABLE. Une fois écrite, cette scène ne change plus : c'est elle qui garantit
  // qu'un rendu passé reste reproductible même après vingt modifications du brouillon.
  scene: jsonb("scene").notNull(),
  publishedBy: text("published_by").references(() => user.id),
  publishedAt: timestamp("published_at").notNull().defaultNow(),
}, (t) => [uniqueIndex("render_template_versions_unique").on(t.templateId, t.version)]);

export const renderAssets = pgTable("render_assets", {
  id: uuid("id").primaryKey().defaultRandom(),
  kind: text("kind").notNull(), // 'image' | 'font'
  name: text("name").notNull(),
  storageKey: text("storage_key").notNull(),
  url: text("url").notNull(),
  mime: text("mime").notNull(),
  bytes: integer("bytes").notNull(),
  width: integer("width"),
  height: integer("height"),
  fontFamily: text("font_family"),
  fontWeight: integer("font_weight"),
  fontStyle: text("font_style"),
  uploadedBy: text("uploaded_by").references(() => user.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// Cache IMMUABLE des sorties. Deux propriétés en découlent : un appel identique renvoie la ligne
// existante sans re-rendre, et « on ne re-rend pas après diffusion » s'applique tout seul — D1
// posera un render_id sur la ligne distributions, et cette ligne-là ne bouge plus jamais.
export const renders = pgTable("renders", {
  id: uuid("id").primaryKey().defaultRandom(),
  templateId: uuid("template_id").notNull(),
  templateVersion: integer("template_version").notNull(),
  context: text("context").notNull(),
  subjectType: text("subject_type").notNull(), // 'article' | 'manual'
  // PAS une clé étrangère vers articles : un rendu doit survivre à la suppression de son article
  // (historique de diffusion, pas jointure vivante) — même raisonnement que alerts.entityId.
  subjectId: uuid("subject_id"),
  inputHash: text("input_hash").notNull(),
  storageKey: text("storage_key").notNull(),
  url: text("url").notNull(),
  width: integer("width").notNull(),
  height: integer("height").notNull(),
  bytes: integer("bytes").notNull(),
  degraded: boolean("degraded").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  uniqueIndex("renders_input_hash_unique").on(t.inputHash),
  index("renders_subject_idx").on(t.subjectType, t.subjectId),
]);

// ---- Module Vidéo (SP1 : contrat, brief & import) ----
export const videoProjectStatus = pgEnum("video_project_status", [
  "brouillon", "en_ecriture", "pret_a_tourner", "tourne", "en_montage", "publie", "archive",
]);
export const scriptPlatform = pgEnum("script_platform", [
  "youtube_long", "youtube_short", "tiktok", "reel", "interview",
]);
export const beatKind = pgEnum("beat_kind", [
  "narration", "question", "reponse", "insert", "broll",
  "transition", "texte_ecran", "son", "note",
]);
export const takeStatus = pgEnum("take_status", ["bonne", "mauvaise", "a_revoir"]);
export const insertKind = pgEnum("insert_kind", ["image", "video", "extrait", "graphique", "fichier"]);
// `interdit` = refusé par le garde SSRF (lib/url-guard.ts) ; `mort` = URL légitime qui ne répond
// plus. Les deux se lisent différemment côté monteur, d'où deux valeurs et non une.
export const linkStatus = pgEnum("link_status", ["non_verifie", "ok", "mort", "interdit"]);
export const scriptJournalSource = pgEnum("script_journal_source", ["copier_coller", "mcp", "manuel"]);
// "en_attente" (round de correction 1, Task 9) : un diff préparé mais pas encore appliqué —
// prepareImportCore doit journaliser AVANT que l'utilisateur ne décide, pour qu'applyImportCore
// puisse relire l'entrée par journalId. Distinct d'"annule" (qui signifie « revenu en arrière »,
// pas « jamais appliqué ») : une requête sur les imports annulés ne doit pas remonter les diffs
// simplement en attente de décision.
export const scriptJournalOutcome = pgEnum("script_journal_outcome", ["rejete", "en_attente", "applique", "annule"]);

export const videoProjects = pgTable("video_projects", {
  id: uuid("id").primaryKey().defaultRandom(),
  title: text("title").notNull(),
  subject: text("subject"),
  status: videoProjectStatus("status").notNull().default("brouillon"),
  // Origine double (spec §décision 6) : un projet dérive d'un article approuvé OU naît autonome.
  articleId: uuid("article_id").references(() => articles.id),
  createdBy: text("created_by").references(() => user.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => [
  index("video_projects_status_idx").on(t.status),
  index("video_projects_article_idx").on(t.articleId),
]);

export const scriptVariants = pgTable("script_variants", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").notNull().references(() => videoProjects.id, { onDelete: "cascade" }),
  platform: scriptPlatform("platform").notNull(),
  targetDurationSec: integer("target_duration_sec"),
  aspectRatio: text("aspect_ratio").notNull().default("16:9"),
  position: integer("position").notNull(),
  // Ouverte au SP6 (variantes dérivées) : une variante TikTok pointe vers le YouTube long dont elle
  // dérive. Nulle partout au SP1.
  derivedFromId: uuid("derived_from_id"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => [
  uniqueIndex("script_variants_project_position_uq").on(t.projectId, t.position),
  index("script_variants_project_idx").on(t.projectId),
]);

// DÉCLARÉE AVANT script_beats : scriptBeats.speakerId la référence. Ouverte au SP5.
export const interviewSpeakers = pgTable("interview_speakers", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").notNull().references(() => videoProjects.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  role: text("role"),
  consentGiven: boolean("consent_given").notNull().default(false),
  consentNote: text("consent_note"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const scriptBeats = pgTable("script_beats", {
  id: uuid("id").primaryKey().defaultRandom(),
  variantId: uuid("variant_id").notNull().references(() => scriptVariants.id, { onDelete: "cascade" }),
  // L'identifiant stable venant du JSON — LA clé de fusion. Sans lui, un ré-import ne peut que
  // remplacer (spec §5.3).
  externalId: text("external_id").notNull(),
  position: integer("position").notNull(),
  kind: beatKind("kind").notNull(),
  spokenText: text("spoken_text").notNull().default(""),
  directionNote: text("direction_note"),
  screenText: text("screen_text"),
  transitionIn: text("transition_in"),
  transitionOut: text("transition_out"),
  estimatedDurationSec: integer("estimated_duration_sec").notNull().default(0),
  durationOverrideSec: integer("duration_override_sec"),
  framing: jsonb("framing").$type<Record<string, unknown>>().notNull().default({}),
  speakerId: uuid("speaker_id").references(() => interviewSpeakers.id),
  answersBeatId: uuid("answers_beat_id"),
  sources: jsonb("sources").$type<string[]>().notNull().default([]),
  // Le fragment de payload EXACTEMENT tel qu'appliqué au dernier import : c'est la « base » de la
  // fusion à trois voies. Sans lui, impossible de distinguer « Claude a changé ce beat » de
  // « l'humain l'a changé », et un ré-import écrase en silence.
  importedSnapshot: jsonb("imported_snapshot").$type<Record<string, unknown>>(),
  locallyEditedAt: timestamp("locally_edited_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => [
  uniqueIndex("script_beats_variant_external_uq").on(t.variantId, t.externalId),
  // PAS d'unicité sur position : un réordonnancement écrit plusieurs lignes dans une transaction et
  // passerait par des états transitoirement en doublon. La continuité est une invariante
  // applicative, reconstruite par applyMerge (spec §1.4).
  index("script_beats_variant_position_idx").on(t.variantId, t.position),
]);

export const beatInserts = pgTable("beat_inserts", {
  id: uuid("id").primaryKey().defaultRandom(),
  beatId: uuid("beat_id").notNull().references(() => scriptBeats.id, { onDelete: "cascade" }),
  kind: insertKind("kind").notNull(),
  url: text("url"),
  r2Key: text("r2_key"),
  tcIn: text("tc_in"),
  tcOut: text("tc_out"),
  displayDurationSec: integer("display_duration_sec"),
  credit: text("credit"),
  rightsNote: text("rights_note"),
  linkStatus: linkStatus("link_status").notNull().default("non_verifie"),
  linkCheckedAt: timestamp("link_checked_at"),
  position: integer("position").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => [index("beat_inserts_beat_idx").on(t.beatId)]);

// Ouverte au SP4 (journal de prises).
export const beatTakes = pgTable("beat_takes", {
  id: uuid("id").primaryKey().defaultRandom(),
  beatId: uuid("beat_id").notNull().references(() => scriptBeats.id, { onDelete: "cascade" }),
  number: integer("number").notNull(),
  status: takeStatus("status").notNull(),
  startedAt: timestamp("started_at"),
  note: text("note"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [uniqueIndex("beat_takes_beat_number_uq").on(t.beatId, t.number)]);

// Une seule table pour TOUT ce qui vient de l'extérieur : import collé (SP1) et écriture d'agent
// MCP (SP1 bis). C'est ce qui rend l'écriture complète des agents réversible.
export const scriptJournal = pgTable("script_journal", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").notNull().references(() => videoProjects.id, { onDelete: "cascade" }),
  variantId: uuid("variant_id").references(() => scriptVariants.id, { onDelete: "set null" }),
  source: scriptJournalSource("source").notNull(),
  toolName: text("tool_name"),
  actorUserId: text("actor_user_id").references(() => user.id),
  schemaVersion: text("schema_version"),
  // Conservé BRUT, avant toute normalisation : quand un import échoue, la seule façon de
  // diagnostiquer est de relire ce que le modèle a produit, pas ce que le parseur en a compris.
  rawPayload: jsonb("raw_payload"),
  errorReport: jsonb("error_report").$type<unknown[]>().notNull().default([]),
  diff: jsonb("diff").$type<Record<string, unknown>>().notNull().default({}),
  applied: jsonb("applied").$type<Record<string, unknown>>().notNull().default({}),
  outcome: scriptJournalOutcome("outcome").notNull(),
  revertedAt: timestamp("reverted_at"),
  // Les arguments exacts reçus par l'outil MCP. Quand un agent se comporte mal, c'est la seule
  // façon de reconstituer ce qu'il a réellement demandé.
  toolArgs: jsonb("tool_args").$type<Record<string, unknown>>(),
  // Posé quand un humain ouvre le projet après une écriture d'agent. `null` = non relue.
  // Sans cette colonne, « non relue » serait une intention plutôt qu'un état.
  reviewedAt: timestamp("reviewed_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [index("script_journal_project_idx").on(t.projectId, t.createdAt)]);

export const videoSettings = pgTable("video_settings", {
  id: uuid("id").primaryKey().defaultRandom(),
  briefTemplate: text("brief_template").notNull(),
  wordsPerMinute: integer("words_per_minute").notNull().default(155),
  // Interrupteur global du serveur MCP. Ouvert par défaut : le module n'a d'intérêt que branché.
  // Sa raison d'être est l'urgence — couper tous les agents d'un geste sans révoquer, puis
  // recréer, les jetons un par un.
  mcpEnabled: boolean("mcp_enabled").notNull().default(true),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  updatedBy: text("updated_by").references(() => user.id),
});

// ---- Sous-projet 1 bis : jetons d'API pour le serveur MCP ----
// DÉLIBÉRÉMENT différent de `openrouter_tokens`, qui CHIFFRE ses jetons parce qu'il doit les
// redonner en clair à un fournisseur tiers. Ici, personne n'a jamais besoin du jeton en clair après
// sa création : on n'en garde donc qu'un HACHÉ, et une fuite de base ne donne aucun accès.
export const apiTokens = pgTable("api_tokens", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  // Les premiers caractères du jeton, en clair : c'est ce qui permet de RETROUVER la ligne sans
  // parcourir toute la table, et à l'utilisateur de reconnaître son jeton dans la liste.
  prefix: text("prefix").notNull(),
  tokenHash: text("token_hash").notNull(),
  lastUsedAt: timestamp("last_used_at"),
  // Révocation DOUCE : la ligne survit, donc l'historique du journal continue de nommer la personne
  // qui a écrit. Une suppression dure ferait perdre cette attribution rétroactivement.
  revokedAt: timestamp("revoked_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  uniqueIndex("api_tokens_prefix_uq").on(t.prefix),
  index("api_tokens_user_idx").on(t.userId),
]);

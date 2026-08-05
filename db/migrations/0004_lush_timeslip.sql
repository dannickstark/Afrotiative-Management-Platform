CREATE TABLE "pipeline_settings" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"max_items_per_run" integer DEFAULT 20 NOT NULL,
	"per_operation_timeout_ms" integer DEFAULT 300000 NOT NULL,
	"cluster_threshold" real DEFAULT 0.83 NOT NULL,
	"score_threshold" integer DEFAULT 70 NOT NULL,
	"auto_publish_enabled" boolean DEFAULT false NOT NULL,
	"auto_publish_min_sources" integer DEFAULT 2 NOT NULL,
	"web_search_enabled" boolean DEFAULT false NOT NULL,
	"schedule_cron" text,
	"updated_at" timestamp DEFAULT now() NOT NULL
);

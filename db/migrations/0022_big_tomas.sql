CREATE TABLE "regen_job_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"article_id" uuid NOT NULL,
	"title" text NOT NULL,
	"stage" text DEFAULT 'queued' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"message" text,
	"started_at" timestamp,
	"finished_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "regen_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_id" text,
	"fields" jsonb NOT NULL,
	"image_mode" text DEFAULT 'auto' NOT NULL,
	"total" integer NOT NULL,
	"done" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"cancel_requested" boolean DEFAULT false NOT NULL,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"finished_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "regen_job_items" ADD CONSTRAINT "regen_job_items_job_id_regen_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."regen_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "regen_job_items" ADD CONSTRAINT "regen_job_items_article_id_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."articles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "regen_jobs" ADD CONSTRAINT "regen_jobs_actor_id_user_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "regen_job_items_one_inflight_per_article" ON "regen_job_items" USING btree ("article_id") WHERE "regen_job_items"."finished_at" is null;--> statement-breakpoint
CREATE INDEX "regen_job_items_job_idx" ON "regen_job_items" USING btree ("job_id");
CREATE TABLE "social_channel_settings" (
	"channel" text PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"caption_max_chars" integer NOT NULL,
	"caption_prompt" text,
	"auto_enabled" boolean DEFAULT false NOT NULL,
	"auto_interval_hours" integer DEFAULT 6 NOT NULL,
	"auto_max_backlog_days" integer DEFAULT 3 NOT NULL,
	"auto_window_start_hour" integer DEFAULT 8 NOT NULL,
	"auto_window_end_hour" integer DEFAULT 20 NOT NULL,
	"last_auto_send_at" timestamp,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "distributions" ADD COLUMN "render_id" uuid;--> statement-breakpoint
ALTER TABLE "distributions" ADD COLUMN "caption" text;--> statement-breakpoint
ALTER TABLE "distributions" ADD COLUMN "attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "distributions" ADD COLUMN "last_error" text;--> statement-breakpoint
ALTER TABLE "distributions" ADD COLUMN "scheduled_for" timestamp;--> statement-breakpoint
ALTER TABLE "distributions" ADD COLUMN "sent_at" timestamp;--> statement-breakpoint
ALTER TABLE "distributions" ADD COLUMN "triggered_by" text;--> statement-breakpoint
ALTER TABLE "distributions" ADD COLUMN "actor_id" text;--> statement-breakpoint
ALTER TABLE "distributions" ADD CONSTRAINT "distributions_actor_id_user_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "distributions_one_active_per_article_channel" ON "distributions" USING btree ("article_id","channel") WHERE "distributions"."channel" <> 'wordpress' AND "distributions"."status" in ('pending', 'sent');
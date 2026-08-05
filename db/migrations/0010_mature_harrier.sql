CREATE TABLE "alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" text NOT NULL,
	"title" text NOT NULL,
	"detail" text NOT NULL,
	"entity_id" uuid,
	"read" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pipeline_settings" ADD COLUMN "alert_email_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "pipeline_settings" ADD COLUMN "alert_email_recipients" text;--> statement-breakpoint
CREATE INDEX "alerts_read_created_idx" ON "alerts" USING btree ("read","created_at");
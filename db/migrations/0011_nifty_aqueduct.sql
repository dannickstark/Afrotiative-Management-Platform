ALTER TABLE "pipeline_runs" ADD COLUMN "params" jsonb;--> statement-breakpoint
ALTER TABLE "pipeline_settings" ADD COLUMN "default_max_item_age_hours" integer;
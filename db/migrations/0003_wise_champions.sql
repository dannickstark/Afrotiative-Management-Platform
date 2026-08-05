ALTER TABLE "pipeline_runs" ADD COLUMN "phase" text;--> statement-breakpoint
ALTER TABLE "pipeline_runs" ADD COLUMN "feeds_total" integer;--> statement-breakpoint
ALTER TABLE "pipeline_runs" ADD COLUMN "total_items" integer;--> statement-breakpoint
ALTER TABLE "pipeline_runs" ADD COLUMN "processed_items" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "pipeline_runs" ADD COLUMN "current_stage" text;--> statement-breakpoint
ALTER TABLE "pipeline_runs" ADD COLUMN "current_item" text;--> statement-breakpoint
ALTER TABLE "pipeline_steps" ADD COLUMN "at" timestamp DEFAULT now() NOT NULL;
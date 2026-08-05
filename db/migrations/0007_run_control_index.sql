DROP INDEX "pipeline_runs_one_running";--> statement-breakpoint
ALTER TABLE "pipeline_runs" ADD COLUMN "cancel_requested" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "pipeline_runs" ADD COLUMN "pause_requested" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "pipeline_runs" ADD COLUMN "checkpoint" jsonb;--> statement-breakpoint
CREATE UNIQUE INDEX "pipeline_runs_one_running" ON "pipeline_runs" USING btree ("status") WHERE "pipeline_runs"."finished_at" is null;

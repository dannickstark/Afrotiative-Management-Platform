DROP INDEX "pipeline_runs_one_running";--> statement-breakpoint
CREATE UNIQUE INDEX "pipeline_runs_one_running" ON "pipeline_runs" USING btree ((1)) WHERE "pipeline_runs"."finished_at" is null;
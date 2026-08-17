CREATE TABLE "video_categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"instructions" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"updated_by" text
);
--> statement-breakpoint
ALTER TABLE "video_projects" ADD COLUMN "category_id" uuid;--> statement-breakpoint
ALTER TABLE "video_categories" ADD CONSTRAINT "video_categories_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "video_categories_name_unique" ON "video_categories" USING btree (lower("name"));--> statement-breakpoint
CREATE INDEX "video_categories_position_idx" ON "video_categories" USING btree ("position");--> statement-breakpoint
ALTER TABLE "video_projects" ADD CONSTRAINT "video_projects_category_id_video_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."video_categories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "video_projects_category_idx" ON "video_projects" USING btree ("category_id");
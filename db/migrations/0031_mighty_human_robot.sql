CREATE TABLE "montage_shares" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"token_prefix" text NOT NULL,
	"token_hash" text NOT NULL,
	"created_by" text,
	"expires_at" timestamp,
	"revoked_at" timestamp,
	"last_accessed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "montage_shares" ADD CONSTRAINT "montage_shares_project_id_video_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."video_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "montage_shares" ADD CONSTRAINT "montage_shares_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "montage_shares_prefix_uq" ON "montage_shares" USING btree ("token_prefix");--> statement-breakpoint
CREATE INDEX "montage_shares_project_idx" ON "montage_shares" USING btree ("project_id");
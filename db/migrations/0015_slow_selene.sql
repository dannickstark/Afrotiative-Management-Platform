CREATE TABLE "render_assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"storage_key" text NOT NULL,
	"url" text NOT NULL,
	"mime" text NOT NULL,
	"bytes" integer NOT NULL,
	"width" integer,
	"height" integer,
	"font_family" text,
	"font_weight" integer,
	"font_style" text,
	"uploaded_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "render_template_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"template_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"scene" jsonb NOT NULL,
	"published_by" text,
	"published_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "render_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"context" text NOT NULL,
	"channel" text,
	"category_id" uuid,
	"format" text NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"scene" jsonb NOT NULL,
	"published_version" integer,
	"archived" boolean DEFAULT false NOT NULL,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "renders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"template_id" uuid NOT NULL,
	"template_version" integer NOT NULL,
	"context" text NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" uuid,
	"input_hash" text NOT NULL,
	"storage_key" text NOT NULL,
	"url" text NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"bytes" integer NOT NULL,
	"degraded" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "wp_categories" ADD COLUMN "color" text;--> statement-breakpoint
ALTER TABLE "render_assets" ADD CONSTRAINT "render_assets_uploaded_by_user_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "render_template_versions" ADD CONSTRAINT "render_template_versions_template_id_render_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."render_templates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "render_template_versions" ADD CONSTRAINT "render_template_versions_published_by_user_id_fk" FOREIGN KEY ("published_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "render_templates" ADD CONSTRAINT "render_templates_category_id_wp_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."wp_categories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "render_templates" ADD CONSTRAINT "render_templates_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "render_template_versions_unique" ON "render_template_versions" USING btree ("template_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "render_templates_scope" ON "render_templates" USING btree ("context","channel","category_id") NULLS NOT DISTINCT WHERE "render_templates"."archived" = false;--> statement-breakpoint
CREATE INDEX "render_templates_lookup_idx" ON "render_templates" USING btree ("context","channel");--> statement-breakpoint
CREATE UNIQUE INDEX "renders_input_hash_unique" ON "renders" USING btree ("input_hash");--> statement-breakpoint
CREATE INDEX "renders_subject_idx" ON "renders" USING btree ("subject_type","subject_id");
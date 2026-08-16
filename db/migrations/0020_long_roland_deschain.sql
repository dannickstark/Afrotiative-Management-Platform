CREATE TYPE "public"."beat_kind" AS ENUM('narration', 'question', 'reponse', 'insert', 'broll', 'transition', 'texte_ecran', 'son', 'note');--> statement-breakpoint
CREATE TYPE "public"."insert_kind" AS ENUM('image', 'video', 'extrait', 'graphique', 'fichier');--> statement-breakpoint
CREATE TYPE "public"."link_status" AS ENUM('non_verifie', 'ok', 'mort', 'interdit');--> statement-breakpoint
CREATE TYPE "public"."script_journal_outcome" AS ENUM('rejete', 'applique', 'annule');--> statement-breakpoint
CREATE TYPE "public"."script_journal_source" AS ENUM('copier_coller', 'mcp', 'manuel');--> statement-breakpoint
CREATE TYPE "public"."script_platform" AS ENUM('youtube_long', 'youtube_short', 'tiktok', 'reel', 'interview');--> statement-breakpoint
CREATE TYPE "public"."take_status" AS ENUM('bonne', 'mauvaise', 'a_revoir');--> statement-breakpoint
CREATE TYPE "public"."video_project_status" AS ENUM('brouillon', 'en_ecriture', 'pret_a_tourner', 'tourne', 'en_montage', 'publie', 'archive');--> statement-breakpoint
CREATE TABLE "beat_inserts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"beat_id" uuid NOT NULL,
	"kind" "insert_kind" NOT NULL,
	"url" text,
	"r2_key" text,
	"tc_in" text,
	"tc_out" text,
	"display_duration_sec" integer,
	"credit" text,
	"rights_note" text,
	"link_status" "link_status" DEFAULT 'non_verifie' NOT NULL,
	"link_checked_at" timestamp,
	"position" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "beat_takes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"beat_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"status" "take_status" NOT NULL,
	"started_at" timestamp,
	"note" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "interview_speakers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"role" text,
	"consent_given" boolean DEFAULT false NOT NULL,
	"consent_note" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "script_beats" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"variant_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"position" integer NOT NULL,
	"kind" "beat_kind" NOT NULL,
	"spoken_text" text DEFAULT '' NOT NULL,
	"direction_note" text,
	"screen_text" text,
	"transition_in" text,
	"transition_out" text,
	"estimated_duration_sec" integer DEFAULT 0 NOT NULL,
	"duration_override_sec" integer,
	"framing" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"speaker_id" uuid,
	"answers_beat_id" uuid,
	"sources" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"imported_snapshot" jsonb,
	"locally_edited_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "script_journal" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"variant_id" uuid,
	"source" "script_journal_source" NOT NULL,
	"tool_name" text,
	"actor_user_id" text,
	"schema_version" text,
	"raw_payload" jsonb,
	"error_report" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"diff" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"applied" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"outcome" "script_journal_outcome" NOT NULL,
	"reverted_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "script_variants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"platform" "script_platform" NOT NULL,
	"target_duration_sec" integer,
	"aspect_ratio" text DEFAULT '16:9' NOT NULL,
	"position" integer NOT NULL,
	"derived_from_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "video_projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"subject" text,
	"status" "video_project_status" DEFAULT 'brouillon' NOT NULL,
	"article_id" uuid,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "video_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"brief_template" text NOT NULL,
	"words_per_minute" integer DEFAULT 155 NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"updated_by" text
);
--> statement-breakpoint
ALTER TABLE "beat_inserts" ADD CONSTRAINT "beat_inserts_beat_id_script_beats_id_fk" FOREIGN KEY ("beat_id") REFERENCES "public"."script_beats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "beat_takes" ADD CONSTRAINT "beat_takes_beat_id_script_beats_id_fk" FOREIGN KEY ("beat_id") REFERENCES "public"."script_beats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interview_speakers" ADD CONSTRAINT "interview_speakers_project_id_video_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."video_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "script_beats" ADD CONSTRAINT "script_beats_variant_id_script_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."script_variants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "script_beats" ADD CONSTRAINT "script_beats_speaker_id_interview_speakers_id_fk" FOREIGN KEY ("speaker_id") REFERENCES "public"."interview_speakers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "script_journal" ADD CONSTRAINT "script_journal_project_id_video_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."video_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "script_journal" ADD CONSTRAINT "script_journal_variant_id_script_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."script_variants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "script_journal" ADD CONSTRAINT "script_journal_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "script_variants" ADD CONSTRAINT "script_variants_project_id_video_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."video_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "video_projects" ADD CONSTRAINT "video_projects_article_id_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."articles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "video_projects" ADD CONSTRAINT "video_projects_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "video_settings" ADD CONSTRAINT "video_settings_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "beat_inserts_beat_idx" ON "beat_inserts" USING btree ("beat_id");--> statement-breakpoint
CREATE UNIQUE INDEX "beat_takes_beat_number_uq" ON "beat_takes" USING btree ("beat_id","number");--> statement-breakpoint
CREATE UNIQUE INDEX "script_beats_variant_external_uq" ON "script_beats" USING btree ("variant_id","external_id");--> statement-breakpoint
CREATE INDEX "script_beats_variant_position_idx" ON "script_beats" USING btree ("variant_id","position");--> statement-breakpoint
CREATE INDEX "script_journal_project_idx" ON "script_journal" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "script_variants_project_position_uq" ON "script_variants" USING btree ("project_id","position");--> statement-breakpoint
CREATE INDEX "script_variants_project_idx" ON "script_variants" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "video_projects_status_idx" ON "video_projects" USING btree ("status");--> statement-breakpoint
CREATE INDEX "video_projects_article_idx" ON "video_projects" USING btree ("article_id");
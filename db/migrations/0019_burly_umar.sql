CREATE TABLE "openrouter_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"label" text NOT NULL,
	"token_ciphertext" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"cooldown_until" timestamp,
	"last_status" text,
	"last_used_at" timestamp,
	"last_error" text,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pipeline_settings" ADD COLUMN "openrouter_min_content_chars" integer DEFAULT 400 NOT NULL;--> statement-breakpoint
ALTER TABLE "openrouter_tokens" ADD CONSTRAINT "openrouter_tokens_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "openrouter_tokens_active_order_idx" ON "openrouter_tokens" USING btree ("active","sort_order");
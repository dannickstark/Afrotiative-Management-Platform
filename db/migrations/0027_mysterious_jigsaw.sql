ALTER TABLE "api_tokens" ADD COLUMN "can_write" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "api_tokens" ADD COLUMN "can_read_articles" boolean DEFAULT true NOT NULL;
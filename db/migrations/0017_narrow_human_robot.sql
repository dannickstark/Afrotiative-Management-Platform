ALTER TABLE "social_channel_settings" ADD COLUMN "credentials" jsonb;--> statement-breakpoint
ALTER TABLE "social_channel_settings" ADD COLUMN "credentials_set_at" timestamp;
ALTER TABLE "api_keys" ADD COLUMN "resource_type" text;--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "resource_id" uuid;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "api_keys_resource_idx" ON "api_keys" USING btree ("resource_type","resource_id");
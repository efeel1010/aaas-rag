ALTER TABLE "api_usage" ADD COLUMN "workflow_id" uuid;--> statement-breakpoint
ALTER TABLE "api_usage" ADD COLUMN "request_content" text;--> statement-breakpoint
ALTER TABLE "api_usage" ADD COLUMN "response_content" text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "api_usage_agent_id_idx" ON "api_usage" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "api_usage_workflow_id_idx" ON "api_usage" USING btree ("workflow_id");
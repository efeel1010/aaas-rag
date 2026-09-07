CREATE TABLE IF NOT EXISTS "api_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"apikey_id" uuid NOT NULL,
	"route" text NOT NULL,
	"agent_id" uuid,
	"tokens" integer,
	"latency_ms" integer,
	"status" integer DEFAULT 200 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "quota" integer;--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "rpm" integer;--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "scope" jsonb;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "api_usage" ADD CONSTRAINT "api_usage_apikey_id_api_keys_id_fk" FOREIGN KEY ("apikey_id") REFERENCES "public"."api_keys"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "api_usage_apikey_id_idx" ON "api_usage" USING btree ("apikey_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "api_usage_apikey_created_idx" ON "api_usage" USING btree ("apikey_id","created_at");
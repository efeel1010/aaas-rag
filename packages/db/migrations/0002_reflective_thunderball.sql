ALTER TABLE "agent_datasets" ADD COLUMN "weight" integer DEFAULT 100 NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "system_prompt" text;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "model_id" uuid;--> statement-breakpoint
ALTER TABLE "intents" ADD COLUMN "strategy" text DEFAULT 'retrieval' NOT NULL;--> statement-breakpoint
ALTER TABLE "intents" ADD COLUMN "response_template" text;--> statement-breakpoint
ALTER TABLE "intents" ADD COLUMN "workflow_id" uuid;--> statement-breakpoint
ALTER TABLE "intents" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "session_id" text;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agents" ADD CONSTRAINT "agents_model_id_models_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."models"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "intents" ADD CONSTRAINT "intents_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "conversations_session_id_idx" ON "conversations" USING btree ("session_id");
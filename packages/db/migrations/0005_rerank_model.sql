ALTER TABLE "agents" ADD COLUMN "rerank_model_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agents" ADD CONSTRAINT "agents_rerank_model_id_models_id_fk" FOREIGN KEY ("rerank_model_id") REFERENCES "public"."models"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
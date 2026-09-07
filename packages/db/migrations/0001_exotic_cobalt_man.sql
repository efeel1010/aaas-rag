-- 前置：启用 pg_trgm 扩展，用于关键词/子串相似度检索（混合检索的关键词分支）。
CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
ALTER TABLE "datasets" ADD COLUMN "splitter" text DEFAULT 'recursive' NOT NULL;--> statement-breakpoint
ALTER TABLE "datasets" ADD COLUMN "chunk_size" integer DEFAULT 800 NOT NULL;--> statement-breakpoint
ALTER TABLE "datasets" ADD COLUMN "chunk_overlap" integer DEFAULT 200 NOT NULL;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "content" text;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "metadata" jsonb;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "tokens" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
-- 全文检索表达式索引（tsvector, simple 配置）与 3-gram 相似度索引。
-- 使用表达式/函数索引可避免 schema 中新增生成的 tsvector 列，避免与 pgvector 混排的维护成本。
CREATE INDEX IF NOT EXISTS "dataset_chunks_content_tsv_idx" ON "dataset_chunks" USING gin (to_tsvector('simple', "content"));--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dataset_chunks_content_trgm_idx" ON "dataset_chunks" USING gin ("content" gin_trgm_ops);
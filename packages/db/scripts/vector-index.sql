-- dataset_chunks 向量索引（HNSW，cosine 距离）。
-- 在运行迁移（db:migrate）且向量扩展就绪后执行。
--   psql "$DATABASE_URL" -f packages/db/scripts/vector-index.sql
CREATE INDEX IF NOT EXISTS dataset_chunks_embedding_hnsw_idx
  ON dataset_chunks USING hnsw (embedding vector_cosine_ops);
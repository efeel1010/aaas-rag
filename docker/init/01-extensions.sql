-- PostgreSQL 容器启动时自动执行。
-- 启用 pgvector 扩展（v1 之后默认仅对超级用户可见，这里是容器内 POSTGRES_USER）。
CREATE EXTENSION IF NOT EXISTS vector;

-- 可选：向量索引在迁移后由应用/脚本创建，见 packages/db/scripts/vector-index.sql
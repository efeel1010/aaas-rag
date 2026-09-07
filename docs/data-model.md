# 数据模型与迁移说明（M1）

数据定义位于 `packages/db/src/schema/`，迁移位于 `packages/db/migrations/`。

## 表清单

| 模块 | 表 | 说明 |
|------|----|------|
| 模型 | `providers` | 提供方（openai / azure / local…） |
| 模型 | `models` | llm / embedding / rerank 模型注册 |
| 知识库 | `datasets` | 数据集（含 `embedding_model_id`） |
| 知识库 | `documents` | 文档（解析/切分/索引状态机） |
| 知识库 | `dataset_chunks` | 切片，`embedding vector(1536)` |
| Agent | `agents` | Agent 定义 |
| Agent | `agent_datasets` | Agent 可检索知识库白名单 |
| 意图 | `intents` | 通用意图 |
| 意图 | `agent_intents` | 意图→知识库路由 |
| 工作流 | `workflows` | 工作流 DAG 头 |
| 工作流 | `workflow_nodes` / `workflow_edges` | 节点/边 |
| 密钥 | `api_keys` | console / workspace / app 级密钥 |
| 会话 | `conversations` / `messages` | 会话与消息 |

## 生成迁移

```bash
pnpm --filter @pulse/db generate
```

- 配置：`packages/db/drizzle.config.ts`
- 输出：`packages/db/migrations/`

> schema 文件之间的相对导入请使用**无扩展名**形式（如 `from './providers'`），这是 drizzle-kit 可正确解析的惯例。

## 应用迁移

```bash
pnpm --filter @pulse/db migrate
```

首个迁移文件顶部含 `CREATE EXTENSION IF NOT EXISTS vector;` 兜底，正常情况下 `docker/init/01-extensions.sql` 已在容器初始化时创建该扩展。

## pgvector

- `vector(1536)` 列定义于 `dataset_chunks`。
- 维度模型：默认 `DEFAULT_EMBEDDING_DIMENSIONS = 1536`。
- **HNSW 向量索引需手工创建**：

```sql
CREATE INDEX IF NOT EXISTS dataset_chunks_embedding_hnsw_idx
  ON dataset_chunks USING hnsw (embedding vector_cosine_ops);
```

脚本：`packages/db/scripts/vector-index.sql`。
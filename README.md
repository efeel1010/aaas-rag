# Pulse-Rag

简化版 Dify 平台（对外提供 RAG 服务的 API 应用），分为多阶段交付。本仓库为 **M1 骨架**。

## 技术栈

- 包管理：pnpm workspace monorepo
- 语言：TypeScript（strict）
- 后端：Hono 4 + @hono/node-server
- 数据访问：Drizzle ORM（pg-core）+ PostgreSQL 18 + pgvector
- 缓存/队列：Redis（M1 阶段作为基础设施预留）
- 共享契约：packages/contracts（Zod）
- 前端：React 19 + Vite + Tailwind CSS v4（M1 阶段为最小占位）

## 目录结构

```
├── apps/
│   ├── api/                  # Hono API 网关（统一响应/异常/中间件/路由挂载）
│   └── web/                  # React 占位页（调用健康检查验证前后端连通）
├── packages/
│   ├── contracts/            # 前后端共享 Zod schema 与 API 响应契约
│   └── db/                   # Drizzle schema（全量表 + pgvector）+ client + 迁移
├── docker/
│   └── init/                 # PostgreSQL 容器初始化 SQL（启用 vector 扩展）
├── docker-compose.yml        # PostgreSQL(带 pgvector) + Redis
└── .env.example              # 环境变量样例
```

## 快速开始

### 前置要求

- Node.js >= 22
- pnpm >= 9
- Docker（PostgreSQL/pgvector、Redis）

### 1. 安装依赖

```bash
pnpm install
```

### 2. 启动基础设施

```bash
docker compose up -d
# 可选：等待 postgres 健康检查通过后执行数据库迁移
pnpm db:migrate
```

`docker compose up` 会自动执行 `docker/init/01-extensions.sql` 创建 pgvector 扩展；`pnpm db:migrate` 会应用 `packages/db/migrations` 下的全部迁移。

> 可选：创建向量检索所需的 HNSW 索引（当前 schema 仅保列，索引为手工 SQL）：
>
> ```bash
> psql "$DATABASE_URL" -f packages/db/scripts/vector-index.sql
> ```

### 3. 环境变量

```bash
cp .env.example .env   # 缺省值即可直接本地运行
```

关键变量：`DATABASE_URL`、`REDIS_URL`、`API_PORT`（默认 3001）、`WEB_PORT`（默认 3002）。

### 4. 启动开发

```bash
pnpm dev
```

- API：http://localhost:3001 （健康检查 `GET /api/v1/health`）
- Web：http://localhost:3002 （Vite dev server，已将 `/api` 代理到 3001）

## 常用 Scripts（根目录）

| 命令 | 说明 |
|------|------|
| `pnpm dev` | 并行启动 api + web 的 watch 开发模式 |
| `pnpm build` | 全仓构建（类型检查 + api tsup 打包 + web vite 构建） |
| `pnpm typecheck` | 全仓 TypeScript 类型检查 |
| `pnpm lint` / `pnpm format` | ESLint / Prettier |
| `pnpm db:generate` | 根据 schema 生成新的 Drizzle 迁移 |
| `pnpm db:migrate` | 应用迁移 |
| `pnpm db:push` | push schema 直接同步数据库（仅开发） |
| `pnpm db:studio` | Drizzle Studio GUI |

## API 网关约定

统一响应信封：

```jsonc
// 成功
{ "success": true, "data": { /* payload */ } }
// 失败
{ "success": false, "error": { "code": "NOT_FOUND", "message": "接口不存在", "details": {} } }
```

已就绪：

- `GET /api/v1/health` —— 存活探针
- 路由挂载结构：`/api/v1/datasets`、`/api/v1/agents`、`/api/v1/workflows`、`/api/v1/chat`（M1 为占位，返回 `NOT_IMPLEMENTED`）

全局中间件顺序：RequestID → 安全头 → CORS → 鉴权占位 → 访问日志 → 路由 → 异常处理。

## 数据库 Schema（M1 共 15 张表）

- `providers` / `models` —— 模型提供方与模型注册（llm / embedding / rerank）
- `datasets` / `documents` / `dataset_chunks` —— RAG 知识库（`dataset_chunks.embedding` 为 `vector(1536)`）
- `agents` / `agent_datasets` —— Agent 与其可检索知识库的白名单
- `intents` / `agent_intents` —— 意图识别与「意图→知识库」路由
- `workflows` / `workflow_nodes` / `workflow_edges` —— 工作流 DAG
- `api_keys` —— 控制台 / 工作区 / 应用级密钥
- `conversations` / `messages` —— 会话与消息

详见 [docs/data-model.md](docs/data-model.md) 与 `packages/db/migrations/`。

## 后续阶段需要注意的地基设定

1. **pgvector 维度固定**：`dataset_chunks.embedding` 的维度在建列时即固定为 1536。更换 embedding 模型（维度不同）需重建向量列与索引，M1 特此预留 `datasets.embedding_model_id`，后续「按数据集选择 embedding 模型」需规划迁移策略。
2. **鉴权尚未真正校验**：`middleware/auth.ts` 仅注入 `AuthContext` 占位；后续需将 `api_keys` 与鉴权、路由级 `authz` 打通。
3. **密钥安全**：`providers.credentials` 与 `api_keys.key` 目前明文落库；后续需引入字段级加密 / 哈希。
4. **统一响应只会影响 JSON 接口**：启用 SSE 上下文（`/api/v1/chat/chat-messages`）后，错误信封与流式输出需单独约定。
5. **环境：前端 CORS** 默认仅放行 `http://localhost:3002`，生产部署请显式配置 `CORS_ORIGIN`。
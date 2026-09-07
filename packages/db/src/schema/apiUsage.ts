/**
 * api_usage —— 对外 API 用量采样（M7 开放 API 网关）。
 *
 * 每次对外调用（携带 API Key 鉴权的端点）落一条采样记录，
 * 用于：配额统计、用量聚合查询（按日 / 按 endpoint）、审计回溯。
 * 采样为近似低精度（毫秒级延迟 / token 总量），允许部分字段缺失
 * （如流式端点无法在请求内拿到最终 token 数时 tokens 可为 null）。
 */
import { index, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { apiKeys } from './apiKeys';

export const apiUsage = pgTable(
  'api_usage',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    apikeyId: uuid('apikey_id')
      .notNull()
      .references(() => apiKeys.id, { onDelete: 'cascade' }),
    /** 命中路由（相对 /api/v1 的 path，如 /agents/:id/chat） */
    route: text('route').notNull(),
    /** 若本次调用关联 Agent（agent 编排）记 agentId，否则为 null */
    agentId: uuid('agent_id'),
    /** 若本次调用关联工作流（workflow 运行）记 workflowId，否则为 null */
    workflowId: uuid('workflow_id'),
    /** 调用请求内容（问答中的「问」/ 工作流 inputs），缺失为 null */
    requestContent: text('request_content'),
    /** 调用响应内容（问答中的「答」/ 工作流 outputs），流式可为 null */
    responseContent: text('response_content'),
    /** 累计 token 用量（prompt+completion），缺失时为 null */
    tokens: integer('tokens'),
    /** 调用耗时（ms） */
    latencyMs: integer('latency_ms'),
    /** 本次调用 HTTP 状态码（2xx/4xx/5xx） */
    status: integer('status').notNull().default(200),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('api_usage_apikey_id_idx').on(table.apikeyId),
    index('api_usage_apikey_created_idx').on(table.apikeyId, table.createdAt),
    index('api_usage_agent_id_idx').on(table.agentId),
    index('api_usage_workflow_id_idx').on(table.workflowId),
  ],
);
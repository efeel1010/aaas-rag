/**
 * agents / agent_datasets —— Agent 及其关联知识库（RAG 检索源的白名单）。
 */
import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { datasets } from './datasets';
import { models } from './providers';

export const agents = pgTable('agents', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  description: text('description'),
  /** chat | workflow | advanced，M1 暂以 chat 为主 */
  type: text('type').notNull().default('chat'),
  /** 系统提示词（Agent 编排时拼入首条 system 消息） */
  systemPrompt: text('system_prompt'),
  /** 绑定的对话模型（须为 llm 类型、active 状态；意图识别与最终生成共用） */
  modelId: uuid('model_id').references(() => models.id, { onDelete: 'set null' }),
  /** 可选绑定的重排模型（须为 rerank 类型、active 状态；绑定后检索启用 rerank 重排） */
  rerankModelId: uuid('rerank_model_id').references(() => models.id, { onDelete: 'set null' }),
  /** 模型编排 / prompt / 记忆等配置 */
  config: jsonb('config').$type<Record<string, unknown>>(),
  /** 启用的工具清单（对 ToolRegistry 注册的工具名；绑定即切换 ReAct 工具循环编排） */
  tools: text('tools').array().notNull().default([]),
  status: text('status').notNull().default('active'),
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** agent <-> dataset 多对多关联（决定该 Agent 可检索哪些知识库） */
export const agentDatasets = pgTable(
  'agent_datasets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    datasetId: uuid('dataset_id')
      .notNull()
      .references(() => datasets.id, { onDelete: 'cascade' }),
    /** 知识库关联权重（用于多库检索时的相对重要度排序，1-1000） */
    weight: integer('weight').notNull().default(100),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('agent_datasets_agent_id_idx').on(table.agentId),
    index('agent_datasets_dataset_id_idx').on(table.datasetId),
    index('agent_datasets_agent_dataset_uq').on(table.agentId, table.datasetId),
  ],
);
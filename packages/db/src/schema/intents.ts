/**
 * intents / agent_intents —— 意图识别与 Agent-意图-知识库 的路由关系。
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
import { agents } from './agents';
import { datasets } from './datasets';
import { workflows } from './workflows';

/** 通用意图定义（可被多个 Agent 复用） */
export const intents = pgTable('intents', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  description: text('description'),
  /** 示例问法，用于意图命中 */
  examples: jsonb('examples').$type<string[]>().notNull().default([]),
  /**
   * 命中该意图后的响应策略：
   *  - retrieval：按绑定的知识库子集检索后交给 LLM 生成（默认）
   *  - direct    ：直接返回 responseTemplate 话术，不调用 LLM
   *  - workflow  ：触发关联 workflow（工作流引擎未就绪时回退 LLM + 话术）
   *  - fallback  ：作为未命中任何意图时的兜底意图
   */
  strategy: text('strategy').notNull().default('retrieval'),
  /** direct 策略下直接返回的话术；retrieval/workflow 策略下作为生成时的意图上下文 */
  responseTemplate: text('response_template'),
  /** workflow 策略关联的工作流 */
  workflowId: uuid('workflow_id').references(() => workflows.id, {
    onDelete: 'set null',
  }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * agent_intents —— Agent 下的意图，关联到为其服务的知识库。
 * 例如：意图 A 关联 dataset X，则命中意图 A 时检索 dataset X。
 */
export const agentIntents = pgTable(
  'agent_intents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    intentId: uuid('intent_id')
      .notNull()
      .references(() => intents.id, { onDelete: 'cascade' }),
    /** 命中该意图时检索的知识库 */
    datasetId: uuid('dataset_id').references(() => datasets.id, {
      onDelete: 'set null',
    }),
    priority: integer('priority').notNull().default(0),
    settings: jsonb('settings').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('agent_intents_agent_id_idx').on(table.agentId),
    index('agent_intents_intent_id_idx').on(table.intentId),
    index('agent_intents_agent_intent_uq').on(table.agentId, table.intentId),
  ],
);
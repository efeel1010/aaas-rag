/**
 * providers / models —— LLM、Embedding、Rerank 等模型提供方及其模型注册。
 */
import {
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

export const providers = pgTable('providers', {
  id: uuid('id').primaryKey().defaultRandom(),
  /** 提供方类型，如 openai / azure_openai / local 等 */
  type: text('type').notNull(),
  name: text('name').notNull(),
  description: text('description'),
  /** 非敏感的配置项 */
  config: jsonb('config').$type<Record<string, unknown>>(),
  /** 敏感凭据，后续阶段落地加密方案（如 KMS / 字段级加密） */
  credentials: jsonb('credentials').$type<Record<string, unknown>>(),
  status: text('status').notNull().default('active'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const models = pgTable('models', {
  id: uuid('id').primaryKey().defaultRandom(),
  providerId: uuid('provider_id')
    .notNull()
    .references(() => providers.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  /** llm | embedding | rerank */
  modelType: text('model_type').notNull(),
  config: jsonb('config').$type<Record<string, unknown>>(),
  status: text('status').notNull().default('active'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** 模型类型枚举常量（与 Dify 对齐） */
export const ModelType = {
  LLM: 'llm',
  EMBEDDING: 'embedding',
  RERANK: 'rerank',
} as const;
/**
 * conversations / messages —— 会话与消息。
 */
import { index, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { agents } from './agents';

export const conversations = pgTable(
  'conversations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    /** 客户端会话标识：同一 sessionId + agentId 复用同一会话（会话记忆维度） */
    sessionId: text('session_id'),
    /** console | api | share */
    fromSource: text('from_source').notNull().default('console'),
    fromEndUserId: text('from_end_user_id'),
    name: text('name'),
    status: text('status').notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('conversations_agent_id_idx').on(table.agentId),
    index('conversations_session_id_idx').on(table.sessionId),
    index('conversations_end_user_idx').on(table.fromEndUserId),
  ],
);

export const messages = pgTable(
  'messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    agentId: uuid('agent_id').references(() => agents.id, { onDelete: 'set null' }),
    /** user | assistant | system | tool */
    role: text('role').notNull(),
    query: text('query'),
    answer: text('answer'),
    messageText: text('message_text'),
    status: text('status').notNull().default('complete'),
    /** token 用量 { prompt, completion, total } */
    usage: jsonb('usage').$type<Record<string, unknown>>(),
    tokenCount: integer('token_count').notNull().default(0),
    latencyMs: integer('latency_ms'),
    /** 用户标注：like | dislike | null（回答质量评估，驱动 RAG 优化） */
    feedback: text('feedback'),
    /** 标注备注（可选） */
    feedbackComment: text('feedback_comment'),
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('messages_conversation_id_idx').on(table.conversationId),
    index('messages_agent_id_idx').on(table.agentId),
  ],
);
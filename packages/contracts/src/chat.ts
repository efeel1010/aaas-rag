/**
 * M4 Agent 会话编排契约 —— /agents/:id/chat 与 /api/v1/chat(agentId) 的请求/响应/流式事件。
 *
 * SSE 事件序列（与 M2 同构，额外带 meta 前置事件）：
 *   event: meta  → { conversationId, sessionId, agentId, intent, retrievedDatasets }
 *   event: delta → 增量文本
 *   event: usage → token 用量
 *   event: done  → { messageId?, createdAt }
 *   event: error → { code, message }
 */
import { z } from 'zod';
import { retrievalHitViewSchema } from './datasets.js';

/** Agent 聊天请求（单轮）：query 为当前用户输入，历史由服务端按 sessionId 回溯 */
export const agentChatRequestSchema = z.object({
  /** 客户端会话标识：缺省时服务端生成并随结果返回 */
  sessionId: z.string().trim().min(1).max(256).optional(),
  query: z.string().trim().min(1).max(4096),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().positive().optional(),
  /** 检索召回 topK（默认 6） */
  topK: z.number().int().min(1).max(20).optional(),
  /** true 时走 SSE 流式，false 返回一次性 JSON */
  stream: z.boolean().default(false),
});
export type AgentChatRequest = z.infer<typeof agentChatRequestSchema>;

/** 命中的意图信息（未命中/无意图时为 null） */
export const agentIntentHitSchema = z.object({
  intentId: z.string().uuid().nullable(),
  name: z.string().nullable(),
  strategy: z.string().nullable(),
});
export type AgentIntentHit = z.infer<typeof agentIntentHitSchema>;

/**
 * 一次工具调用记录（ReAct 工具循环产物）。
 * - name/args：LLM 决策选用的工具名与参数；
 * - status/latencyMs：执行结果状态与耗时（用于透出与观测）；
 *   tool_call SSE 事件与 AgentChatResult.toolCalls 均使用本结构。
 */
export const agentToolCallSchema = z.object({
  name: z.string(),
  args: z.record(z.string(), z.unknown()),
  status: z.enum(['success', 'error', 'skipped']),
  latencyMs: z.number().int().nonnegative(),
});
export type AgentToolCall = z.infer<typeof agentToolCallSchema>;

/** 一次性 JSON 结果（非流式） */
export const agentChatResultSchema = z.object({
  conversationId: z.string().uuid(),
  sessionId: z.string(),
  agentId: z.string().uuid(),
  intent: agentIntentHitSchema.nullable(),
  /** 实际参与检索的知识库 id（未检索为空数组） */
  retrievedDatasets: z.array(z.string().uuid()),
  /** 回答引用的知识库命中切片（引用溯源），未检索/无命中为空数组 */
  citations: z.array(retrievalHitViewSchema).optional(),
  content: z.string(),
  model: z.string().optional(),
  /** ReAct 工具循环中的工具调用记录（未绑定工具/未调用工具时缺省或为空数组） */
  toolCalls: z.array(agentToolCallSchema).optional(),
  usage: z
    .object({
      inputTokens: z.number().int().nonnegative(),
      outputTokens: z.number().int().nonnegative(),
    })
    .optional(),
  createdAt: z.string(),
});
export type AgentChatResult = z.infer<typeof agentChatResultSchema>;

/** 会话消息记忆（落库回读形态，供前端展示/调试） */
export const conversationMessageSchema = z.object({
  id: z.string().uuid(),
  conversationId: z.string().uuid(),
  role: z.enum(['user', 'assistant', 'system', 'tool']),
  content: z.string(),
  status: z.string(),
  usage: z.record(z.string(), z.unknown()).nullable(),
  tokenCount: z.number().int().nonnegative(),
  /** 用户标注：like | dislike | null */
  feedback: z.enum(['like', 'dislike']).nullable().optional(),
  feedbackComment: z.string().nullable().optional(),
  error: z.string().nullable(),
  createdAt: z.string(),
});
export type ConversationMessage = z.infer<typeof conversationMessageSchema>;

/** 消息标注输入：like / dislike（重复提交可切换或取消：传 null 清除） */
export const messageFeedbackInputSchema = z.object({
  feedback: z.enum(['like', 'dislike']).nullable(),
  comment: z.string().max(512).optional(),
});
export type MessageFeedbackInput = z.infer<typeof messageFeedbackInputSchema>;

/** 会话列表项（历史会话回读） */
export const conversationListItemSchema = z.object({
  id: z.string().uuid(),
  sessionId: z.string().nullable(),
  name: z.string().nullable(),
  messageCount: z.number().int().nonnegative(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ConversationListItem = z.infer<typeof conversationListItemSchema>;

/** Agent 流式事件（meta/delta/usage/done/error） */
export const agentStreamEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('meta'),
    conversationId: z.string().uuid(),
    sessionId: z.string(),
    agentId: z.string().uuid(),
    intent: agentIntentHitSchema.nullable(),
    retrievedDatasets: z.array(z.string().uuid()),
  }),
  z.object({ type: z.literal('delta'), content: z.string() }),
  z.object({
    type: z.literal('citations'),
    citations: z.array(retrievalHitViewSchema),
  }),
  z.object({
    type: z.literal('tool_call'),
    name: z.string(),
    args: z.record(z.string(), z.unknown()),
    status: z.enum(['success', 'error', 'skipped']),
    latencyMs: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal('usage'),
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    model: z.string().optional(),
  }),
  z.object({
    type: z.literal('done'),
    messageId: z.string().uuid().optional(),
    createdAt: z.string().optional(),
  }),
  z.object({ type: z.literal('error'), code: z.string(), message: z.string() }),
]);
export type AgentStreamEvent = z.infer<typeof agentStreamEventSchema>;

/** SSE 传输层事件类型名（agent 版） */
export const agentSseEventTypeSchema = z.enum([
  'meta',
  'citations',
  'delta',
  'tool_call',
  'usage',
  'done',
  'error',
]);

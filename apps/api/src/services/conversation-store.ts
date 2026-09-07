/**
 * 会话记忆存储 —— conversations / messages 落库（M4 Agent 编排的记忆维度）。
 *
 * 约定：
 *  - 同一 agentId + sessionId 唯一对应一个会话（sessionId 缺省时服务端生成）；
 *  - 每轮 Agent 对话落两条消息：user（query）+ assistant（answer，含 token/latency）；
 *  - loadHistory 按 createdAt 升序返回最近 N 条（用于拼装上下文）。
 */
import { and, asc, count, desc, eq } from 'drizzle-orm';
import { conversations, messages } from '@pulse/db';
import type { ConversationListItem, ConversationMessage } from '@pulse/contracts';
import { getDb } from '../lib/db.js';
import { NotFoundError } from '../lib/errors.js';

type ConversationRow = typeof conversations.$inferSelect;

function toMessageView(row: typeof messages.$inferSelect): ConversationMessage {
  return {
    id: row.id,
    conversationId: row.conversationId,
    role: row.role as ConversationMessage['role'],
    content: row.messageText ?? row.answer ?? row.query ?? '',
    status: row.status,
    usage: row.usage,
    tokenCount: row.tokenCount,
    feedback: (row.feedback as ConversationMessage['feedback']) ?? null,
    feedbackComment: row.feedbackComment ?? null,
    error: row.error,
    createdAt: row.createdAt.toISOString(),
  };
}

export const conversationStore = {
  /**
   * 获取或创建会话。sessionId 缺省时生成一个（返回给调用方），
   * 以保证「同一 sessionId 复用会话」的多轮记忆语义。
   */
  async getOrCreate(agentId: string, sessionId?: string): Promise<{ conversationId: string; sessionId: string }> {
    const sid = sessionId?.trim() || crypto.randomUUID();
    if (sessionId?.trim()) {
      const rows = await getDb()
        .select()
        .from(conversations)
        .where(and(eq(conversations.agentId, agentId), eq(conversations.sessionId, sid)))
        .limit(1);
      const existing = rows[0];
      if (existing) {
        return { conversationId: existing.id, sessionId: existing.sessionId ?? sid };
      }
    }
    const inserted = await getDb()
      .insert(conversations)
      .values({ agentId, sessionId: sid, fromSource: 'api', name: null })
      .returning();
    const row = inserted[0];
    if (!row) throw new Error('创建会话失败');
    return { conversationId: row.id, sessionId: sid };
  },

  /** 会话是否存在（供校验） */
  async findConversation(id: string): Promise<ConversationRow> {
    const rows = await getDb().select().from(conversations).where(eq(conversations.id, id)).limit(1);
    const row = rows[0];
    if (!row) throw new NotFoundError('会话', id);
    return row;
  },

  /** 消息是否存在（供校验 / 标注归属） */
  async findMessage(id: string): Promise<typeof messages.$inferSelect> {
    const rows = await getDb().select().from(messages).where(eq(messages.id, id)).limit(1);
    const row = rows[0];
    if (!row) throw new NotFoundError('消息', id);
    return row;
  },

  /** 按会话读取最近 N 条消息（升序，用于历史上下文） */
  async loadHistory(conversationId: string, limit = 10): Promise<ConversationMessage[]> {
    const recent = await getDb()
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conversationId))
      .orderBy(desc(messages.createdAt))
      .limit(limit);
    return recent.reverse().map(toMessageView);
  },

  /** 会话消息列表（展示用，升序） */
  async listMessages(conversationId: string): Promise<ConversationMessage[]> {
    const rows = await getDb()
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conversationId))
      .orderBy(asc(messages.createdAt));
    return rows.map(toMessageView);
  },

  /** 写入一条消息 */
  async saveMessage(
    input: {
      conversationId: string;
      agentId: string;
      role: 'user' | 'assistant';
      content: string;
      tokenCount?: number;
      usage?: Record<string, unknown> | null;
      latencyMs?: number;
      error?: string | null;
    },
  ): Promise<ConversationMessage> {
    const inserted = await getDb()
      .insert(messages)
      .values({
        conversationId: input.conversationId,
        agentId: input.agentId,
        role: input.role,
        // user 消息存 query，assistant 消息存 answer；messageText 统一存正文
        query: input.role === 'user' ? input.content : undefined,
        answer: input.role === 'assistant' ? input.content : undefined,
        messageText: input.content,
        status: input.error ? 'failed' : 'complete',
        tokenCount: input.tokenCount ?? 0,
        usage: input.usage ?? null,
        latencyMs: input.latencyMs,
        error: input.error ?? null,
      })
      .returning();
    const row = inserted[0];
    if (!row) throw new Error('保存消息失败');
    return toMessageView(row);
  },

  /** 会话列表（管理用，含消息数） */
  async listByAgent(agentId: string): Promise<ConversationListItem[]> {
    const rows = await getDb()
      .select({
        id: conversations.id,
        sessionId: conversations.sessionId,
        name: conversations.name,
        messageCount: count(messages.id),
        createdAt: conversations.createdAt,
        updatedAt: conversations.updatedAt,
      })
      .from(conversations)
      .leftJoin(messages, eq(messages.conversationId, conversations.id))
      .where(eq(conversations.agentId, agentId))
      .groupBy(conversations.id)
      .orderBy(desc(conversations.updatedAt))
      .limit(100);
    return rows.map((r) => ({
      id: r.id,
      sessionId: r.sessionId,
      name: r.name,
      messageCount: Number(r.messageCount),
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    }));
  },

  /** 更新消息标注（like/dislike/null） */
  async updateFeedback(
    messageId: string,
    input: { feedback: 'like' | 'dislike' | null; comment?: string },
  ): Promise<ConversationMessage> {
    const updated = await getDb()
      .update(messages)
      .set({
        feedback: input.feedback,
        ...(input.comment !== undefined ? { feedbackComment: input.comment } : {}),
      })
      .where(eq(messages.id, messageId))
      .returning();
    const row = updated[0];
    if (!row) throw new NotFoundError('消息', messageId);
    return toMessageView(row);
  },
};

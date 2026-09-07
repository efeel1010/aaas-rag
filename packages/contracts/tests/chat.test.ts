/**
 * @pulse/contracts M4 会话编排契约单测 —— agent chat 请求/结果/流式事件 + chat 双通道互斥。
 */
import { describe, expect, it } from 'vitest';
import {
  agentChatRequestSchema,
  agentChatResultSchema,
  agentSseEventTypeSchema,
  agentStreamEventSchema,
  agentToolCallSchema,
  conversationMessageSchema,
} from '../src/chat.js';
import { chatRequestSchema } from '../src/models.js';

const UUID = '00000000-0000-0000-0000-000000000000';

describe('agentChatRequestSchema', () => {
  it('合法请求通过，stream 缺省 false', () => {
    const req = agentChatRequestSchema.parse({ query: '你好' });
    expect(req.stream).toBe(false);
    expect(req.sessionId).toBeUndefined();
  });

  it('query 非空且 topK 有界', () => {
    expect(() => agentChatRequestSchema.parse({ query: '   ' })).toThrow();
    expect(() => agentChatRequestSchema.parse({ query: '' })).toThrow();
    expect(() => agentChatRequestSchema.parse({ query: 'x', topK: 0 })).toThrow();
    expect(() => agentChatRequestSchema.parse({ query: 'x', topK: 21 })).toThrow();
    expect(agentChatRequestSchema.parse({ query: 'x', topK: 6 }).topK).toBe(6);
  });
});

describe('agentChatResultSchema', () => {
  it('接受完整结果（命中意图 + 检索范围）', () => {
    const result = agentChatResultSchema.parse({
      conversationId: UUID,
      sessionId: 's-1',
      agentId: UUID,
      intent: { intentId: UUID, name: '退货', strategy: 'retrieval' },
      retrievedDatasets: [UUID],
      content: '好的',
      model: 'mock-model',
      usage: { inputTokens: 10, outputTokens: 2 },
      createdAt: new Date().toISOString(),
    });
    expect(result.intent?.name).toBe('退货');
  });

  it('未命中意图时 intent 为 null，检索范围可为空数组', () => {
    const result = agentChatResultSchema.parse({
      conversationId: UUID,
      sessionId: 's-2',
      agentId: UUID,
      intent: null,
      retrievedDatasets: [],
      content: '好的',
      createdAt: new Date().toISOString(),
    });
    expect(result.intent).toBeNull();
  });

  it('接受工具调用记录（toolCalls：M-A ReAct 循环透出）', () => {
    const result = agentChatResultSchema.parse({
      conversationId: UUID,
      sessionId: 's-3',
      agentId: UUID,
      intent: null,
      retrievedDatasets: [],
      content: '根据本地知识库：支持7天无理由退货',
      model: 'mock-model',
      toolCalls: [
        {
          name: 'local_retrieval',
          args: { query: '退货政策', topK: 3 },
          status: 'success',
          latencyMs: 12,
        },
      ],
      usage: { inputTokens: 30, outputTokens: 8 },
      createdAt: new Date().toISOString(),
    });
    expect(result.toolCalls?.[0]).toMatchObject({
      name: 'local_retrieval',
      status: 'success',
      latencyMs: 12,
    });
  });

  it('toolCalls 缺省时结果仍合法（向后兼容）', () => {
    const result = agentChatResultSchema.parse({
      conversationId: UUID,
      sessionId: 's-4',
      agentId: UUID,
      intent: null,
      retrievedDatasets: [],
      content: '好的',
      createdAt: new Date().toISOString(),
    });
    expect(result.toolCalls).toBeUndefined();
  });

  it('agentToolCallSchema 校验 status 枚举与 latencyMs 非负', () => {
    expect(agentToolCallSchema.parse({ name: 'http_request', args: {}, status: 'error', latencyMs: 5 }).status).toBe('error');
    expect(agentToolCallSchema.parse({ name: 't', args: {}, status: 'skipped', latencyMs: 0 }).status).toBe('skipped');
    expect(() => agentToolCallSchema.parse({ name: 't', args: {}, status: 'pending', latencyMs: 0 })).toThrow();
    expect(() => agentToolCallSchema.parse({ name: 't', args: {}, status: 'success', latencyMs: -1 })).toThrow();
  });
});

describe('agentStreamEventSchema', () => {
  it('判别联合：meta/delta/tool_call/usage/done/error', () => {
    expect(
      agentStreamEventSchema.parse({
        type: 'meta',
        conversationId: UUID,
        sessionId: 's',
        agentId: UUID,
        intent: null,
        retrievedDatasets: [],
      }).type,
    ).toBe('meta');
    expect(agentStreamEventSchema.parse({ type: 'delta', content: 'hi' }).type).toBe('delta');
    expect(
      agentStreamEventSchema.parse({
        type: 'tool_call',
        name: 'local_retrieval',
        args: { query: 'x' },
        status: 'success',
        latencyMs: 3,
      }).type,
    ).toBe('tool_call');
    expect(
      agentStreamEventSchema.parse({ type: 'usage', inputTokens: 1, outputTokens: 2 }).type,
    ).toBe('usage');
    expect(agentStreamEventSchema.parse({ type: 'done' }).type).toBe('done');
    expect(
      agentStreamEventSchema.parse({ type: 'error', code: 'X', message: 'm' }).type,
    ).toBe('error');
    expect(() => agentStreamEventSchema.parse({ type: 'unknown', content: 'x' })).toThrow();
    expect(() => agentStreamEventSchema.parse({ type: 'tool_call', name: 'x' })).toThrow();
    expect(() => agentStreamEventSchema.parse({ type: 'meta', agentId: UUID })).toThrow();
  });

  it('agentSseEventTypeSchema 包含 tool_call 事件类型', () => {
    expect(agentSseEventTypeSchema.options).toContain('tool_call');
    expect(agentSseEventTypeSchema.parse('tool_call')).toBe('tool_call');
    expect(() => agentSseEventTypeSchema.parse('foo')).toThrow();
  });
});

describe('conversationMessageSchema', () => {
  it('校验会话消息回读形态', () => {
    const msg = conversationMessageSchema.parse({
      id: UUID,
      conversationId: UUID,
      role: 'assistant',
      content: '答复',
      status: 'complete',
      usage: { inputTokens: 1, outputTokens: 2 },
      tokenCount: 2,
      error: null,
      createdAt: new Date().toISOString(),
    });
    expect(msg.role).toBe('assistant');
    expect(() => conversationMessageSchema.parse({ ...msg, role: 'admin' })).toThrow();
  });
});

describe('chatRequestSchema 双通道互斥（M2 直连 / M4 Agent）', () => {
  const msg = { role: 'user' as const, content: 'hi' };

  it('M2 直连：modelId + messages 合法（既有契约保持）', () => {
    const req = chatRequestSchema.parse({ modelId: UUID, messages: [msg] });
    expect(req.stream).toBe(false);
    expect(req.agentId).toBeUndefined();
  });

  it('M4 Agent：agentId + messages 合法', () => {
    const req = chatRequestSchema.parse({ agentId: UUID, messages: [msg], sessionId: 's' });
    expect(req.agentId).toBe(UUID);
    expect(req.sessionId).toBe('s');
  });

  it('modelId 与 agentId 同时提供 / 均缺失 → 拒绝', () => {
    expect(() => chatRequestSchema.parse({ modelId: UUID, agentId: UUID, messages: [msg] })).toThrow();
    expect(() => chatRequestSchema.parse({ messages: [msg] })).toThrow();
  });

  it('messages 空数组仍被拒绝；temperature 越界拒绝', () => {
    expect(() => chatRequestSchema.parse({ modelId: UUID, messages: [] })).toThrow();
    expect(() =>
      chatRequestSchema.parse({ modelId: UUID, messages: [msg], temperature: 3 }),
    ).toThrow();
  });
});

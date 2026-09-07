import { Hono } from 'hono';
import { z } from 'zod';
import {
  agentChatRequestSchema,
  agentChatResultSchema,
  agentViewSchema,
  apiCallLogListSchema,
  conversationListItemSchema,
  conversationMessageSchema,
  createAgentInputSchema,
  createShareLinkInputSchema,
  messageFeedbackInputSchema,
  resourceApiAccessSchema,
  shareLinkViewSchema,
  updateAgentInputSchema,
  type AgentStreamEvent,
} from '@pulse/contracts';
import { ok } from '../../lib/http.js';
import { parse } from '../../lib/parse.js';
import { agentStore } from '../../services/agent-store.js';
import { apiKeyStore } from '../../services/api-key-store.js';
import { conversationStore } from '../../services/conversation-store.js';
import { shareLinkStore } from '../../services/share-link-store.js';
import { createAgentRuntime, type TurnInput } from '../../services/agent-runtime.js';
import { AppError, ValidationError } from '../../lib/errors.js';
import { reportUsage, requireExternalApi } from '../../middleware/api-gateway.js';
import type { AppEnv } from '../../types.js';

const uuidSchema = z.string().uuid();

const agentIdParam = (c: { req: { param(key: string): string } }): string =>
  parse(uuidSchema, c.req.param('agentId'));

/** 分页查询参数解析（page / perPage） */
function pageOptions(c: { req: { query(key: string): string | undefined } }): {
  page: number;
  perPage: number;
} {
  const rawPage = c.req.query('page');
  const rawPerPage = c.req.query('perPage');
  const page = rawPage === undefined ? 1 : Number(rawPage);
  const perPage = rawPerPage === undefined ? 20 : Number(rawPerPage);
  if (!Number.isInteger(page) || page < 1) {
    throw new ValidationError([{ path: ['page'], message: 'page 须为正整数' }]);
  }
  if (!Number.isInteger(perPage) || perPage < 1 || perPage > 200) {
    throw new ValidationError([{ path: ['perPage'], message: 'perPage 须为正整数且 ≤200' }]);
  }
  return { page, perPage };
}

/** 统一组装资源级 API 访问响应（resourceApiAccessSchema 形态） */
function toAccess(
  resourceId: string,
  r: { key?: string | null; prefix?: string | null; createdAt?: Date } | null,
) {
  return resourceApiAccessSchema.parse({
    resourceType: 'agent',
    resourceId,
    enabled: r !== null,
    prefix: r?.prefix ?? null,
    key: r?.key ?? null,
    createdAt: r?.createdAt ? r.createdAt.toISOString() : null,
  });
}

const runtime = createAgentRuntime();

/** Agent 流式事件 SSE 编码（meta/delta/usage/done/error，同 M2 的 sseEncode 风格） */
function encodeAgentSse(event: AgentStreamEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

/**
 * 把 Agent 单轮编排转换为 SSE ReadableStream。
 * 错误双通道：流前（agent 不存在/停用/模型不可用）由路由先 loadRuntime 抛 HTTP 信封；
 * 流中（检索/LLM 失败）写 `event: error` 后关闭。
 */
export function toAgentSseReadable(input: TurnInput): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const iterator = runtime.streamTurn(input)[Symbol.asyncIterator]();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await iterator.next();
        if (done) {
          controller.close();
          return;
        }
        controller.enqueue(encoder.encode(encodeAgentSse(value)));
      } catch (err) {
        const e = err instanceof AppError ? err : undefined;
        const code = e?.code ?? 'PROVIDER_ERROR';
        const message = err instanceof Error ? err.message : String(err);
        controller.enqueue(encoder.encode(encodeAgentSse({ type: 'error', code, message })));
        controller.close();
      }
    },
    async cancel() {
      await iterator.return?.();
    },
  });
}

/**
 * /api/v1/agents —— Agent CRUD + 知识库/意图绑定 + 会话编排聊天。
 * 意图路由策略（intents.strategy）：retrieval 子集检索 / direct 话术 / workflow 工作流 / fallback 兜底。
 */
export const agentsRoutes = new Hono<AppEnv>()
  // ---------------- CRUD ----------------
  .get('/', async (c) => c.json(ok(await agentStore.list())))
  .post('/', async (c) => {
    const input = parse(createAgentInputSchema, await c.req.json());
    const created = await agentStore.create(input);
    return c.json(ok(agentViewSchema.parse(created)));
  })
  .get('/:agentId', async (c) => c.json(ok(await agentStore.get(agentIdParam(c)))))
  .patch('/:agentId', async (c) => {
    const input = parse(updateAgentInputSchema, await c.req.json());
    const updated = await agentStore.update(agentIdParam(c), input);
    return c.json(ok(agentViewSchema.parse(updated)));
  })
  .delete('/:agentId', async (c) => c.json(ok(await agentStore.remove(agentIdParam(c)))))

  // ---------------- 资源级 API 访问（独立 token） ----------------
  // 查询：GET /agents/:agentId/api-access（仅前缀，无明文）
  .get('/:agentId/api-access', async (c) => {
    const agentId = agentIdParam(c);
    const existing = await apiKeyStore.findByResource('agent', agentId);
    return c.json(ok(toAccess(agentId, existing)));
  })
  // 新建（幂等）：POST /agents/:agentId/api-access（首次返回明文 key）
  .post('/:agentId/api-access', async (c) => {
    const agentId = agentIdParam(c);
    const agent = await agentStore.get(agentId);
    const r = await apiKeyStore.ensureForResource('agent', agentId, `agent:${agent.name}`);
    return c.json(ok(toAccess(agentId, r)));
  })
  // 轮换：POST /agents/:agentId/api-access/rotate（返回新明文，旧 key 失效）
  .post('/:agentId/api-access/rotate', async (c) => {
    const agentId = agentIdParam(c);
    const agent = await agentStore.get(agentId);
    const r = await apiKeyStore.rotateForResource('agent', agentId, `agent:${agent.name}`);
    return c.json(ok(toAccess(agentId, r)));
  })
  // 调用日志：GET /agents/:agentId/api-logs?page=&perPage=
  .get('/:agentId/api-logs', async (c) => {
    const agentId = agentIdParam(c);
    await agentStore.get(agentId);
    const { page, perPage } = pageOptions(c);
    const result = await apiKeyStore.listResourceLogs('agent', agentId, { page, pageSize: perPage });
    return c.json(ok(apiCallLogListSchema.parse(result)));
  })

  // ---------------- 会话回读与标注 ----------------
  // 会话列表：GET /agents/:agentId/conversations
  .get('/:agentId/conversations', async (c) => {
    const agentId = agentIdParam(c);
    await agentStore.get(agentId);
    const list = await conversationStore.listByAgent(agentId);
    return c.json(ok(z.array(conversationListItemSchema).parse(list)));
  })
  // 会话消息：GET /agents/:agentId/conversations/:conversationId/messages
  .get('/:agentId/conversations/:conversationId/messages', async (c) => {
    const agentId = agentIdParam(c);
    const conversationId = parse(uuidSchema, c.req.param('conversationId'));
    const conv = await conversationStore.findConversation(conversationId);
    if (conv.agentId !== agentId) {
      throw new AppError('会话不属于该 Agent', 'FORBIDDEN', 403);
    }
    const messages = await conversationStore.listMessages(conversationId);
    return c.json(ok(z.array(conversationMessageSchema).parse(messages)));
  })
  // 消息标注：POST /agents/:agentId/messages/:messageId/feedback
  .post('/:agentId/messages/:messageId/feedback', async (c) => {
    const agentId = agentIdParam(c);
    const messageId = parse(uuidSchema, c.req.param('messageId'));
    const input = parse(messageFeedbackInputSchema, await c.req.json());
    const row = await conversationStore.findMessage(messageId);
    if (row.agentId !== agentId) {
      throw new AppError('消息不属于该 Agent', 'FORBIDDEN', 403);
    }
    const updated = await conversationStore.updateFeedback(messageId, {
      feedback: input.feedback,
      comment: input.comment,
    });
    return c.json(ok(conversationMessageSchema.parse(updated)));
  })

  // ---------------- 分享链接（多渠道发布） ----------------
  // 列表：GET /agents/:agentId/share-links
  .get('/:agentId/share-links', async (c) => {
    const agentId = agentIdParam(c);
    await agentStore.get(agentId);
    const list = await shareLinkStore.listByResource('agent', agentId);
    return c.json(ok(z.array(shareLinkViewSchema).parse(list)));
  })
  // 创建：POST /agents/:agentId/share-links（明文 token 仅本次返回）
  .post('/:agentId/share-links', async (c) => {
    const agentId = agentIdParam(c);
    await agentStore.get(agentId);
    const body = await c.req.json().catch(() => ({}));
    const input = parse(createShareLinkInputSchema, body);
    const created = await shareLinkStore.create('agent', agentId, {
      expiresAt: input.expiresAt ?? null,
      rpm: input.rpm ?? null,
    });
    return c.json(ok(shareLinkViewSchema.parse(created)));
  })
  // 撤销：POST /agents/:agentId/share-links/:shareId/revoke
  .post('/:agentId/share-links/:shareId/revoke', async (c) => {
    const agentId = agentIdParam(c);
    const shareId = parse(uuidSchema, c.req.param('shareId'));
    const updated = await shareLinkStore.revoke(shareId);
    if (updated.resourceId !== agentId) throw new AppError('分享链接不属于该 Agent', 'FORBIDDEN', 403);
    return c.json(ok(shareLinkViewSchema.parse(updated)));
  })
  // 删除：DELETE /agents/:agentId/share-links/:shareId
  .delete('/:agentId/share-links/:shareId', async (c) => {
    const shareId = parse(uuidSchema, c.req.param('shareId'));
    await shareLinkStore.remove(shareId);
    return c.json(ok({ id: shareId }));
  })

  // ---------------- Agent 会话编排 ----------------
  // 一次性 JSON：POST /agents/:agentId/chat（对外调用类，需 API Key）
  .post(
    '/:agentId/chat',
    requireExternalApi({ route: '/agents/:id/chat', agentFrom: { type: 'path', param: 'agentId' } }),
    async (c) => {
      const agentId = agentIdParam(c);
      const body = parse(agentChatRequestSchema, await c.req.json());
      const result = await runtime.chatOnce({
        agentId,
        sessionId: body.sessionId,
        query: body.query,
        temperature: body.temperature,
        maxTokens: body.maxTokens,
        topK: body.topK,
      });
      const parsed = agentChatResultSchema.parse(result);
      reportUsage(c, {
        tokens: parsed.usage ? (parsed.usage.inputTokens ?? 0) + (parsed.usage.outputTokens ?? 0) : null,
        requestContent: body.query,
        responseContent: parsed.content,
      });
      return c.json(ok(parsed));
    },
  )
  // 流式 SSE：POST /agents/:agentId/chat/stream（对外调用类，需 API Key）
  .post(
    '/:agentId/chat/stream',
    requireExternalApi({ route: '/agents/:id/chat', agentFrom: { type: 'path', param: 'agentId' } }),
    async (c) => {
    const agentId = agentIdParam(c);
    const body = parse(agentChatRequestSchema, await c.req.json());
    // 预检：agent 存在且 active、模型可运行——失败仍走 HTTP 失败信封（流头之前）
    await agentStore.loadRuntime(agentId);

    c.header('content-type', 'text/event-stream');
    c.header('cache-control', 'no-cache');
    c.header('connection', 'keep-alive');
    c.header('x-accel-buffering', 'no');
    return c.body(
      toAgentSseReadable({
        agentId,
        sessionId: body.sessionId,
        query: body.query,
        temperature: body.temperature,
        maxTokens: body.maxTokens,
        topK: body.topK,
      }),
      200,
    );
  });

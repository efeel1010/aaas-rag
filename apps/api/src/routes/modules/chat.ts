import { Hono } from 'hono';
import { chatRequestSchema, chatResultSchema, type AgentStreamEvent } from '@pulse/contracts';
import { ok } from '../../lib/http.js';
import { parse } from '../../lib/parse.js';
import type { AppEnv } from '../../types.js';
import { getRunnableModel, getRunnableModelChain } from '../../services/model-store.js';
import { completeWithFallback } from '../../lib/models/index.js';
import { toSseReadable } from '../../lib/models/streaming.js';
import { lastUserText } from '../../lib/models/types.js';
import { ConflictError } from '../../lib/errors.js';
import { agentStore } from '../../services/agent-store.js';
import { createAgentRuntime, type TurnInput } from '../../services/agent-runtime.js';
import { reportUsage, requireExternalApi } from '../../middleware/api-gateway.js';

/** 从 ChatResult / AgentChatResult 提取累计 token 用量（供用量采样） */
function tokensOf(u: {
  usage?: { inputTokens?: number; outputTokens?: number };
}): number | null {
  if (!u.usage) return null;
  return (u.usage.inputTokens ?? 0) + (u.usage.outputTokens ?? 0);
}

/**
 * 对外聊天接口（M2 模型网关直连 + M4 Agent 编排双通道）。
 *
 * 请求体 { modelId, messages, stream? } 或 { agentId, messages, stream? }：
 *  - modelId 直连通道（M2 既有契约，行为不变）：模型必须是 llm 类型且 active；
 *  - agentId 编排通道（M4）：触发完整 Agent 流程（意图识别→检索→prompt→LLM→记忆落库），
 *    模型由 Agent 绑定，messages 最后一条 user 消息作为 query，sessionId 支持多轮记忆。
 *  - stream:false（省略）-> 一次性 JSON（信封包 data=ChatResult / AgentChatResult）
 *  - stream:true         -> SSE 流（M2: event delta/usage/done/error；M4: meta/delta/usage/done/error）
 */
const runtime = createAgentRuntime();

function encodeAgentSse(event: AgentStreamEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

/** M4：Agent 编排 → SSE ReadableStream（错误双通道与 toSseReadable 一致） */
function toAgentSseReadable(input: TurnInput): ReadableStream<Uint8Array> {
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
        const code = err instanceof Error ? 'PROVIDER_ERROR' : 'PROVIDER_ERROR';
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

export const chatRoutes = new Hono<AppEnv>()
  .get('/support', (c) => {
    return c.json(
      ok({
        supported: true,
        streaming: 'sse',
        paths: ['/api/v1/chat', '/api/v1/chat/stream'],
        agentChat: { json: '/api/v1/agents/:id/chat', stream: '/api/v1/agents/:id/chat/stream' },
      }),
    );
  })

  // 一次性 JSON：POST /api/v1/chat（modelId 直连 或 agentId 编排）
  .post(
    '/',
    requireExternalApi({ route: '/chat', agentFrom: { type: 'body', field: 'agentId' } }),
    async (c) => {
      const raw = await c.req.json().catch(() => ({}));
      const request = parse(chatRequestSchema, raw);

      if (request.agentId) {
        const result = await runtime.chatOnce({
          agentId: request.agentId,
          sessionId: request.sessionId,
          query: lastUserText(request.messages),
          temperature: request.temperature,
          maxTokens: request.maxTokens,
        });
        reportUsage(c, { tokens: tokensOf(result) });
        return c.json(ok(result));
      }

      const chain = await getRunnableModelChain(request.modelId!);
      assertLlm(chain[0]!.model);
      const result = await completeWithFallback(chain, request);
      reportUsage(c, { tokens: tokensOf(result) });
      return c.json(ok(chatResultSchema.parse(result)));
    },
  )

  .post(
    '/stream',
    requireExternalApi({ route: '/chat', agentFrom: { type: 'body', field: 'agentId' } }),
    async (c) => {
    const raw = await c.req.json().catch(() => ({}));
    const request = parse(chatRequestSchema, raw);

    // M4 Agent 编排通道：先完成 agent 预检（失败走 HTTP 失败信封），再写流头
    if (request.agentId) {
      await agentStore.loadRuntime(request.agentId);
      c.header('content-type', 'text/event-stream');
      c.header('cache-control', 'no-cache');
      c.header('connection', 'keep-alive');
      c.header('x-accel-buffering', 'no');
      return c.body(
        toAgentSseReadable({
          agentId: request.agentId,
          sessionId: request.sessionId,
          query: lastUserText(request.messages),
          temperature: request.temperature,
          maxTokens: request.maxTokens,
        }),
        200,
      );
    }

    // M2 直连模型：一次性与流式
    if (!request.stream) {
      const chain = await getRunnableModelChain(request.modelId!);
      assertLlm(chain[0]!.model);
      const result = await completeWithFallback(chain, request);
      return c.json(ok(chatResultSchema.parse(result)));
    }

    const chain = await getRunnableModelChain(request.modelId!);
    assertLlm(chain[0]!.model);

    c.header('content-type', 'text/event-stream');
    c.header('cache-control', 'no-cache');
    c.header('connection', 'keep-alive');
    c.header('x-accel-buffering', 'no');
    return c.body(toSseReadable(chain[0]!.provider, chain[0]!.model, request, chain), 200);
  });

function assertLlm(model: Awaited<ReturnType<typeof getRunnableModel>>['model']): void {
  if (model.modelType !== 'llm') {
    throw new ConflictError(`模型「${model.name}」不是 llm 类型，无法执行聊天`);
  }
}

/**
 * M2 模型网关 SDK 门面。
 *
 * 统一入口，把「解密后 ProviderDescriptor + ModelDescriptor」交给对应 Provider 实现，
 * 并向路由层暴露：
 *   - chatStream / complete ：流式 / 一次性聊天
 *   - embed                 ：embedding
 *   - pingProvider          ：连通性探测
 */
import type {
  ChatResult,
  EmbeddingRequest,
  EmbeddingResult,
  ModelStreamEvent,
  ProviderPingResult,
  RerankRequest,
  RerankResult,
} from '@pulse/contracts';
import { createProvider } from './providers/index.js';
import type { ChatInvocation, ModelDescriptor, ProviderDescriptor } from './types.js';
import { logger } from '../logger.js';
import { ProviderError, ProviderUnavailableError } from './errors.js';

export { getRuntimeEncryptionKey } from './crypto.js';
export { createProvider, isMockMode } from './providers/index.js';
export { sseEncode, sseError, sseKeepAlive } from './sse.js';
export * from './errors.js';

/** 聊天（流式）：返回归一化事件序列 */
export async function* chatStream(
  provider: ProviderDescriptor,
  model: ModelDescriptor,
  request: ChatInvocation,
): AsyncIterable<ModelStreamEvent> {
  const client = createProvider(provider.type);
  yield* client.chatStream(provider, model, request);
}

/** 聊天（一次性）：由流式语言模型实现聚合出完整结果 */
export async function complete(
  provider: ProviderDescriptor,
  model: ModelDescriptor,
  request: ChatInvocation,
): Promise<ChatResult> {
  // 指定非流式模型代理：对上游仍走流式，但在这边聚合成完整文本返回
  let content = '';
  let usage: { inputTokens: number; outputTokens: number } | undefined;
  let id: string | undefined;
  for await (const evt of chatStream(provider, model, request)) {
    switch (evt.type) {
      case 'delta':
        content += evt.content;
        break;
      case 'usage':
        usage = { inputTokens: evt.inputTokens, outputTokens: evt.outputTokens };
        break;
      case 'done':
        id = evt.id;
        break;
      case 'error':
        throw new Error(`模型返回错误: ${evt.message}`);
    }
  }
  void id;
  return { content, model: model.name, usage };
}

/** embedding */
export async function embed(
  provider: ProviderDescriptor,
  model: ModelDescriptor,
  request: EmbeddingRequest,
): Promise<EmbeddingResult> {
  const client = createProvider(provider.type);
  return client.embedding(provider, model, request);
}

// ---------------------------------------------------------------------------
// 主备降级（Fallback）
// ---------------------------------------------------------------------------

/**
 * 判定「可降级的瞬时错误」：
 *  - ProviderUnavailableError（上游不可用，503）；
 *  - ProviderError 且上游 5xx（服务器错误，重试/切备用合理）；
 *  - TypeError（网络层失败，如 DNS / 连接中断）。
 * 鉴权类（ProviderAuthError，401/403）与 4xx 属配置问题，不做降级，避免掩盖错误。
 */
export function isTransientProviderError(err: unknown): boolean {
  if (err instanceof ProviderUnavailableError) return true;
  if (err instanceof ProviderError) return (err.upstreamStatus ?? 0) >= 500;
  if (err instanceof TypeError) return true;
  return false;
}

/**
 * 带主备降级的流式聊天：
 *  - 依次尝试 chain 中的每个模型；
 *  - 主模型「瞬时错误」且尚未产出任何 delta 时，切换下一个模型重试；
 *  - 一旦已产出 delta（客户端已看到输出）或错误不可降级，直接抛出。
 * streamImpl 可选注入（默认 chatStream），便于测试打桩。
 */
export async function* chatStreamWithFallback(
  chain: Array<{ provider: ProviderDescriptor; model: ModelDescriptor }>,
  request: ChatInvocation,
  streamImpl: typeof chatStream = chatStream,
): AsyncIterable<ModelStreamEvent> {
  const primary = chain[0];
  if (!primary) throw new ProviderUnavailableError('未配置可用的对话模型');
  const rest = chain.slice(1);
  let produced = false;
  try {
    for await (const evt of streamImpl(primary.provider, primary.model, request)) {
      if (evt.type === 'delta') produced = true;
      yield evt;
    }
    return;
  } catch (err) {
    if (produced || rest.length === 0 || !isTransientProviderError(err)) throw err;
    logger.warn(
      { from: primary.model.name, to: rest[0]?.model.name, error: err instanceof Error ? err.message : String(err) },
      '主模型调用失败，降级到备用模型',
    );
    yield* chatStreamWithFallback(rest, request, streamImpl);
  }
}

/** 带主备降级的一次性聊天（基于 chatStreamWithFallback 聚合） */
export async function completeWithFallback(
  chain: Array<{ provider: ProviderDescriptor; model: ModelDescriptor }>,
  request: ChatInvocation,
  streamImpl: typeof chatStream = chatStream,
): Promise<ChatResult> {
  let content = '';
  let usage: { inputTokens: number; outputTokens: number } | undefined;
  for await (const evt of chatStreamWithFallback(chain, request, streamImpl)) {
    switch (evt.type) {
      case 'delta':
        content += evt.content;
        break;
      case 'usage':
        usage = { inputTokens: evt.inputTokens, outputTokens: evt.outputTokens };
        break;
      case 'done':
        break;
      case 'error':
        throw new Error(`模型返回错误: ${evt.message}`);
    }
  }
  return { content, model: chain[0]?.model.name, usage };
}

/** 连通性探测 */
export async function pingProvider(
  provider: ProviderDescriptor,
  model: ModelDescriptor,
): Promise<ProviderPingResult> {
  const client = createProvider(provider.type);
  const result = await client.ping(provider, model);
  return {
    providerId: provider.id,
    type: provider.type,
    ok: true,
    latencyMs: result.latencyMs,
    model: result.model,
  };
}

/** rerank（重排）：把候选文档按与 query 的相关性重新排序 */
export async function fetchRerank(
  provider: ProviderDescriptor,
  model: ModelDescriptor,
  request: RerankRequest,
): Promise<RerankResult> {
  const client = createProvider(provider.type);
  return client.rerank(provider, model, request);
}
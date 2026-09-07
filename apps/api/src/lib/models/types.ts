/**
 * M2 模型网关内部类型 —— Provider 抽象层的核心契约。
 *
 * 与 packages/contracts 的“对外 API 契约”不同，这里定义的是
 * “数据库记录 + 解密后凭据 + 模型”构成的可执行上下文，供各 provider 实现消费。
 */
import type {
  ChatRequest,
  EmbeddingRequest,
  EmbeddingResult,
  ModelStreamEvent,
  ModelTypeValue,
  ProviderTypeValue,
  RerankRequest,
  RerankResult,
} from '@pulse/contracts';

/** 解密后的提供方上下文（credentials 已还原为明文，仅进程内存中使用） */
export interface ProviderDescriptor {
  id: string;
  type: ProviderTypeValue;
  name: string;
  config: Record<string, unknown> | null;
  credentials: Record<string, string | number | boolean>;
}

/** 注册在某 provider 下的模型上下文 */
export interface ModelDescriptor {
  id: string;
  name: string;
  modelType: ModelTypeValue;
  config: Record<string, unknown> | null;
}

/** ping 结果（provider 内部粒度） */
export interface PingResult {
  latencyMs: number;
  model?: string;
}

/**
 * 网关内部聊天调用参数：`stream` 仅对外路由层有意义。
 * Provider 实现一律走流式上游，故此处 stream 置空即可，显式放宽避免与契约默认歧义。
 */
export type ChatInvocation = Omit<ChatRequest, 'stream'> & { stream?: boolean };

/**
 * 统一 Provider 抽象接口。
 *  - chatStream：流式聊天，产出归一化事件（delta/usage/done）；出错时 throw，
 *    由 sdk/路由层决定「流前→HTTP 错误」还是「流中→SSE error 事件」。
 *  - embedding：非流式。
 *  - ping：连通性探测（轻量请求，绝不用用户密钥访问外部下载）。
 */
export interface ModelProvider {
  readonly type: ProviderTypeValue;
  chatStream(
    provider: ProviderDescriptor,
    model: ModelDescriptor,
    request: ChatInvocation,
  ): AsyncIterable<ModelStreamEvent>;
  embedding(
    provider: ProviderDescriptor,
    model: ModelDescriptor,
    request: EmbeddingRequest,
  ): Promise<EmbeddingResult>;
  ping(provider: ProviderDescriptor, model: ModelDescriptor): Promise<PingResult>;
  /**
   * rerank：把候选文档按与 query 的相关性重新排序（scores 归一化到相关性）。
   *  - openai_compatible：POST {baseURL}/reranks（扁平请求体，见 RerankRequest）；
   *  - Mock：返回确定性相关分，便于离线断言。
   * 各实现异常时 throw ProviderError；不重排的场景由上层「未配置 rerank 模型」平滑回退，不经过此方法。
   */
  rerank(
    provider: ProviderDescriptor,
    model: ModelDescriptor,
    request: RerankRequest,
  ): Promise<RerankResult>;
}

/** 无 DNS / fetch 依赖的纯辅助：取请求中的最后一条 user 消息内容 */
export function lastUserText(messages: ChatRequest['messages']): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role === 'user') return m.content;
  }
  return '';
}
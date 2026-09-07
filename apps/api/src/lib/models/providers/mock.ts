/**
 * Mock Provider —— 当 MOCK_MODELS=true 时取代任何真实 provider。
 *
 * 用于无外网 / CI 下验证网关链路：chat 流式回显、embedding 返回确定性向量、ping 恒成功。
 * 不发起任何真实网络请求。
 */
import type {
  EmbeddingRequest,
  EmbeddingResult,
  ModelStreamEvent,
  RerankRequest,
  RerankResult,
} from '@pulse/contracts';
import {
  lastUserText,
  type ChatInvocation,
  type ModelDescriptor,
  type ModelProvider,
  type PingResult,
  type ProviderDescriptor,
} from '../types.js';

export class MockProvider implements ModelProvider {
  readonly type = 'openai' as const;

  async *chatStream(
    _provider: ProviderDescriptor,
    model: ModelDescriptor,
    request: ChatInvocation,
  ): AsyncIterable<ModelStreamEvent> {
    const text = lastUserText(request.messages);
    // 逐词回显，模拟增量输出
    const tokens = text.length > 0 ? text.split(/(\s+)/) : ['(mock empty)'];
    for (const token of tokens) {
      await delay(5);
      yield { type: 'delta', content: token };
    }
    yield {
      type: 'usage',
      inputTokens: request.messages.reduce((n, m) => n + m.content.length, 0),
      outputTokens: text.length,
      model: model.name,
    };
    yield { type: 'done', id: `mock-${model.id}` };
  }

  async embedding(
    _provider: ProviderDescriptor,
    model: ModelDescriptor,
    request: EmbeddingRequest,
  ): Promise<EmbeddingResult> {
    const inputs = Array.isArray(request.input) ? request.input : [request.input];
    return {
      model: model.name,
      dimensions: 4,
      embeddings: inputs.map((s) => deterministicVector(s + model.id)),
    };
  }

  async ping(
    _provider: ProviderDescriptor,
    model: ModelDescriptor,
  ): Promise<PingResult> {
    await delay(2);
    return { latencyMs: 2, model: model.name };
  }

  /**
   * rerank：确定性假重排，不发真实请求。
   * 相关分 = 0.5 + 0.5 * (doc 与 query 的重叠 token 数 / query token 数)，
   * 命中 query 分词越多的文档得分越高（在 [0.5, 1.0]），便于离线断言排序。
   */
  async rerank(
    _provider: ProviderDescriptor,
    model: ModelDescriptor,
    request: RerankRequest,
  ): Promise<RerankResult> {
    const scored = request.documents
      .map((doc, index) => ({
        index,
        relevanceScore: deterministicRelevance(doc, request.query, model.id),
      }))
      .sort((a, b) => b.relevanceScore - a.relevanceScore);
    const totalTokens =
      request.documents.reduce((n, d) => n + d.length, 0) + request.query.length;
    return {
      model: model.name,
      results: scored,
      usage: { totalTokens },
    };
  }
}

/** 确定性相关分：doc 与 query 的 token 重叠占比（无真实语义，仅保证稳定可断言） */
function deterministicRelevance(doc: string, query: string, salt: string): number {
  const qTokens = new Set(query.split(/\s+/).filter(Boolean));
  if (qTokens.size === 0) return 0.5;
  const docTokens = doc.split(/\s+/).filter(Boolean);
  const overlap = docTokens.filter((t) => qTokens.has(t)).length;
  // 用 salt 做极小的扰动以打破完全并列，但保持确定性
  const jitter = hashString(doc + salt) % 1000 / 10_000; // 0 ~ 0.1
  return Math.min(1, 0.5 + (overlap / qTokens.size) * 0.5 + jitter);
}

function hashString(text: string): number {
  let h = 0;
  for (let i = 0; i < text.length; i++) {
    h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) ^ 0xdeadbeef;
  }
  return h >>> 0;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 由字符串生成确定性种子向量（模拟真实 embedding，便于断言） */
function deterministicVector(seed: string): number[] {
  let h = 0;
  for (let i = 0; i < seed.length; i++) {
    h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return [0.1, 0.2, 0.3, (h % 1000) / 1000];
}
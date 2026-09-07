/**
 * Provider 工厂分发 + Mock 网关行为（MOCK_MODELS=true，不发真实请求）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProvider, isMockMode } from '../../src/lib/models/providers/index.js';
import { complete, embed, fetchRerank, pingProvider } from '../../src/lib/models/index.js';
import type { ModelDescriptor, ProviderDescriptor } from '../../src/lib/models/types.js';
import { AnthropicProvider } from '../../src/lib/models/providers/anthropic.js';
import { OpenAICompatibleProvider } from '../../src/lib/models/providers/openai.js';
import { MockProvider } from '../../src/lib/models/providers/mock.js';

const provider: ProviderDescriptor = {
  id: 'p1',
  type: 'openai',
  name: 'tester',
  config: null,
  credentials: { apiKey: 'sk-test' },
};
const model: ModelDescriptor = {
  id: 'm1',
  name: 'mock-model',
  modelType: 'llm',
  config: null,
};

describe('provider factory 分发', () => {
  const ORIG = process.env.MOCK_MODELS;

  beforeEach(() => {
    process.env.MOCK_MODELS = 'false';
  });
  afterEach(() => {
    process.env.MOCK_MODELS = ORIG;
  });

  it('按 type 分发改真实实现（构造即可，不触网）', () => {
    expect(createProvider('openai')).toBeInstanceOf(OpenAICompatibleProvider);
    expect(createProvider('openai_compatible')).toBeInstanceOf(OpenAICompatibleProvider);
    expect(createProvider('anthropic')).toBeInstanceOf(AnthropicProvider);
  });

  it('MOCK_MODELS=true 时统一返回 MockProvider，且 isMockMode 成立', () => {
    process.env.MOCK_MODELS = 'true';
    expect(isMockMode()).toBe(true);
    expect(createProvider('openai')).toBeInstanceOf(MockProvider);
    expect(createProvider('anthropic')).toBeInstanceOf(MockProvider);
  });
});

describe('Mock 网关行为（MOCK_MODELS=true）', () => {
  const ORIG = process.env.MOCK_MODELS;

  beforeEach(() => {
    process.env.MOCK_MODELS = 'true';
  });
  afterEach(() => {
    process.env.MOCK_MODELS = ORIG;
  });

  it('complete 把流式 delta 聚合成完整文本（回显最后 user 消息）', async () => {
    const result = await complete(provider, model, {
      modelId: model.id,
      messages: [{ role: 'user', content: 'hello pulse' }],
    });
    expect(result.content.replace(/\s/g, '')).toBe('hellopulse');
    expect(result.model).toBe('mock-model');
    expect(result.usage?.outputTokens).toBeGreaterThan(0);
  });

  it('chatStream 依次产出 delta → usage → done', async () => {
    const events: string[] = [];
    for await (const evt of createProvider('openai').chatStream(provider, model, {
      modelId: model.id,
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    })) {
      events.push(evt.type);
    }
    expect(events).toContain('delta');
    expect(events).toContain('usage');
    expect(events[events.length - 1]).toBe('done');
  });

  it('embed 返回 4 维确定性向量，且不同输入向量不同', async () => {
    const a = await embed(provider, { ...model, modelType: 'embedding' }, { modelId: model.id, input: 'cat' });
    const b = await embed(provider, { ...model, modelType: 'embedding' }, { modelId: model.id, input: 'dog' });
    expect(a.dimensions).toBe(4);
    expect(a.embeddings).toHaveLength(1);
    expect(a.embeddings[0]).toHaveLength(4);
    expect(a.embeddings[0]).not.toEqual(b.embeddings[0]);
  });

  it('ping 连通性恒成功并报告延迟', async () => {
    const result = await pingProvider(provider, model);
    expect(result.ok).toBe(true);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(result.model).toBe('mock-model');
  });

  it('Mock rerank：确定性相关分排序，命中 query token 越多越靠前', async () => {
    const rrModel: ModelDescriptor = { id: 'r1', name: 'mock-rerank', modelType: 'rerank', config: null };
    const result = await fetchRerank(provider, rrModel, {
      query: '7天 无理由 退货',
      documents: ['本店支持7天无理由退货', '发票相关说明', '7天退货绿色通道'],
    });
    // 更贴近 query 的文档排前（按 relevanceScore 降序）
    expect(result.model).toBe('mock-rerank');
    expect(result.results).toHaveLength(3);
    expect(result.results[0]!.relevanceScore).toBeGreaterThanOrEqual(
      result.results[result.results.length - 1]!.relevanceScore,
    );
    expect(result.usage?.totalTokens).toBeGreaterThan(0);
  });

  it('Mock rerank：模型类型为 rerank 时返回 index 覆盖全部 documents', async () => {
    const rrModel: ModelDescriptor = { id: 'r2', name: 'mock-rerank', modelType: 'rerank', config: null };
    const result = await fetchRerank(provider, rrModel, {
      query: 'q',
      documents: ['a', 'b', 'c'],
      topN: 2,
    });
    const indexes = result.results.map((r) => r.index).sort();
    expect(indexes).toEqual([0, 1, 2]);
  });
});

describe('OpenAICompatible provider rerank（真实实现，fetch 打桩）', () => {
  const ORIG = process.env.MOCK_MODELS;
  const rrProvider: ProviderDescriptor = {
    id: 'dashscope',
    type: 'openai_compatible',
    name: 'DashScope',
    config: {
      baseURL:
        'https://wks-1234.cn-beijing.maas.aliyuncs.com/compatible-api/v1',
    },
    credentials: { apiKey: 'sk-dashscope-test' },
  };
  const rrModel: ModelDescriptor = {
    id: 'm-qw',
    name: 'qwen3-rerank-755b3b92a2af',
    modelType: 'rerank',
    config: null,
  };

  afterEach(() => {
    process.env.MOCK_MODELS = ORIG;
    vi.unstubAllGlobals();
  });

  it('POST {baseURL}/reranks 扁平请求体；解析扁平响应归一化为 RerankResult', async () => {
    process.env.MOCK_MODELS = 'false';
    let capturedUrl = '';
    let capturedBody: unknown;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown, init?: { body?: unknown }) => {
        capturedUrl = String(url);
        capturedBody = init?.body;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            model: 'qwen3-rerank-755b3b92a2af',
            results: [
              { index: 2, relevance_score: 0.95 },
              { index: 0, relevance_score: 0.71 },
              { index: 1, relevance_score: 0.3 },
            ],
            usage: { total_tokens: 42 },
          }),
        } as unknown as Response;
      }),
    );

    const result = await fetchRerank(rrProvider, rrModel, {
      query: '怎么退货',
      documents: ['a', 'b', 'c'],
      topN: 3,
      instruct: true,
    });

    expect(capturedUrl).toBe(
      'https://wks-1234.cn-beijing.maas.aliyuncs.com/compatible-api/v1/reranks',
    );
    expect(JSON.parse(String(capturedBody))).toEqual({
      model: 'qwen3-rerank-755b3b92a2af',
      query: '怎么退货',
      documents: ['a', 'b', 'c'],
      top_n: 3,
      instruct: true,
    });
    expect(result.model).toBe('qwen3-rerank-755b3b92a2af');
    expect(result.results).toEqual([
      { index: 2, relevanceScore: 0.95 },
      { index: 0, relevanceScore: 0.71 },
      { index: 1, relevanceScore: 0.3 },
    ]);
    expect(result.usage?.totalTokens).toBe(42);
  });

  it('上游 401 → 抛出 ProviderAuthError', async () => {
    process.env.MOCK_MODELS = 'false';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        return {
          ok: false,
          status: 401,
          json: async () => ({ error: { message: 'invalid api key' } }),
        } as unknown as Response;
      }),
    );
    await expect(
      fetchRerank(rrProvider, rrModel, { query: 'q', documents: ['a'] }),
    ).rejects.toThrow(/Provider 请求失败/);
  });
});
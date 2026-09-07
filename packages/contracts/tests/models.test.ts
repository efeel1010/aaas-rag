/**
 * @pulse/contracts M2 模型网关契约单测 —— 校验 schema 的合法性约束。
 */
import { describe, expect, it } from 'vitest';
import {
  chatRequestSchema,
  createModelInputSchema,
  createProviderInputSchema,
  embeddingRequestSchema,
  modelStreamEventSchema,
  modelTypeSchema,
  providerTypeSchema,
  rerankRequestSchema,
  rerankResultSchema,
} from '../src/models.js';

describe('providerTypeSchema / modelTypeSchema', () => {
  it('枚举合法取值', () => {
    expect(providerTypeSchema.parse('openai')).toBe('openai');
    expect(providerTypeSchema.parse('openai_compatible')).toBe('openai_compatible');
    expect(providerTypeSchema.parse('anthropic')).toBe('anthropic');
    expect(modelTypeSchema.parse('embedding')).toBe('embedding');
    expect(() => providerTypeSchema.parse('azure')).toThrow();
  });
});

describe('createProviderInputSchema', () => {
  it('合法输入通过并透传凭据', () => {
    const input = createProviderInputSchema.parse({
      type: 'openai',
      name: 'OpenAI',
      credentials: { apiKey: 'sk-123' },
      config: { baseURL: 'https://api.openai.com/v1' },
    });
    expect(input.credentials?.apiKey).toBe('sk-123');
  });

  it('type 非法 / 名称缺失会被拒绝', () => {
    expect(() => createProviderInputSchema.parse({ name: 'x' })).toThrow();
    expect(() => createProviderInputSchema.parse({ type: 'openai', name: '' })).toThrow();
    expect(() =>
      createProviderInputSchema.parse({
        type: 'unsupported',
        name: 'x',
      }),
    ).toThrow();
  });
});

describe('createModelInputSchema', () => {
  it('合法输入通过；providerId 非 uuid 拒绝', () => {
    const ok = createModelInputSchema.parse({
      providerId: '00000000-0000-0000-0000-000000000000',
      name: 'gpt-4o',
      modelType: 'llm',
    });
    expect(ok.name).toBe('gpt-4o');
    expect(() =>
      createModelInputSchema.parse({ providerId: 'not-a-uuid', name: 'x', modelType: 'llm' }),
    ).toThrow();
  });
});

describe('chatRequestSchema', () => {
  const base = {
    modelId: '00000000-0000-0000-0000-000000000000',
    messages: [{ role: 'user' as const, content: 'hi' }],
  };
  it('合法请求通过，stream 缺省为 false', () => {
    const req = chatRequestSchema.parse(base);
    expect(req.stream).toBe(false);
  });
  it('空 messages 被拒绝', () => {
    expect(() => chatRequestSchema.parse({ ...base, messages: [] })).toThrow();
  });
  it('非法 role / 非 uuid modelId 被拒绝', () => {
    expect(() =>
      chatRequestSchema.parse({ modelId: 'abc', messages: [{ role: 'admin', content: 'x' }] }),
    ).toThrow();
  });
  it('temperature 越界被拒绝', () => {
    expect(() => chatRequestSchema.parse({ ...base, temperature: 3 })).toThrow();
  });
});

describe('embeddingRequestSchema', () => {
  it('接受单串与字符串数组', () => {
    const single = embeddingRequestSchema.parse({ modelId: '00000000-0000-0000-0000-000000000000', input: 'hi' });
    const multi = embeddingRequestSchema.parse({ modelId: '00000000-0000-0000-0000-000000000000', input: ['a', 'b'] });
    expect(single.input).toBe('hi');
    expect(multi.input).toHaveLength(2);
  });
  it('空数组被拒绝', () => {
    expect(() =>
      embeddingRequestSchema.parse({ modelId: '00000000-0000-0000-0000-000000000000', input: [] }),
    ).toThrow();
  });
});

describe('rerankRequestSchema / rerankResultSchema', () => {
  it('合法 rerank 请求通过；空 documents / 空 query 拒绝', () => {
    const req = rerankRequestSchema.parse({
      query: '怎么退货',
      documents: ['a', 'b'],
      topN: 2,
      instruct: true,
    });
    expect(req.documents).toHaveLength(2);
    expect(req.topN).toBe(2);
    expect(() => rerankRequestSchema.parse({ query: 'q', documents: [] })).toThrow();
    expect(() => rerankRequestSchema.parse({ query: '  ', documents: ['a'] })).toThrow();
  });

  it('rerank 结果归一化契约接受扁平 index/relevanceScore 与 usage.totalTokens', () => {
    const result = rerankResultSchema.parse({
      model: 'qwen3-rerank',
      results: [
        { index: 1, relevanceScore: 0.9 },
        { index: 0, relevanceScore: 0.2 },
      ],
      usage: { totalTokens: 42 },
    });
    expect(result.results[0]?.index).toBe(1);
    expect(result.results[0]?.relevanceScore).toBe(0.9);
    expect(result.usage?.totalTokens).toBe(42);
    // 空 results 合法；缺 results 字段拒绝
    expect(rerankResultSchema.parse({ results: [] }).results).toHaveLength(0);
    expect(() => rerankResultSchema.parse({})).toThrow();
  });
});

describe('modelStreamEventSchema', () => {
  it('判别联合按 type 校验', () => {
    expect(modelStreamEventSchema.parse({ type: 'delta', content: 'hi' })).toBeTruthy();
    expect(
      modelStreamEventSchema.parse({ type: 'usage', inputTokens: 1, outputTokens: 2 }),
    ).toBeTruthy();
    expect(modelStreamEventSchema.parse({ type: 'error', code: 'X', message: 'm' })).toBeTruthy();
    // delta 缺 content 拒绝
    expect(() => modelStreamEventSchema.parse({ type: 'delta' })).toThrow();
    // 未知 type 拒绝
    expect(() =>
      modelStreamEventSchema.parse({ type: 'unknown', content: 'hi' }),
    ).toThrow();
  });
});
/**
 * M-A 内置工具单测 —— local_retrieval（本地知识库检索）与 http_request（第三方 GET）。
 * 两个工具均依赖注入的 ctx（retrieve / fetch），测试全程无 DB、无外网。
 */
import { describe, expect, it, vi } from 'vitest';
import type { RetrievalResult } from '@pulse/contracts';
import {
  assertHttpUrl,
  httpRequestTool,
  localRetrievalTool,
} from '../../src/lib/tools/implementations.js';
import type { ToolContext } from '../../src/lib/tools/types.js';

const DS_ID = '33333333-3333-3333-3333-333333333333';
const RR_ID = '22222222-2222-2222-2222-222222222222';

function retrievalResult(query: string): RetrievalResult {
  return {
    query,
    datasetIds: [DS_ID],
    topK: 6,
    total: 1,
    hits: [
      {
        chunkId: '11111111-1111-1111-1111-111111111111',
        documentId: '22222222-2222-2222-2222-222222222222',
        datasetId: DS_ID,
        content: '本店商品支持7天无理由退货',
        tokens: 8,
        metadata: { documentName: '售后政策.md' },
        score: 0.9,
        vectorScore: 0.9,
        keywordScore: null,
        source: 'vector',
      },
    ],
  };
}

describe('local_retrieval 工具', () => {
  it('调用注入的检索实现并返回 text + 结构化 data（含来源文档名）', async () => {
    const retrieve = vi.fn(async (query: string, datasetIds: string[], topK: number, rr?: string | null) => {
      expect(query).toBe('退货政策是什么');
      expect(datasetIds).toEqual([DS_ID]);
      expect(topK).toBe(3);
      expect(rr).toBe(RR_ID);
      return retrievalResult(query);
    });
    const ctx: ToolContext = {
      agent: { agentId: 'a', rerankModelId: RR_ID, datasets: [{ datasetId: DS_ID, datasetName: '商品库', weight: 100 }] },
      retrieve,
    };

    const result = await localRetrievalTool.run(
      { query: '退货政策是什么', datasetIds: [DS_ID], topK: 3 },
      ctx,
    );
    expect(result.text).toContain('本店商品支持7天无理由退货');
    expect(result.text).toContain('[售后政策.md]');
    expect(result.data).toMatchObject({ total: 1, datasetIds: [DS_ID] });
    expect(retrieve).toHaveBeenCalledTimes(1);
  });

  it('未传 datasetIds 时回退 Agent 绑定的全部知识库', async () => {
    const retrieve = vi.fn(async (query: string) => retrievalResult(query));
    const ctx: ToolContext = {
      agent: {
        agentId: 'a',
        rerankModelId: null,
        datasets: [
          { datasetId: DS_ID, datasetName: '商品库', weight: 100 },
          { datasetId: '44444444-4444-4444-4444-444444444444', datasetName: '政策库', weight: 80 },
        ],
      },
      retrieve,
    };
    await localRetrievalTool.run({ query: '退货' }, ctx);
    expect(retrieve).toHaveBeenCalledWith(
      '退货',
      [DS_ID, '44444444-4444-4444-4444-444444444444'],
      6,
      null,
    );
  });

  it('Agent 未绑定知识库 → 抛错（可被上层归一为 error outcome）', async () => {
    await expect(
      localRetrievalTool.run(
        { query: 'x' },
        { agent: { agentId: 'a', rerankModelId: null, datasets: [] }, retrieve: async () => retrievalResult('x') },
      ),
    ).rejects.toThrow('未绑定知识库');
  });

  it('未注入检索实现 → 抛错', async () => {
    await expect(localRetrievalTool.run({ query: 'x' }, { agent: { agentId: 'a', rerankModelId: null, datasets: [{ datasetId: DS_ID, datasetName: 'x', weight: 1 }] } })).rejects.toThrow(
      '未注入检索实现',
    );
  });

  it('参数校验：非法 datasetIds / topK 越界被 parameters 拒绝', () => {
    expect(() => localRetrievalTool.parameters.parse({ query: 'x', datasetIds: ['bad'], topK: 1 })).toThrow();
    expect(() => localRetrievalTool.parameters.parse({ query: 'x', topK: 21 })).toThrow();
    expect(localRetrievalTool.parameters.parse({ query: 'x' }).topK).toBeUndefined();
  });
});

describe('http_request 工具', () => {
  it('GET 成功：返回 text + 结构化 {status, data}（JSON 响应自动解析）', async () => {
    const fetchMock = vi.fn(async () => {
      return {
        status: 200,
        url: 'https://api.example.com/data',
        text: async () => JSON.stringify({ ok: true, count: 3 }),
      } as unknown as Response;
    });
    const ctx: ToolContext = { fetch: fetchMock as unknown as typeof fetch };

    const result = await httpRequestTool.run(
      { url: 'https://api.example.com/data', timeoutMs: 1000 },
      ctx,
    );
    expect(result.data).toEqual({ status: 200, data: { ok: true, count: 3 } });
    expect(result.text).toContain('[http_request 200]');
    expect(fetchMock).toHaveBeenCalledWith('https://api.example.com/data', expect.objectContaining({ method: 'GET' }));
  });

  it('非 JSON 响应保留原文', async () => {
    const fetchMock = vi.fn(async () => {
      return {
        status: 200,
        url: 'https://example.com/txt',
        text: async () => 'plain text body',
      } as unknown as Response;
    });
    const ctx: ToolContext = { fetch: fetchMock as unknown as typeof fetch };
    const result = await httpRequestTool.run({ url: 'https://example.com/txt' }, ctx);
    expect(result.data).toEqual({ status: 200, data: 'plain text body' });
  });

  it('请求抛错 → 抛错（含原因）', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('ENOTFOUND');
    });
    const ctx: ToolContext = { fetch: fetchMock as unknown as typeof fetch };
    await expect(httpRequestTool.run({ url: 'https://example.com/x' }, ctx)).rejects.toThrow(
      'ENOTFOUND',
    );
  });

  it('assertHttpUrl 仅允许 http/https', () => {
    expect(() => assertHttpUrl('https://example.com')).not.toThrow();
    expect(() => assertHttpUrl('http://example.com')).not.toThrow();
    expect(() => assertHttpUrl('ftp://example.com')).toThrow(/仅允许 http\/https/);
    expect(() => assertHttpUrl('file:///etc/passwd')).toThrow(/仅允许 http\/https/);
    expect(() => assertHttpUrl('javascript:alert(1)')).toThrow();
  });

  it('参数校验：非法 URL / timeoutMs 越界拒绝', () => {
    expect(() => httpRequestTool.parameters.parse({ url: 'not-a-url' })).toThrow();
    expect(() => httpRequestTool.parameters.parse({ url: 'https://example.com', timeoutMs: 10 })).toThrow();
    expect(() => httpRequestTool.parameters.parse({ url: 'https://example.com', timeoutMs: 61_000 })).toThrow();
    expect(httpRequestTool.parameters.parse({ url: 'https://example.com' }).timeoutMs).toBeUndefined();
  });
});

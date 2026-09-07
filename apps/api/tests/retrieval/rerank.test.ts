/**
 * Rerank 编排单测 —— applyRerankOrdering（纯函数排序）+ rerankHits（平滑回退 / 真实调用）。
 *
 * 依赖打桩：
 *  - getRunnableModel 只出 mock rerank 模型的 { provider, model }；
 *  - fetchRerank stub 返回受控的重排结果，验证映射/排序确定性。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RetrievalHitView } from '@pulse/contracts';

vi.mock('../../src/services/model-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/model-store.js')>();
  return { ...actual, getRunnableModel: vi.fn() };
});
vi.mock('../../src/lib/models/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/models/index.js')>();
  return { ...actual, fetchRerank: vi.fn() };
});

import { getRunnableModel } from '../../src/services/model-store.js';
import { fetchRerank } from '../../src/lib/models/index.js';
import { applyRerankOrdering, rerankHits } from '../../src/lib/retrieval/rerank.js';

const MODEL_ID = '22222222-2222-2222-2222-222222222222';

function hit(id: string, content: string): RetrievalHitView {
  return {
    chunkId: id,
    documentId: '00000000-0000-0000-0000-000000000000',
    datasetId: '33333333-3333-3333-3333-333333333333',
    content,
    tokens: 5,
    metadata: null,
    score: 0.5,
    vectorScore: 0.5,
    keywordScore: null,
    source: 'vector',
  };
}

const MOCK_GET: Awaited<ReturnType<typeof getRunnableModel>> = {
  provider: { id: 'p1', type: 'openai_compatible', name: 'rr', config: null, credentials: { apiKey: 'k' } },
  model: { id: MODEL_ID, name: 'qwen3-rerank', modelType: 'rerank', config: null },
};

beforeEach(() => {
  vi.clearAllMocks();
  (getRunnableModel as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_GET);
});

const getFetchRerank = fetchRerank as ReturnType<typeof vi.fn>;

describe('applyRerankOrdering（纯函数排序）', () => {
  it('按 relevance_score 降序重排，写 rerankScore 与重排前排名 originalRank', () => {
    const hits = [hit('a', '退款政策'), hit('b', '发货说明'), hit('c', '退货流程')];
    const result = applyRerankOrdering(hits, {
      model: 'qw',
      results: [
        { index: 2, relevanceScore: 0.9 },
        { index: 0, relevanceScore: 0.6 },
        { index: 1, relevanceScore: 0.2 },
      ],
    });
    expect(result.map((h) => h.chunkId)).toEqual(['c', 'a', 'b']);
    // 重排前排名：a=0,b=1,c=2
    expect(result).toEqual([
      expect.objectContaining({ chunkId: 'c', originalRank: 2, rerankScore: 0.9 }),
      expect.objectContaining({ chunkId: 'a', originalRank: 0, rerankScore: 0.6 }),
      expect.objectContaining({ chunkId: 'b', originalRank: 1, rerankScore: 0.2 }),
    ]);
  });

  it('未映射到的候选 rerankScore=null，排在已重排之后', () => {
    const hits = [hit('a', 'x'), hit('b', 'y'), hit('c', 'z')];
    const result = applyRerankOrdering(hits, {
      results: [
        { index: 1, relevanceScore: 0.8 },
        { index: 0, relevanceScore: 0.3 },
      ],
    });
    expect(result.map((h) => h.chunkId)).toEqual(['b', 'a', 'c']);
    expect(result[0]).toMatchObject({ chunkId: 'b', rerankScore: 0.8 });
    expect(result[2]).toMatchObject({ chunkId: 'c', rerankScore: null });
  });

  it('空 hits 原样返回', () => {
    expect(applyRerankOrdering([], { results: [] })).toEqual([]);
  });
});

describe('rerankHits', () => {
  it('未绑定 rerank 模型 → 原样返回（平滑回退），不触达 getRunnableModel/fetchRerank', async () => {
    const hits = [hit('a', 'x'), hit('b', 'y')];
    const out = await rerankHits({ hits, query: 'q', rerankModelId: undefined });
    expect(out).toBe(hits);
    expect(out).toHaveLength(2);
    expect(out[0]?.rerankScore).toBeUndefined();
    expect(getRunnableModel).not.toHaveBeenCalled();
    expect(getFetchRerank).not.toHaveBeenCalled();
  });

  it('绑定 rerank 模型 → 调 fetchRerank，按相关分重排', async () => {
    const hits = [hit('a', '不相关文本'), hit('b', '也一般'), hit('c', '最相关内容')];
    getFetchRerank.mockResolvedValue({
      model: 'qw',
      results: [
        { index: 2, relevanceScore: 0.99 },
        { index: 0, relevanceScore: 0.4 },
        { index: 1, relevanceScore: 0.1 },
      ],
    });
    const out = await rerankHits({ hits, query: '最相关内容', rerankModelId: MODEL_ID });
    expect(getRunnableModel).toHaveBeenCalledWith(MODEL_ID);
    expect(getFetchRerank).toHaveBeenCalledWith(
      MOCK_GET.provider,
      MOCK_GET.model,
      { query: '最相关内容', documents: ['不相关文本', '也一般', '最相关内容'] },
    );
    expect(out.map((h) => h.chunkId)).toEqual(['c', 'a', 'b']);
  });

  it('绑定的是一个 llm 模型 → 抛 ConflictError（不是 rerank 类型）', async () => {
    (getRunnableModel as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...MOCK_GET,
      model: { id: MODEL_ID, name: 'llm', modelType: 'llm', config: null },
    });
    await expect(
      rerankHits({ hits: [hit('a', 'x')], query: 'q', rerankModelId: MODEL_ID }),
    ).rejects.toThrow(/不是 rerank 类型/);
    expect(getFetchRerank).not.toHaveBeenCalled();
  });
});
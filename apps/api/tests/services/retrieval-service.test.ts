/**
 * 检索服务单测 —— hybridRetrieve「开/关 rerank」路径。
 *
 * DB 打桩：mock lib/db.js 的 getDb().execute 返回固定候选行（含 sim/kw 双路分）；
 * rerank 依赖打桩：mock model-store.getRunnableModel + lib/models.fetchRerank。
 * MOCK_INGEST=true 让 queryVector/embedTexts 走确定性假向量，不触真实模型/外网。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RetrievalResult, RerankResult } from '@pulse/contracts';

const ORIG_MOCK_INGEST = process.env.MOCK_INGEST;

vi.mock('../../src/lib/db.js', () => ({ getDb: vi.fn() }));
vi.mock('../../src/services/model-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/model-store.js')>();
  return { ...actual, getRunnableModel: vi.fn() };
});
vi.mock('../../src/lib/models/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/models/index.js')>();
  return { ...actual, fetchRerank: vi.fn() };
});

import { getDb } from '../../src/lib/db.js';
import { getRunnableModel } from '../../src/services/model-store.js';
import { fetchRerank } from '../../src/lib/models/index.js';
import { hybridRetrieve } from '../../src/services/retrieval-service.js';

const DS_A = '33333333-3333-3333-3333-333333333333';
const MODEL_ID = '22222222-2222-2222-2222-222222222222';

/** 三行候选：RRF 序 a>b>c（a 双路分最高），逆序 sim 利于让 rerank 把 c 顶到最前 */
const ROWS = [
  {
    id: 'a', document_id: 'd1', dataset_id: DS_A, content: '保单理赔条款', tokens: 6,
    metadata: { documentName: '理赔.md' }, sim: 0.9, kw: 0.1,
  },
  {
    id: 'b', document_id: 'd2', dataset_id: DS_A, content: '保单投保说明', tokens: 6,
    metadata: { documentName: '投保.md' }, sim: 0.8, kw: 0.2,
  },
  {
    id: 'c', document_id: 'd3', dataset_id: DS_A, content: '理赔流程超长文案', tokens: 12,
    metadata: { documentName: '流程.md' }, sim: 0.7, kw: 0.3,
  },
];

const getFetchRerank = fetchRerank as ReturnType<typeof vi.fn>;

function stubDb() {
  const execute = vi.fn(async () => ({ rows: ROWS, rowCount: ROWS.length }));
  (getDb as ReturnType<typeof vi.fn>).mockReturnValue({ execute });
  return execute;
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.MOCK_INGEST = 'true';
  stubDb();
});

afterEach(() => {
  if (ORIG_MOCK_INGEST === undefined) delete process.env.MOCK_INGEST;
  else process.env.MOCK_INGEST = ORIG_MOCK_INGEST;
});

describe('hybridRetrieve rerank 开关', () => {
  it('不传 rerankModelId → 直接返回 RRF topK，命中无 rerankScore（平滑回退）', async () => {
    const result: RetrievalResult = await hybridRetrieve({
      query: '理赔',
      datasetIds: [DS_A],
      topK: 2,
      rffK: 60,
    });
    // RRF 序 a,b → topK=2
    expect(result.hits.map((h) => h.chunkId)).toEqual(['a', 'b']);
    expect(result.total).toBe(2);
    expect(result.hits[0]?.rerankScore).toBeUndefined();
    expect(result.hits[0]?.originalRank).toBeUndefined();
    expect(getFetchRerank).not.toHaveBeenCalled();
  });

  it('传入 rerankModelId → RRF 取 topK*3 候选经 rerank 重排再取 topK', async () => {
    (getRunnableModel as ReturnType<typeof vi.fn>).mockResolvedValue({
      provider: { id: 'p1', type: 'openai_compatible', name: 'rr', config: null, credentials: { apiKey: 'k' } },
      model: { id: MODEL_ID, name: 'qwen3-rerank', modelType: 'rerank', config: null },
    });
    // 候选顺序即 RRF 序 [a,b,c]，rerank 把 c 顶到最前
    const rerankResult: RerankResult = {
      model: 'qwen3-rerank',
      results: [
        { index: 2, relevanceScore: 0.99 },
        { index: 1, relevanceScore: 0.5 },
        { index: 0, relevanceScore: 0.2 },
      ],
    };
    getFetchRerank.mockResolvedValue(rerankResult);

    const result: RetrievalResult = await hybridRetrieve({
      query: '理赔',
      datasetIds: [DS_A],
      topK: 2,
      rffK: 60,
      rerankModelId: MODEL_ID,
    });

    // rerank 后取 topK=2 → [c, b]
    expect(result.hits.map((h) => h.chunkId)).toEqual(['c', 'b']);
    expect(result.total).toBe(2);
    expect(result.hits[0]).toMatchObject({ chunkId: 'c', rerankScore: 0.99, originalRank: 2 });
    // documents 是按候选顺序传的 [a,b,c]
    expect(getFetchRerank).toHaveBeenCalledTimes(1);
    const [, model, request] = getFetchRerank.mock.calls[0]!;
    expect(request).toMatchObject({
      query: '理赔',
      documents: ['保单理赔条款', '保单投保说明', '理赔流程超长文案'],
    });
    expect(model.modelType).toBe('rerank');
  });

  it('rerank 模型类型非 rerank → 抛出 ConflictError', async () => {
    (getRunnableModel as ReturnType<typeof vi.fn>).mockResolvedValue({
      provider: { id: 'p1', type: 'openai', name: 'llm', config: null, credentials: { apiKey: 'k' } },
      model: { id: MODEL_ID, name: 'gpt', modelType: 'llm', config: null },
    });
    await expect(
      hybridRetrieve({ query: 'q', datasetIds: [DS_A], topK: 2, rerankModelId: MODEL_ID }),
    ).rejects.toThrow(/不是 rerank 类型/);
  });
});
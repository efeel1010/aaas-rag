/**
 * Rerank 编排 —— RAG 检索重排层。
 *
 * 在混合检索（RRF 融合后的 topK*3 候选）之后、取最终 topK 之前，调用 rerank 模型
 * 对候选按「与 query 的相关性」重新排序，提升排序精度。
 *
 * 平滑回退三种情况不重排，直接原样返回：
 *  - 未绑定 rerank 模型（rerankModelId 为空）；
 *  - 候选为空；
 *  - 上游缺失某候选的重排分（以 rerankScore=null 保留在结果中）。
 */
import type { RerankResult, RetrievalHitView } from '@pulse/contracts';
import { fetchRerank } from '../models/index.js';
import { getRunnableModel } from '../../services/model-store.js';
import { ConflictError } from '../errors.js';

/** rerankHits 入参 */ 
export interface RerankHitsInput {
  hits: RetrievalHitView[];
  query: string;
  /** 可选：rerank 模型 id；缺省 / 空则原样返回（平滑回退） */
  rerankModelId?: string | null;
}

/**
 * 对候选命中做重排。无 rerank 模型 / 空候选 → 原样返回。
 */
export async function rerankHits({
  hits,
  query,
  rerankModelId,
}: RerankHitsInput): Promise<RetrievalHitView[]> {
  if (!rerankModelId || hits.length === 0) return hits;

  const { provider, model } = await getRunnableModel(rerankModelId);
  if (model.modelType !== 'rerank') {
    throw new ConflictError(`模型「${model.name}」不是 rerank 类型，无法重排`);
  }
  const result = await fetchRerank(provider, model, {
    query,
    documents: hits.map((h) => h.content),
  });
  return applyRerankOrdering(hits, result);
}

/**
 * 纯函数：把上游 rerank 结果映射回候选命中，并按其相关分降序重排。
 *  - 写入重排前排名 originalRank（0 基，映射前的位置）；
 *  - 写入 rerankScore（未映射到的候选为 null，排在已重排之后、保持相对稳定）。
 */
export function applyRerankOrdering(
  hits: RetrievalHitView[],
  result: RerankResult,
): RetrievalHitView[] {
  if (hits.length === 0) return hits;

  const byIndex = new Map<number, number>();
  for (const r of result.results) byIndex.set(r.index, r.relevanceScore);

  const mapped = hits.map((h, i): RetrievalHitView => ({
    ...h,
    originalRank: i,
    rerankScore: byIndex.get(i) ?? null,
  }));

  mapped.sort((a, b) => {
    // 重排分指纹：缺失(null/undefined)视为不参与排序，排在已重排命中之后
    const ra = a.rerankScore ?? null;
    const rb = b.rerankScore ?? null;
    if (ra === null && rb === null) return 0;
    if (ra === null) return 1;
    if (rb === null) return -1;
    return rb - ra;
  });
  return mapped;
}
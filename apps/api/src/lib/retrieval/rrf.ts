/**
 * RRF（Reciprocal Rank Fusion）—— 融合多路检索结果的纯函数实现。
 *
 * 算法：对每个命中项，累加其在各路线中的「倒数排名分贡献」：
 *   score(item) = Σ_retriever 1 / (k + rank(item, retriever))
 * 其中 rank 从 1 开始，k 为平滑常数（默认 60，越大越偏向「多路都命中」的去重合并）。
 *
 * RRF 不需要跨路分数归一化，天然消解不同检索器（向量余弦 / 关键词相似度）
 * 量纲不一致的问题，只依赖相对次序，因此非常适合混合检索。
 */
export interface RankedHit {
  id: string;
  score: number;
}

export type RetrievalSink = 'vector' | 'keyword';

export interface RankedList {
  source: RetrievalSink;
  items: RankedHit[];
}

export interface FusedHit {
  id: string;
  /** RRF 融合分（越大越相关） */
  score: number;
  /** 命中该条目的检索路线 */
  sources: RetrievalSink[];
  /** 是否被多路同时召回 */
  hybrid: boolean;
}

export function rrfFusion(lists: RankedList[], k = 60): FusedHit[] {
  const acc = new Map<
    string,
    { score: number; sources: RetrievalSink[] }
  >();

  for (const list of lists) {
    // rank 从 1 开始
    const contributedId = new Set<string>();
    for (let i = 0; i < list.items.length; i++) {
      const item = list.items[i]!;
      if (contributedId.has(item.id)) continue; // 同路内去重
      contributedId.add(item.id);
      const rank = i + 1;
      const contrib = 1 / (k + rank);
      const rec = acc.get(item.id);
      if (rec) {
        rec.score += contrib;
        if (!rec.sources.includes(list.source)) rec.sources.push(list.source);
      } else {
        acc.set(item.id, { score: contrib, sources: [list.source] });
      }
    }
  }

  const fused = Array.from(acc.entries()).map(([id, rec]) => ({
    id,
    score: rec.score,
    sources: rec.sources,
    hybrid: rec.sources.length > 1,
  }));

  fused.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    // 稳定次序：多路命中优先
    return Number(b.hybrid) - Number(a.hybrid);
  });

  return fused;
}
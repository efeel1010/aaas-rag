/**
 * 混合检索（Hybrid Retrieval）—— RAG 检索核心。
 *
 * 同时跑两路检索并做 RRF（Reciprocal Rank Fusion）融合：
 *  - (a) 向量路：pgvector 余弦相似度 top-K（`embedding <=> query`）；
 *  - (b) 关键词路：pg_trgm `similarity` + PostgreSQL 全文 `tsvector @@ websearch_to_tsquery`
 *        （对中文/英文都有效，trigram 子串匹配对中文尤为适用）。
 *
 * 两路各取 topK*POOL_FACTOR 候选，RRF 按「倒数排名」融合去重，最终返回 topK。
 * 命中来源标记为 vector / keyword / hybrid（两路同时召回）。
 *
 * 可选重排：传入 rerankModelId 时，RRF 取 topK*3 候选 → rerank 模型重排 → 再取 topK。
 */
import { sql } from 'drizzle-orm';
import type { RetrievalHitView, RetrievalRequest, RetrievalResult } from '@pulse/contracts';
import { getDb } from '../lib/db.js';
import { ConflictError } from '../lib/errors.js';
import { fakeEmbedding, isMockEmbedding, vectorLiteral } from '../lib/retrieval/vector.js';
import { embedTexts } from '../lib/ingest/embedding.js';
import { rrfFusion } from '../lib/retrieval/rrf.js';
import { rerankHits } from '../lib/retrieval/rerank.js';
import { datasetStore } from './dataset-store.js';

/** 候选池倍数：每路召回 topK 的若干倍再融合，兼顾召回率与效率 */
const POOL_FACTOR = 3;

interface BranchRow {
  id: string;
  document_id: string;
  dataset_id: string;
  content: string;
  tokens: number;
  metadata: Record<string, unknown> | null;
  score: number;
}

function toBranchRow(rows: Record<string, unknown>[], scoreKey: string): BranchRow[] {
  return rows.map((r) => ({
    id: String(r.id),
    document_id: String(r.document_id),
    dataset_id: String(r.dataset_id),
    content: String(r.content),
    tokens: Number(r.tokens ?? 0),
    metadata: (r.metadata as Record<string, unknown> | null) ?? null,
    score: Number(r[scoreKey] ?? 0),
  }));
}

/**
 * 将 uuid 数组渲染为 Postgres 数组字面量字符串 `{id1,id2,..}`（用于 `= ANY(...::uuid[])`）。
 * 返回纯字符串，drizzle 会将其作为单个绑定参数（`$n = '{...}'`）参与查询；
 * 不能使用 sql.raw（drizzle 会加括号导致语法错误），也不能直接传 JS 数组
 * （drizzle 会把数组展开成多个参数，导致 `malformed array literal`）。
 * datasetIds 已由 zod uuid schema 校验，uuid 仅含 hex 与短横线，拼接无注入风险。
 */
function arrayLiteral(ids: string[]): string {
  return `{${ids.join(',')}}`;
}

/** 生成查询向量（mock 用假向量；真实模式取首个知识库的 embedding 模型） */
async function queryVector(datasetIds: string[], query: string): Promise<number[]> {
  if (isMockEmbedding()) return fakeEmbedding(query);
  const firstId = datasetIds[0];
  if (!firstId) throw new ConflictError('datasetIds 不能为空');
  const ds = await datasetStore.find(firstId);
  if (!ds.embeddingModelId) {
    throw new ConflictError(`知识库「${ds.name}」未绑定 embedding 模型，无法进行向量检索`);
  }
  const [v] = await embedTexts(ds.embeddingModelId, [query]);
  return v!;
}

async function vectorBranch(
  datasetIds: string[],
  queryVector: number[],
  limit: number,
): Promise<BranchRow[]> {
  const res = await getDb().execute(sql`
    SELECT ch.id,
           ch.document_id,
           ch.dataset_id,
           ch.content,
           ch.tokens,
           ch.metadata,
           (1 - (ch.embedding <=> ${vectorLiteral(queryVector)}::vector)) AS sim
    FROM dataset_chunks ch
    WHERE ch.dataset_id = ANY(${arrayLiteral(datasetIds)}::uuid[])
      AND ch.embedding IS NOT NULL
    ORDER BY ch.embedding <=> ${vectorLiteral(queryVector)}::vector ASC
    LIMIT ${limit}
  `);
  return toBranchRow(res.rows, 'sim');
}

async function keywordBranch(datasetIds: string[], query: string, limit: number): Promise<BranchRow[]> {
  const res = await getDb().execute(sql`
    SELECT ch.id,
           ch.document_id,
           ch.dataset_id,
           ch.content,
           ch.tokens,
           ch.metadata,
           GREATEST(
             similarity(ch.content, ${query}),
             ts_rank_cd(to_tsvector('simple', ch.content), websearch_to_tsquery('simple', ${query}))
           ) AS kw
    FROM dataset_chunks ch
    WHERE ch.dataset_id = ANY(${arrayLiteral(datasetIds)}::uuid[])
      AND (
        similarity(ch.content, ${query}) > 0.05
        OR to_tsvector('simple', ch.content) @@ websearch_to_tsquery('simple', ${query})
      )
    ORDER BY kw DESC
    LIMIT ${limit}
  `);
  return toBranchRow(res.rows, 'kw');
}

/**
 * 混合检索主入口。返回经 RRF 融合后的 topK 命中。
 */
export async function hybridRetrieve(input: RetrievalRequest): Promise<RetrievalResult> {
  const { query, datasetIds, topK, rffK, rerankModelId } = input;
  const pool = Math.max(topK, topK * POOL_FACTOR);

  const qVec = await queryVector(datasetIds, query);
  const [vecRows, kwRows] = await Promise.all([
    vectorBranch(datasetIds, qVec, pool),
    keywordBranch(datasetIds, query, pool),
  ]);

  // 未重排时直接取 topK；需重排时先取足 topK*3 候选交 rerank，再取 topK
  const fused = rrfFusion(
    [
      { source: 'vector', items: vecRows.map((r) => ({ id: r.id, score: r.score })) },
      { source: 'keyword', items: kwRows.map((r) => ({ id: r.id, score: r.score })) },
    ],
    rffK,
  ).slice(0, rerankModelId ? pool : topK);

  // 按 id 聚合两路原始数据，用于组装命中详情与来源
  const byId = new Map<string, BranchRow>();
  for (const r of vecRows) byId.set(r.id, r);
  for (const r of kwRows) if (!byId.has(r.id)) byId.set(r.id, r);

  const assembled: RetrievalHitView[] = fused.map((f) => {
    const row = byId.get(f.id);
    const vec = vecRows.find((r) => r.id === f.id);
    const kw = kwRows.find((r) => r.id === f.id);
    const source: RetrievalHitView['source'] = f.hybrid ? 'hybrid' : vec ? 'vector' : 'keyword';
    return {
      chunkId: f.id,
      documentId: row?.document_id ?? '',
      datasetId: row?.dataset_id ?? '',
      content: row?.content ?? '',
      tokens: row?.tokens ?? 0,
      metadata: row?.metadata ?? null,
      score: f.score,
      vectorScore: vec?.score ?? null,
      keywordScore: kw?.score ?? null,
      source,
    };
  });

  const hits = rerankModelId
    ? (await rerankHits({ hits: assembled, query, rerankModelId })).slice(0, topK)
    : assembled;

  return { query, datasetIds, topK, total: hits.length, hits };
}

/**
 * Query Preview：面向调试/预览，限定单个知识库，返回更短的召回片段。
 */
export async function retrievePreview(
  datasetId: string,
  query: string,
  topK: number,
): Promise<RetrievalResult> {
  return hybridRetrieve({ query, datasetIds: [datasetId], topK, rffK: 60 });
}
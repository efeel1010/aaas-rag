/**
 * M3 知识库（RAG 数据层）契约 —— datasets / documents / segments(chunks) / 混合检索。
 *
 * 覆盖知识库（dataset）、文档（document）、切片（segment/dataset_chunks）的读写，
 * 以及给上层 RAG 链路使用的混合检索（Hybrid Retrieval）请求/响应。
 */
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Dataset（知识库）
// ---------------------------------------------------------------------------

export const datasetStatusSchema = z.enum(['active', 'disabled']);
export type DatasetStatus = z.infer<typeof datasetStatusSchema>;

/** 切分策略：分隔符分段 / 递归字符窗口 / 滑动窗口 */
export const splitterTypeSchema = z.enum(['delimiter', 'recursive', 'sliding']);
export type SplitterType = z.infer<typeof splitterTypeSchema>;

export const createDatasetInputSchema = z.object({
  name: z.string().trim().min(1).max(128),
  description: z.string().max(512).optional(),
  /** 绑定 embedding 模型（须为 embedding 类型、active 状态） */
  embeddingModelId: z.string().uuid().optional(),
  icon: z.string().max(64).optional(),
  color: z.string().max(32).optional(),
  splitter: splitterTypeSchema.optional(),
  chunkSize: z.number().int().min(64).max(8192).optional(),
  chunkOverlap: z.number().int().min(0).max(4096).optional(),
  status: datasetStatusSchema.optional(),
});
export type CreateDatasetInput = z.infer<typeof createDatasetInputSchema>;

/** 局部更新；embeddingModelId 显式传 null 表示解绑 */
export const updateDatasetInputSchema = createDatasetInputSchema
  .partial()
  .extend({ embeddingModelId: z.string().uuid().nullable().optional() });
export type UpdateDatasetInput = z.infer<typeof updateDatasetInputSchema>;

export const datasetViewSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  description: z.string().nullable(),
  embeddingModelId: z.string().uuid().nullable(),
  embeddingModelName: z.string().nullable(),
  icon: z.string().nullable(),
  color: z.string().nullable(),
  docCount: z.number().int().nonnegative(),
  splitter: splitterTypeSchema,
  chunkSize: z.number().int(),
  chunkOverlap: z.number().int(),
  status: datasetStatusSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type DatasetView = z.infer<typeof datasetViewSchema>;

// ---------------------------------------------------------------------------
// Document（文档）—— 索引状态机：pending→parsing→splitting→indexing→success/failed
// ---------------------------------------------------------------------------

export const documentStatusSchema = z.enum([
  'pending',
  'parsing',
  'splitting',
  'indexing',
  'success',
  'failed',
]);
export type DocumentStatus = z.infer<typeof documentStatusSchema>;

export const documentViewSchema = z.object({
  id: z.string().uuid(),
  datasetId: z.string().uuid(),
  name: z.string(),
  status: documentStatusSchema,
  sourceType: z.string().nullable(),
  size: z.number().int().nonnegative(),
  tokens: z.number().int().nonnegative(),
  metadata: z.record(z.string(), z.unknown()).nullable(),
  error: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type DocumentView = z.infer<typeof documentViewSchema>;

// ---------------------------------------------------------------------------
// Segment（切片 / dataset_chunks）
// ---------------------------------------------------------------------------

export const segmentViewSchema = z.object({
  id: z.string().uuid(),
  datasetId: z.string().uuid(),
  documentId: z.string().uuid(),
  content: z.string(),
  tokens: z.number().int().nonnegative(),
  metadata: z.record(z.string(), z.unknown()).nullable(),
  createdAt: z.string(),
});
export type SegmentView = z.infer<typeof segmentViewSchema>;

/** 更新切片文本：改文本后需重新向量化 */
export const segmentUpdateInputSchema = z.object({
  content: z.string().trim().min(1).max(64 * 1024),
});
export type SegmentUpdateInput = z.infer<typeof segmentUpdateInputSchema>;

// ---------------------------------------------------------------------------
// 混合检索（Hybrid Retrieval）：pgvector 余弦 + 关键词(tsvector/pg_trgm)，RRF 融合
// ---------------------------------------------------------------------------

export const retrievalRequestSchema = z.object({
  query: z.string().trim().min(1).max(2048),
  datasetIds: z.array(z.string().uuid()).min(1),
  topK: z.number().int().min(1).max(100).optional().default(10),
  /** RRF 常数 k，控制排序离散度（默认 60，越接近 60 越偏向合并） */
  rffK: z.number().int().min(1).max(100).optional().default(60),
  /**
   * 可选：绑定 rerank 模型后，RRF 取 topK*3 候选交给 rerank 重排，再取 topK。
   * 缺省不重排，直接返回 RRF 结果（平滑回退）。
   */
  rerankModelId: z.string().uuid().nullish(),
});
export type RetrievalRequest = z.infer<typeof retrievalRequestSchema>;

export const retrievalHitViewSchema = z.object({
  chunkId: z.string().uuid(),
  documentId: z.string().uuid(),
  datasetId: z.string().uuid(),
  content: z.string(),
  tokens: z.number().int().nonnegative(),
  metadata: z.record(z.string(), z.unknown()).nullable(),
  /** RRF 融合后的相关分（得分越高越相关） */
  score: z.number(),
  /** 向量余弦相似度（命中该路时有值，否则 null） */
  vectorScore: z.number().nullable(),
  /** 关键词相似度（命中该路时有值，否则 null） */
  keywordScore: z.number().nullable(),
  /** 命中来源：两路都命中为 hybrid */
  source: z.enum(['vector', 'keyword', 'hybrid']),
  /** 经 rerank 模型重排后的相关分（未重排时为 null） */
  rerankScore: z.number().nullable().optional(),
  /** 重排前在召回候选中的排名（0 基；未重排时为 null） */
  originalRank: z.number().int().nonnegative().nullable().optional(),
});
export type RetrievalHitView = z.infer<typeof retrievalHitViewSchema>;

export const retrievalResultSchema = z.object({
  query: z.string(),
  datasetIds: z.array(z.string().uuid()),
  topK: z.number().int(),
  total: z.number().int().nonnegative(),
  hits: z.array(retrievalHitViewSchema),
});
export type RetrievalResult = z.infer<typeof retrievalResultSchema>;

/** Query Preview 参数：给定知识库 + 查询，预览将被召回的内容 */
export const queryPreviewRequestSchema = z.object({
  query: z.string().trim().min(1).max(2048),
  topK: z.number().int().min(1).max(50).optional().default(5),
});
export type QueryPreviewRequest = z.infer<typeof queryPreviewRequestSchema>;

/**
 * 单知识库检索请求体：`datasetIds` 可选，缺省即以该知识库为检索范围。
 * 允许多知识库合并检索（跨库融合）。
 */
export const datasetRetrieveBodySchema = z.object({
  query: z.string().trim().min(1).max(2048),
  datasetIds: z.array(z.string().uuid()).optional(),
  topK: z.number().int().min(1).max(100).optional(),
  rffK: z.number().int().min(1).max(100).optional(),
  rerankModelId: z.string().uuid().nullish(),
});
export type DatasetRetrieveBody = z.infer<typeof datasetRetrieveBodySchema>;
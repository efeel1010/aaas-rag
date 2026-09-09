/**
 * 向量化（Embedding 生成）—— ingest 入库与检索共用的 embedding 路径。
 *
 *  - MOCK_MODELS=true 或 MOCK_INGEST=true：使用确定性假向量（hash→单位向量，下标 1536），
 *    无外网也可跑通「入库 + 向量/混合检索」全链路，保证行为可复现、可断言。
 *  - 否则：解析 dataset 绑定的 embedding 模型，经模型网关 `lib/models.embed` 生成真实向量。
 *
 * 注意：真实模型返回的维度必须等于向量列的 `vector(1536)` 维度（OpenAI text-embedding-ada-002
 * 为 1536 一致）；若模型维度不一致，入库会 cast 失败，文档索引会被标记为 failed 并在 error 中说明。
 */
import type { EmbeddingRequest } from '@pulse/contracts';
import { embed } from '../models/index.js';
import { getRunnableModel } from '../../services/model-store.js';
import { ConflictError } from './../errors.js';

/** 向量列固定维度（与 schema DATASET_DIMENSIONS 对齐；2026-09-09 迁移为 1024 适配 qwen3.7-text-embedding-flash） */
export const VECTOR_DIMENSIONS = 1024;

/** DashScope 等兼容端点单次 embedding 请求允许的最大批大小（超限返回 400） */
const EMBED_BATCH_SIZE = 20;

/** 是否走本地假向量（无外网可测） */
export function isMockEmbedding(): boolean {
  return process.env.MOCK_MODELS === 'true' || process.env.MOCK_INGEST === 'true';
}

/** 由字符串生成确定性的 归一化单位向量（模拟真实 embedding，供断言与离线跑通） */
export function fakeEmbedding(text: string, dimensions = VECTOR_DIMENSIONS): number[] {
  const vec = new Array<number>(dimensions);
  const seedBase = hashString(text);
  for (let i = 0; i < dimensions; i++) {
    const v = seedBase + i * 2654435761;
    // 双哈希做伪随机均匀分布
    const a = Math.sin(v & 0xffffffff) * 10000;
    vec[i] = a - Math.floor(a);
  }
  return normalize(vec);
}

function normalize(vec: number[]): number[] {
  let sum = 0;
  for (const v of vec) sum += v * v;
  const norm = Math.sqrt(sum) || 1;
  return vec.map((v) => v / norm);
}

/** FNV-1a 64 位哈希 → 32 位种子（确定性） */
function hashString(text: string): number {
  let h0 = 0x811c9dc5;
  let h1 = 0x01000193;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h0 ^= c;
    h0 = Math.imul(h0, 0x01000193);
    h1 = Math.imul(h1 ^ c, 0x01000193);
  }
  return h0 ^ Math.imul(h1, 0x9e3779b1);
}

/**
 * 批量生成向量。
 * - mock 模式：直接用 `fakeEmbedding`，不触网、不校验模型维度。
 * - 真实模式：走模型网关，校验 embedding 类型并返回上游 embedding。
 */
export async function embedTexts(
  modelId: string,
  texts: string[],
): Promise<number[][]> {
  if (isMockEmbedding()) {
    return texts.map((t) => fakeEmbedding(t));
  }
  const { provider, model } = await getRunnableModel(modelId);
  if (model.modelType !== 'embedding') {
    throw new ConflictError(`模型「${model.name}」不是 embedding 类型，无法生成向量`);
  }
  // 分批生成：DashScope 等端点对单次请求 input 数量有上限（如 20），超限会 400。
  const embeddings: number[][] = [];
  for (let i = 0; i < texts.length; i += EMBED_BATCH_SIZE) {
    const batch = texts.slice(i, i + EMBED_BATCH_SIZE);
    const request: EmbeddingRequest = { modelId, input: batch };
    const result = await embed(provider, model, request);
    embeddings.push(...result.embeddings);
  }
  return embeddings;
}

/** 检索用：给查询文本生成单个查询向量（与入库同路径，保证可比） */
export async function embedQuery(modelId: string, query: string): Promise<number[]> {
  const [v] = await embedTexts(modelId, [query]);
  return v!;
}
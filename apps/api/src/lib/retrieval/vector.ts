/**
 * 检索向量辅助 —— pgvector 文本字面量 + 复用 ingest 的假向量/环境判定。
 */
export { fakeEmbedding, isMockEmbedding } from '../ingest/embedding.js';

/** 把 number[] 向量渲染为 pgvector 文本字面量 `[1,2,3]` */
export function vectorLiteral(v: number[]): string {
  return `[${v.join(',')}]`;
}
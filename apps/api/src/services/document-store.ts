/**
 * Document 存储服务 —— 文档上传 / 索引状态机 / 切片（segment）读写。
 *
 * 文档状态机：pending → parsing → splitting → indexing → success | failed
 *  - 上传时执行「解析」抽取纯文本与元数据（状态经 parsing 后落回 pending）；
 *  - 触发索引时执行「切分 → 向量化 → 写入 dataset_chunks」（splitting → indexing → success/failed）。
 *
 * 切片修改文本后必须重新向量化（更新 embedding），避免向量/文本漂移。
 */
import { and, count, desc, eq, sql } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { datasetChunks, documents } from '@pulse/db';
import type { DocumentStatus, DocumentView, SegmentView, SegmentUpdateInput } from '@pulse/contracts';
import { getDb } from '../lib/db.js';
import { ConflictError, NotFoundError, ValidationError } from '../lib/errors.js';
import { splitText } from '../lib/ingest/splitter.js';
import { countTokens } from '../lib/ingest/tokens.js';
import { parser } from '../lib/ingest/parser.js';
import { embedTexts, isMockEmbedding, VECTOR_DIMENSIONS } from '../lib/ingest/embedding.js';
import { vectorLiteral } from '../lib/retrieval/vector.js';
import { datasetStore } from './dataset-store.js';

type DocumentRow = typeof documents.$inferSelect;
type ChunkRow = typeof datasetChunks.$inferSelect;

function toDocumentView(row: DocumentRow): DocumentView {
  return {
    id: row.id,
    datasetId: row.datasetId,
    name: row.name,
    status: row.status as DocumentStatus,
    sourceType: row.sourceType,
    size: row.size,
    tokens: row.tokens,
    metadata: row.metadata,
    error: row.error,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toSegmentView(row: ChunkRow): SegmentView {
  return {
    id: row.id,
    datasetId: row.datasetId,
    documentId: row.documentId,
    content: row.content,
    tokens: row.tokens,
    metadata: row.metadata,
    createdAt: row.createdAt.toISOString(),
  };
}

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

async function setStatus(documentId: string, status: DocumentStatus, error: string | null): Promise<void> {
  await getDb()
    .update(documents)
    .set({ status, error, updatedAt: new Date() })
    .where(eq(documents.id, documentId));
}

async function findDoc(datasetId: string, documentId: string): Promise<DocumentRow> {
  const rows = await getDb()
    .select()
    .from(documents)
    .where(and(eq(documents.id, documentId), eq(documents.datasetId, datasetId)))
    .limit(1);
  const row = rows[0];
  if (!row) throw new NotFoundError('文档', documentId);
  return row;
}

async function findChunk(datasetId: string, chunkId: string): Promise<ChunkRow> {
  const rows = await getDb()
    .select()
    .from(datasetChunks)
    .where(and(eq(datasetChunks.id, chunkId), eq(datasetChunks.datasetId, datasetId)))
    .limit(1);
  const row = rows[0];
  if (!row) throw new NotFoundError('切片', chunkId);
  return row;
}

async function insertChunk(
  datasetId: string,
  documentId: string,
  input: { content: string; tokens: number; contentHash: string; vector: number[]; metadata: Record<string, unknown> },
): Promise<void> {
  await getDb().execute(sql`
    INSERT INTO dataset_chunks
      (dataset_id, document_id, content, tokens, content_hash, embedding, metadata)
    VALUES
      (${datasetId}::uuid, ${documentId}::uuid, ${input.content}, ${input.tokens}, ${input.contentHash},
       ${vectorLiteral(input.vector)}::vector, ${JSON.stringify(input.metadata)}::jsonb)
  `);
}

export const documentStore = {
  async list(
    datasetId: string,
    opts: { page?: number; perPage?: number; documentId?: string },
  ): Promise<{ items: DocumentView[]; total: number }> {
    const page = opts.page ?? 1;
    const perPage = opts.perPage ?? 20;
    const where = eq(documents.datasetId, datasetId);
    const items = await getDb()
      .select()
      .from(documents)
      .where(where)
      .orderBy(desc(documents.createdAt))
      .limit(perPage)
      .offset((page - 1) * perPage);
    const totalRow = await getDb()
      .select({ total: count() })
      .from(documents)
      .where(where);
    return { items: items.map(toDocumentView), total: totalRow[0]?.total ?? 0 };
  },

  async get(datasetId: string, documentId: string): Promise<DocumentView> {
    return toDocumentView(await findDoc(datasetId, documentId));
  },

  /**
   * 上传文档：解析抽取纯文本与元数据 → 落库为 pending。
   * 解析失败会落库为 failed 并可见 error；二进制原文件不落库。
   */
  async upload(datasetId: string, filename: string, buffer: Buffer): Promise<DocumentView> {
    if (!filename || filename.trim().length === 0) {
      throw new ValidationError([{ path: ['filename'], message: '文件名不能为空' }], '文件名不能为空');
    }
    const sourceType = parser.typeOf(filename);
    if (!sourceType) {
      throw new ValidationError(
        [{ path: ['file'], message: `不支持的文件类型，支持 txt/md/pdf/docx/html/xlsx` }],
        '不支持的文件类型',
      );
    }
    await datasetStore.find(datasetId); // 确保知识库存在

    const created = await getDb()
      .insert(documents)
      .values({
        datasetId,
        name: filename,
        status: 'parsing',
        sourceType,
        size: buffer.length,
        content: null,
        metadata: {},
        tokens: 0,
        error: null,
      })
      .returning();
    let row = created[0]!;

    try {
      const parsed = await parser.parse(filename, buffer);
      const updated = await getDb()
        .update(documents)
        .set({
          content: parsed.text,
          metadata: parsed.metadata,
          tokens: countTokens(parsed.text),
          status: 'pending',
          error: null,
          updatedAt: new Date(),
        })
        .where(eq(documents.id, row.id))
        .returning();
      row = updated[0]!;
    } catch (err) {
      await setStatus(row.id, 'failed', err instanceof Error ? err.message : String(err));
      row = (await findDoc(datasetId, row.id))!;
    }
    // 文档入库（含 failed）都计入 docCount
    await datasetStore.adjustDocCount(datasetId, 1);
    return toDocumentView(row);
  },

  /** 触发索引：pending/success/failed 均可（重复执行幂等，先清旧切片） */
  async index(datasetId: string, documentId: string): Promise<DocumentView> {
    const doc = await findDoc(datasetId, documentId);
    if (doc.status === 'parsing' || doc.status === 'splitting' || doc.status === 'indexing') {
      throw new ConflictError('文档正在索引中，请稍后再试');
    }
    const ds = await datasetStore.find(datasetId);

    if (!ds.embeddingModelId && !isMockEmbedding()) {
      await setStatus(doc.id, 'failed', '该知识库未绑定 embedding 模型，无法索引');
      return toDocumentView(await findDoc(datasetId, documentId));
    }

    try {
      await setStatus(doc.id, 'splitting', null);
      const text = doc.content ?? '';
      if (!text.trim()) throw new Error('文档无可索引文本（可能为空或解析失败）');
      const chunks = splitText(text, {
        splitter: ds.splitter as 'delimiter' | 'recursive' | 'sliding',
        chunkSize: ds.chunkSize,
        overlap: ds.chunkOverlap,
      });
      if (chunks.length === 0) throw new Error('文本切分为空');

      await setStatus(doc.id, 'indexing', null);

      // 幂等：删除该文档既有切片
      await getDb().delete(datasetChunks).where(eq(datasetChunks.documentId, doc.id));

      const vectors = await embedTexts(ds.embeddingModelId ?? 'mock', chunks.map((c) => c.content));
      const dim = vectors[0]?.length ?? 0;
      if (dim !== VECTOR_DIMENSIONS) {
        throw new Error(
          `模型返回维度 ${dim} 与向量列 ${VECTOR_DIMENSIONS} 不一致，请更换 embedding 模型或重建向量列`,
        );
      }

      const totalTokens = chunks.reduce((n, c) => n + c.tokens, 0);
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i]!;
        const vector = vectors[i];
        if (!vector) throw new Error('向量生成不完整');
        await insertChunk(doc.datasetId, doc.id, {
          content: chunk.content,
          tokens: chunk.tokens,
          contentHash: sha256(chunk.content),
          vector,
          metadata: {
            documentName: doc.name,
            sourceType: doc.sourceType,
            index: i,
          },
        });
      }

      await getDb()
        .update(documents)
        .set({ status: 'success', error: null, tokens: totalTokens, updatedAt: new Date() })
        .where(eq(documents.id, doc.id));
      return toDocumentView(await findDoc(datasetId, doc.id));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await setStatus(doc.id, 'failed', message);
      return toDocumentView(await findDoc(datasetId, doc.id));
    }
  },

  async remove(datasetId: string, documentId: string): Promise<{ id: string }> {
    await findDoc(datasetId, documentId);
    await getDb().delete(documents).where(eq(documents.id, documentId)); // chunks cascade
    await datasetStore.adjustDocCount(datasetId, -1);
    return { id: documentId };
  },

  // -------------------------------------------------------------------------
  // Segments（切片 / dataset_chunks）
  // -------------------------------------------------------------------------

  async listChunks(
    datasetId: string,
    opts: { page?: number; perPage?: number; documentId?: string },
  ): Promise<{ items: SegmentView[]; total: number }> {
    const page = opts.page ?? 1;
    const perPage = opts.perPage ?? 20;
    const conds = [eq(datasetChunks.datasetId, datasetId)];
    if (opts.documentId) conds.push(eq(datasetChunks.documentId, opts.documentId));
    const where = and(...conds);
    const items = await getDb()
      .select()
      .from(datasetChunks)
      .where(where)
      .orderBy(desc(datasetChunks.createdAt))
      .limit(perPage)
      .offset((page - 1) * perPage);
    const totalRow = await getDb()
      .select({ total: count() })
      .from(datasetChunks)
      .where(where);
    return { items: items.map(toSegmentView), total: totalRow[0]?.total ?? 0 };
  },

  /** 更新切片文本：同时重新计算 token / contentHash / embedding（向量与文本保持一致） */
  async updateChunk(datasetId: string, chunkId: string, input: SegmentUpdateInput): Promise<SegmentView> {
    await findChunk(datasetId, chunkId); // 校验存在
    const ds = await datasetStore.find(datasetId);
    if (!ds.embeddingModelId && !isMockEmbedding()) {
      throw new ConflictError('该知识库未绑定 embedding 模型，无法重新向量化');
    }
    const content = input.content;
    const [vector] = await embedTexts(ds.embeddingModelId ?? 'mock', [content]);
    if (!vector || vector.length !== VECTOR_DIMENSIONS) {
      throw new ConflictError(
        `模型返回维度 ${vector?.length ?? 0} 与向量列 ${VECTOR_DIMENSIONS} 不一致`,
      );
    }
    const updated = await getDb()
      .update(datasetChunks)
      .set({
        content,
        tokens: countTokens(content),
        contentHash: sha256(content),
        embedding: sql`${vectorLiteral(vector)}::vector`,
      })
      .where(and(eq(datasetChunks.id, chunkId), eq(datasetChunks.datasetId, datasetId)))
      .returning();
    const row = updated[0];
    if (!row) throw new Error('更新切片失败');
    return toSegmentView(row);
  },

  async deleteChunk(datasetId: string, chunkId: string): Promise<{ id: string }> {
    await findChunk(datasetId, chunkId);
    await getDb()
      .delete(datasetChunks)
      .where(and(eq(datasetChunks.id, chunkId), eq(datasetChunks.datasetId, datasetId)));
    return { id: chunkId };
  },
};
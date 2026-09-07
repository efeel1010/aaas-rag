/**
 * datasets / documents / dataset_chunks —— RAG 知识库核心三表。
 * dataset_chunks 携带 pgvector 向量字段，用于向量检索。
 */
import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
  vector,
} from 'drizzle-orm/pg-core';
import { models } from './providers';

/**
 * 默认 embedding 维度。
 * 后续可通过 provider/model 配置化的 embedding 模型覆盖该维度。
 * 注意：pgvector 的维度在创建列时即固定，若更换 embedding 模型需重建向量列。
 */
export const DEFAULT_EMBEDDING_DIMENSIONS = 1536;

export const datasets = pgTable(
  'datasets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    description: text('description'),
    /** 该知识库使用的 embedding 模型 */
    embeddingModelId: uuid('embedding_model_id').references(() => models.id, {
      onDelete: 'set null',
    }),
    embeddingModelName: text('embedding_model_name'),
    icon: text('icon'),
    color: text('color'),
    docCount: integer('doc_count').notNull().default(0),
    /** 切分策略：delimiter | recursive | sliding */
    splitter: text('splitter').notNull().default('recursive'),
    /** 切分块目标长度（按字符估算） */
    chunkSize: integer('chunk_size').notNull().default(800),
    /** 相邻分块重叠字符数 */
    chunkOverlap: integer('chunk_overlap').notNull().default(200),
    status: text('status').notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('datasets_embedding_model_id_idx').on(table.embeddingModelId)],
);

export const documents = pgTable(
  'documents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    datasetId: uuid('dataset_id')
      .notNull()
      .references(() => datasets.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** pending | parsing | splitting | indexing | success | failed */
    status: text('status').notNull().default('pending'),
    sourceType: text('source_type'),
    size: integer('size').notNull().default(0),
    /** 解析后抽取的纯文本（供切分/入库；二进制原文件不落库） */
    content: text('content'),
    /** 解析出的原文元数据（页数、字数、标题、作者等） */
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),
    /** 全文 token 估算（统计用） */
    tokens: integer('tokens').notNull().default(0),
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('documents_dataset_id_idx').on(table.datasetId)],
);

export const datasetChunks = pgTable(
  'dataset_chunks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    datasetId: uuid('dataset_id')
      .notNull()
      .references(() => datasets.id, { onDelete: 'cascade' }),
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    content: text('content').notNull(),
    tokens: integer('tokens').notNull().default(0),
    /** 内容的指纹，用于增量去重 / 判重 */
    contentHash: text('content_hash'),
    /** pgvector 向量（默认 1536 维，可由 embedding 模型覆盖） */
    embedding: vector('embedding', { dimensions: DEFAULT_EMBEDDING_DIMENSIONS }),
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('dataset_chunks_dataset_id_idx').on(table.datasetId),
    index('dataset_chunks_document_id_idx').on(table.documentId),
    index('dataset_chunks_content_hash_idx').on(table.contentHash),
  ],
);

/**
 * 注意：pgvector 向量索引（HNSW / IVF）需在 vector 扩展就绪后手工创建，
 * 参考仓库根目录 docs/data-model.md 中的 SQL。
 *   CREATE INDEX dataset_chunks_embedding_hnsw_idx
 *     ON dataset_chunks USING hnsw (embedding vector_cosine_ops);
 */
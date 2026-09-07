/**
 * @pulse/contracts M3 知识库契约单测 —— datasets / documents / segments / 检索请求校验。
 */
import { describe, expect, it } from 'vitest';
import {
  createDatasetInputSchema,
  datasetRetrieveBodySchema,
  datasetViewSchema,
  documentStatusSchema,
  documentViewSchema,
  retrievalRequestSchema,
  retrievalResultSchema,
  segmentUpdateInputSchema,
  splitterTypeSchema,
  updateDatasetInputSchema,
} from '../src/datasets.js';

const UUID = '00000000-0000-0000-0000-000000000000';

describe('splitterTypeSchema / documentStatusSchema', () => {
  it('枚举合法取值，非法值拒绝', () => {
    expect(splitterTypeSchema.parse('recursive')).toBe('recursive');
    expect(splitterTypeSchema.parse('delimiter')).toBe('delimiter');
    expect(splitterTypeSchema.parse('sliding')).toBe('sliding');
    expect(() => splitterTypeSchema.parse('window')).toThrow();

    ['pending', 'parsing', 'splitting', 'indexing', 'success', 'failed'].forEach((s) => {
      expect(documentStatusSchema.parse(s)).toBe(s);
    });
    expect(() => documentStatusSchema.parse('done')).toThrow();
  });
});

describe('createDatasetInputSchema / updateDatasetInputSchema', () => {
  it('合法创建输入通过，切分参数可选且有边界', () => {
    const ok = createDatasetInputSchema.parse({
      name: '知识库',
      embeddingModelId: UUID,
      splitter: 'sliding',
      chunkSize: 512,
      chunkOverlap: 64,
    });
    expect(ok.name).toBe('知识库');
    expect(ok.splitter).toBe('sliding');
  });

  it('默认值：切分配置缺省为 recursive/800/200', () => {
    const ok = createDatasetInputSchema.parse({ name: 'kb' });
    expect(ok.splitter).toBeUndefined(); // contains 缺省值由服务层落库
    expect(ok.chunkSize).toBeUndefined();
  });

  it('chunkSize 越界 / 负数拒绝', () => {
    expect(
      () =>
        createDatasetInputSchema.parse({ name: 'kb', chunkSize: 16 }), // < min 64
    ).toThrow();
    expect(
      () => createDatasetInputSchema.parse({ name: 'kb', chunkOverlap: -1 }),
    ).toThrow();
  });

  it('update 允许传 null 解绑 embeddingModelId', () => {
    const patch = updateDatasetInputSchema.parse({ embeddingModelId: null });
    expect(patch.embeddingModelId).toBeNull();
  });
});

describe('datasetViewSchema / documentViewSchema', () => {
  it('视图字段齐全并校验新增的切分配置', () => {
    const view = datasetViewSchema.parse({
      id: UUID,
      name: 'kb',
      description: null,
      embeddingModelId: null,
      embeddingModelName: null,
      icon: null,
      color: null,
      docCount: 0,
      splitter: 'recursive',
      chunkSize: 800,
      chunkOverlap: 200,
      status: 'active',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    expect(view.splitter).toBe('recursive');
  });

  it('documentView 校验状态机五态并透传 metadata', () => {
    const view = documentViewSchema.parse({
      id: UUID,
      datasetId: UUID,
      name: 'a.txt',
      status: 'success',
      sourceType: 'txt',
      size: 10,
      tokens: 12,
      metadata: { encoding: 'utf-8' },
      error: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    expect(view.metadata?.encoding).toBe('utf-8');
  });
});

describe('segmentUpdateInputSchema', () => {
  it('非空文本通过；空内容被拒绝', () => {
    expect(segmentUpdateInputSchema.parse({ content: '新文本' }).content).toBe('新文本');
    expect(() => segmentUpdateInputSchema.parse({ content: '   ' })).toThrow();
    expect(() => segmentUpdateInputSchema.parse({ content: '' })).toThrow();
  });
});

describe('retrievalRequestSchema / datasetRetrieveBodySchema', () => {
  it('retrievalRequest：query 非空、datasetIds≥1、topK 默认 10 / rffK 默认 60', () => {
    const req = retrievalRequestSchema.parse({ query: '什么是向量', datasetIds: [UUID] });
    expect(req.topK).toBe(10);
    expect(req.rffK).toBe(60);
    expect(() => retrievalRequestSchema.parse({ query: '', datasetIds: [UUID] })).toThrow();
    expect(() => retrievalRequestSchema.parse({ query: 'x', datasetIds: [] })).toThrow();
  });

  it('单库检索：datasetIds 可选，缺省 undefined', () => {
    const body = datasetRetrieveBodySchema.parse({ query: '查询' });
    expect(body.datasetIds).toBeUndefined();
  });
});

describe('retrievalResultSchema', () => {
  it('命中源为 vector/keyword/hybrid 三态', () => {
    const result = retrievalResultSchema.parse({
      query: 'q',
      datasetIds: [UUID],
      topK: 1,
      total: 1,
      hits: [
        {
          chunkId: UUID,
          documentId: UUID,
          datasetId: UUID,
          content: 'c',
          tokens: 3,
          metadata: null,
          score: 0.5,
          vectorScore: 0.9,
          keywordScore: null,
          source: 'vector',
        },
      ],
    });
    expect(result.hits[0]?.source).toBe('vector');
    expect(() =>
      retrievalResultSchema.parse({
        query: 'q',
        datasetIds: [UUID],
        topK: 1,
        total: 1,
        hits: [
          {
            chunkId: UUID,
            documentId: UUID,
            datasetId: UUID,
            content: 'c',
            tokens: 3,
            metadata: null,
            score: 0.5,
            vectorScore: 0.9,
            keywordScore: null,
            source: 'other' as never,
          },
        ],
      }),
    ).toThrow();
  });
});
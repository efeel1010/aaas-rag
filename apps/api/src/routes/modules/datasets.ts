import { Hono } from 'hono';
import { z } from 'zod';
import {
  createDatasetInputSchema,
  datasetRetrieveBodySchema,
  segmentUpdateInputSchema,
  updateDatasetInputSchema,
} from '@pulse/contracts';
import { ok } from '../../lib/http.js';
import { parse } from '../../lib/parse.js';
import { ValidationError } from '../../lib/errors.js';
import { datasetStore } from '../../services/dataset-store.js';
import { documentStore } from '../../services/document-store.js';
import { hybridRetrieve, retrievePreview } from '../../services/retrieval-service.js';
import { requireExternalApi } from '../../middleware/api-gateway.js';
import type { AppEnv } from '../../types.js';

const uuidSchema = z.string().uuid();

/** 分页参数解析（查询串） */
function pageOptions(c: { req: { query(key: string): string | undefined } }): {
  page?: number;
  perPage?: number;
} {
  const opts: { page?: number; perPage?: number } = {};
  const page = c.req.query('page');
  if (page !== undefined) {
    const n = Number(page);
    if (!Number.isInteger(n) || n < 1) throw new ValidationError([{ path: ['page'], message: 'page 须为正整数' }]);
    opts.page = n;
  }
  const perPage = c.req.query('perPage');
  if (perPage !== undefined) {
    const n = Number(perPage);
    if (!Number.isInteger(n) || n < 1 || n > 200) {
      throw new ValidationError([{ path: ['perPage'], message: 'perPage 须为正整数且 ≤200' }]);
    }
    opts.perPage = n;
  }
  return opts;
}

const datasetIdParam = (c: { req: { param(key: string): string } }): string =>
  parse(uuidSchema, c.req.param('datasetId'));

/**
 * /api/v1/datasets —— 知识库 CRUD、文档上传与索引、切片管理、混合检索。
 */
export const datasetsRoutes = new Hono<AppEnv>()
  // ---------------- Dataset ----------------
  .get('/', async (c) => c.json(ok(await datasetStore.list())))
  .post('/', async (c) => {
    const input = parse(createDatasetInputSchema, await c.req.json());
    return c.json(ok(await datasetStore.create(input)));
  })
  .get('/:datasetId', async (c) => c.json(ok(await datasetStore.get(datasetIdParam(c)))))
  .patch('/:datasetId', async (c) => {
    const input = parse(updateDatasetInputSchema, await c.req.json());
    return c.json(ok(await datasetStore.update(datasetIdParam(c), input)));
  })
  .delete('/:datasetId', async (c) => c.json(ok(await datasetStore.remove(datasetIdParam(c)))))

  // ---------------- Documents ----------------
  .get('/:datasetId/documents', async (c) => {
    const datasetId = datasetIdParam(c);
    const pg = pageOptions(c);
    return c.json(ok(await documentStore.list(datasetId, { ...pg })));
  })
  .post('/:datasetId/documents', async (c) => {
    const datasetId = datasetIdParam(c);
    const form = await c.req.formData();
    const file = form.get('file');
    if (!file || typeof file === 'string' || !('arrayBuffer' in file)) {
      throw new ValidationError(
        [{ path: ['file'], message: '缺少 multipart 字段 file（二进制文件）' }],
        '缺少文件',
      );
    }
    const buffer = Buffer.from(await file.arrayBuffer());
    const doc = await documentStore.upload(datasetId, file.name, buffer);
    return c.json(ok(doc));
  })
  .get('/:datasetId/documents/:documentId', async (c) => {
    const documentId = parse(uuidSchema, c.req.param('documentId'));
    return c.json(ok(await documentStore.get(datasetIdParam(c), documentId)));
  })
  .post('/:datasetId/documents/:documentId/index', async (c) => {
    const documentId = parse(uuidSchema, c.req.param('documentId'));
    return c.json(ok(await documentStore.index(datasetIdParam(c), documentId)));
  })
  .delete('/:datasetId/documents/:documentId', async (c) => {
    const documentId = parse(uuidSchema, c.req.param('documentId'));
    return c.json(ok(await documentStore.remove(datasetIdParam(c), documentId)));
  })

  // ---------------- Segments（切片） ----------------
  .get('/:datasetId/segments', async (c) => {
    const datasetId = datasetIdParam(c);
    const pg = pageOptions(c);
    const documentId = c.req.query('documentId');
    const opts: { page?: number; perPage?: number; documentId?: string } = { ...pg };
    if (documentId !== undefined) opts.documentId = parse(uuidSchema, documentId);
    return c.json(ok(await documentStore.listChunks(datasetId, opts)));
  })
  .patch('/:datasetId/segments/:segmentId', async (c) => {
    const segmentId = parse(uuidSchema, c.req.param('segmentId'));
    const input = parse(segmentUpdateInputSchema, await c.req.json());
    return c.json(ok(await documentStore.updateChunk(datasetIdParam(c), segmentId, input)));
  })
  .delete('/:datasetId/segments/:segmentId', async (c) => {
    const segmentId = parse(uuidSchema, c.req.param('segmentId'));
    return c.json(ok(await documentStore.deleteChunk(datasetIdParam(c), segmentId)));
  })

  // ---------------- Hybrid Retrieval ----------------
  .post(
    '/:datasetId/retrieve',
    requireExternalApi({
      route: '/datasets/:id/retrieve',
      datasetFrom: { type: 'path', param: 'datasetId' },
      mergeBodyDatasetIds: true,
    }),
    async (c) => {
      const datasetId = datasetIdParam(c);
      const body = parse(datasetRetrieveBodySchema, await c.req.json());
      const result = await hybridRetrieve({
        query: body.query,
        datasetIds: body.datasetIds ?? [datasetId],
        topK: body.topK ?? 10,
        rffK: body.rffK ?? 60,
        rerankModelId: body.rerankModelId ?? null,
      });
      return c.json(ok(result));
    },
  )
  .get('/:datasetId/preview', async (c) => {
    const datasetId = datasetIdParam(c);
    const query = c.req.query('query') ?? '';
    const topK = Number(c.req.query('topK') ?? 5);
    return c.json(ok(await retrievePreview(datasetId, query.trim(), topK)));
  });
import { Hono } from 'hono';
import { z } from 'zod';
import {
  createModelInputSchema,
  updateModelInputSchema,
  embeddingRequestSchema,
  embeddingResultSchema,
} from '@pulse/contracts';
import { ok } from '../../lib/http.js';
import { parse } from '../../lib/parse.js';
import type { AppEnv } from '../../types.js';
import { modelStore, getRunnableModel } from '../../services/model-store.js';
import { embed } from '../../lib/models/index.js';
import { ConflictError } from '../../lib/errors.js';

const uuidSchema = z.string().uuid();

/**
 * /api/v1/models —— 模型注册 CRUD + embedding 调用端点。
 * 模型的「启停」通过 status 字段表达；网关调用会强制校验 active。
 */
export const modelsRoutes = new Hono<AppEnv>()
  .get('/', async (c) => {
    const providerId = c.req.query('providerId');
    const rows = providerId
      ? await modelStore.listByProvider(parse(uuidSchema, providerId))
      : await modelStore.list();
    return c.json(ok(rows));
  })
  .post('/', async (c) => {
    const input = parse(createModelInputSchema, await c.req.json());
    const created = await modelStore.create(input);
    return c.json(ok(created));
  })
  .get('/:id', async (c) => {
    const id = parse(uuidSchema, c.req.param('id'));
    return c.json(ok(await modelStore.get(id)));
  })
  .patch('/:id', async (c) => {
    const id = parse(uuidSchema, c.req.param('id'));
    const input = parse(updateModelInputSchema, await c.req.json());
    return c.json(ok(await modelStore.update(id, input)));
  })
  .delete('/:id', async (c) => {
    const id = parse(uuidSchema, c.req.param('id'));
    return c.json(ok(await modelStore.remove(id)));
  })
  // Embedding 调用端点：POST /models/:id/embed
  .post('/:id/embed', async (c) => {
    const id = parse(uuidSchema, c.req.param('id'));
    const input = parse(embeddingRequestSchema, await c.req.json());
    const { provider, model } = await getRunnableModel(id);
    if (model.modelType !== 'embedding') {
      throw new ConflictError(`模型「${model.name}」不是 embedding 类型，无法调用`);
    }
    const result = await embed(provider, model, input);
    return c.json(ok(embeddingResultSchema.parse(result)));
  });
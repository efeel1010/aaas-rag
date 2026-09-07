import { Hono } from 'hono';
import { z } from 'zod';
import {
  apiKeyCreatedSchema,
  apiKeyUsageSummarySchema,
  apiKeyViewSchema,
  createApiKeyInputSchema,
  setApiKeyStatusInputSchema,
} from '@pulse/contracts';
import { ok } from '../../lib/http.js';
import { parse } from '../../lib/parse.js';
import type { AppEnv } from '../../types.js';
import { apiKeyStore } from '../../services/api-key-store.js';

const uuidSchema = z.string().uuid();

/**
 * /api/v1/api-keys —— 开放 API 网关密钥管理（站内管理类路由，不要求 API Key，除非显式开启）。
 *
 * 安全约定：
 *  - POST 创建：明文密钥仅在 { data.key } 中返回一次，服务端只存哈希；
 *  - 其余任何查看（列表/详情）只暴露 prefix 混淆位，绝不返回明文；
 *  - GET /:id/usage：按日 + 按 endpoint 的用量聚合。
 */
export const apiKeysRoutes = new Hono<AppEnv>()
  .get('/', async (c) => c.json(ok(await apiKeyStore.list())))
  .post('/', async (c) => {
    const input = parse(createApiKeyInputSchema, await c.req.json());
    const created = await apiKeyStore.create(input);
    return c.json(ok(apiKeyCreatedSchema.parse(created)));
  })
  .patch('/:id/status', async (c) => {
    const id = parse(uuidSchema, c.req.param('id'));
    const { status } = parse(setApiKeyStatusInputSchema, await c.req.json());
    const updated = await apiKeyStore.setStatus(id, status);
    return c.json(ok(apiKeyViewSchema.parse(updated)));
  })
  .get('/:id/usage', async (c) => {
    const id = parse(uuidSchema, c.req.param('id'));
    const summary = await apiKeyStore.usageSummary(id);
    return c.json(ok(apiKeyUsageSummarySchema.parse(summary)));
  })
  .delete('/:id', async (c) => {
    const id = parse(uuidSchema, c.req.param('id'));
    return c.json(ok(await apiKeyStore.remove(id)));
  });
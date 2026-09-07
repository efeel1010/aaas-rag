import { Hono } from 'hono';
import { z } from 'zod';
import {
  createProviderInputSchema,
  updateProviderInputSchema,
  providerPingResultSchema,
} from '@pulse/contracts';
import { ok } from '../../lib/http.js';
import { parse } from '../../lib/parse.js';
import type { AppEnv } from '../../types.js';
import { providerStore, getRunnableProvider } from '../../services/provider-store.js';
import { modelStore, getRunnableModel } from '../../services/model-store.js';
import { pingProvider } from '../../lib/models/index.js';
import { ProviderError } from '../../lib/models/errors.js';
import { NotFoundError } from '../../lib/errors.js';

const uuidSchema = z.string().uuid();

/**
 * /api/v1/providers —— Provider（模型提供方）CRUD + 连通性测试。
 * 关键安全点：任何对外响应都会经过 providerStore.toView 完成凭据脱敏。
 */
export const providersRoutes = new Hono<AppEnv>()
  .get('/', async (c) => {
    const rows = await providerStore.list();
    // 附加模型数（一次聚合查询，避免 N+1）
    const withCount = await Promise.all(
      rows.map(async (row) => ({
        ...row,
        modelCount: await providerStore.modelCount(row.id),
      })),
    );
    return c.json(ok(withCount));
  })
  .post('/', async (c) => {
    const input = parse(createProviderInputSchema, await c.req.json());
    const created = await providerStore.create(input);
    return c.json(ok(created));
  })
  .get('/:id', async (c) => {
    const id = parse(uuidSchema, c.req.param('id'));
    const provider = await providerStore.get(id);
    const models = await modelStore.listByProvider(id);
    return c.json(ok({ ...provider, modelCount: models.length }));
  })
  .patch('/:id', async (c) => {
    const id = parse(uuidSchema, c.req.param('id'));
    const input = parse(updateProviderInputSchema, await c.req.json());
    const updated = await providerStore.update(id, input);
    return c.json(ok(updated));
  })
  .delete('/:id', async (c) => {
    const id = parse(uuidSchema, c.req.param('id'));
    return c.json(ok(await providerStore.remove(id)));
  })
  // 模型连通性测试：可选 body { modelId } 指定模型；缺省用 Provider 下首个启用的模型
  .post('/:id/ping', async (c) => {
    const id = parse(uuidSchema, c.req.param('id'));
    const body = await c.req.json().catch(() => ({}));
    const input = parse(
      z.object({ modelId: z.string().uuid().optional() }).optional(),
      body,
    );
    const provider = await providerStore.get(id);
    if (!provider.hasCredentials) {
      throw new ProviderError(`Provider「${provider.name}」未配置凭据，无法测试连通性`);
    }

    const runnable = await getRunnableProvider(id);
    if (!runnable) throw new NotFoundError('Provider', id);
    const model = input?.modelId
      ? (await getRunnableModel(input.modelId)).model
      : await defaultModel(id);

    const result = await pingProvider(runnable, model);
    const validated = providerPingResultSchema.parse(result);
    return c.json(ok(validated));
  });

/** 无 modelId 时，取 Provider 下第一个 active 模型；否则用缺省模型名探测 */
async function defaultModel(providerId: string) {
  const models = await modelStore.listByProvider(providerId);
  const first = models.find((m) => m.status === 'active');
  if (first) {
    return { id: first.id, name: first.name, modelType: first.modelType, config: first.config };
  }
  const provider = await providerStore.get(providerId);
  const defaultName = provider.config?.defaultModel as string | undefined;
  if (!defaultName) {
    throw new NotFoundError(
      'Provider 下无可用模型（可先创建模型或在 config.defaultModel 指定探测模型）',
      providerId,
    );
  }
  return { id: '', name: defaultName, modelType: 'llm' as const, config: provider.config };
}
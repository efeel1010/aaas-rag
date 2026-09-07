/**
 * Model 存储服务 —— models 表 CRUD + 可执行上下文装配（模型 + 解密后的 Provider）。
 */
import { eq } from 'drizzle-orm';
import { models, providers } from '@pulse/db';
import type {
  CreateModelInput,
  ModelTypeValue,
  ModelView,
  UpdateModelInput,
} from '@pulse/contracts';
import { getDb } from '../lib/db.js';
import { getRunnableProvider } from './provider-store.js';
import { ConflictError, NotFoundError } from '../lib/errors.js';
import type { ModelDescriptor, ProviderDescriptor } from '../lib/models/types.js';

type ModelRow = typeof models.$inferSelect;
/** create 需满足必填列 */
type ModelCreate = typeof models.$inferInsert;
/** update 支持局部更新 */
type ModelUpdate = Partial<typeof models.$inferInsert>;

function toView(row: ModelRow): ModelView {
  return {
    id: row.id,
    providerId: row.providerId,
    name: row.name,
    modelType: row.modelType as ModelTypeValue,
    config: row.config,
    status: row.status as 'active' | 'disabled',
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * 装配一次网关调用所需的全部上下文：模型 + 其所属 Provider（解密的）。
 * 任一端处于 disabled 都拒绝执行（保证「启停」语义生效）。
 */
export async function getRunnableModel(
  modelId: string,
): Promise<{ provider: ProviderDescriptor; model: ModelDescriptor }> {
  const row = await findRow(modelId);
  if (row.status !== 'active') {
    throw new ConflictError(`模型「${row.name}」已停用`);
  }
  const provider = await getRunnableProvider(row.providerId);
  if (!provider) throw new NotFoundError('Provider', row.providerId);
  if (!(await providerActive(row.providerId))) {
    throw new ConflictError(`模型所属 Provider 已停用`);
  }
  return {
    provider,
    model: {
      id: row.id,
      name: row.name,
      modelType: row.modelType as ModelTypeValue,
      config: row.config,
    },
  };
}

/**
 * 解析「主备模型链」：沿 model.config.fallbackModelId 链式解析 llm 模型，
 * 用于网关调用失败时的自动降级。主模型必须可用（不可用即抛错）；
 * 备用模型不可用（停用/Provider 停用/非 llm）时静默跳过。
 * 最多 3 层（主 + 2 备），并以 seen 集合防环。
 */
export async function getRunnableModelChain(
  modelId: string,
): Promise<Array<{ provider: ProviderDescriptor; model: ModelDescriptor }>> {
  const chain: Array<{ provider: ProviderDescriptor; model: ModelDescriptor }> = [];
  const seen = new Set<string>();
  let currentId: string | null = modelId;
  let isPrimary = true;
  while (currentId && !seen.has(currentId) && chain.length < 3) {
    seen.add(currentId);
    const entry = await resolveRunnableForChain(currentId, isPrimary);
    isPrimary = false;
    if (!entry) break;
    chain.push(entry);
    const fb = entry.model.config?.fallbackModelId;
    currentId = typeof fb === 'string' && fb.trim().length > 0 ? fb.trim() : null;
  }
  if (chain.length === 0) throw new NotFoundError('模型', modelId);
  return chain;
}

/** 链式解析的单环实现：strict=true（主模型）时不可用直接抛错；strict=false（备用）不可用返回 null */
async function resolveRunnableForChain(
  id: string,
  strict: boolean,
): Promise<{ provider: ProviderDescriptor; model: ModelDescriptor } | null> {
  const row = await findRow(id);
  if (row.status !== 'active' || row.modelType !== 'llm') {
    if (strict) throw new ConflictError(`模型「${row.name}」已停用或不是 llm 类型`);
    return null;
  }
  let provider: ProviderDescriptor | null;
  let providerOk = false;
  try {
    provider = await getRunnableProvider(row.providerId);
    providerOk = provider !== null && (await providerActive(row.providerId));
  } catch {
    // 备用模型所属 Provider 数据损坏/凭据无法解密 → 视为不可用
    provider = null;
    providerOk = false;
  }
  if (!providerOk) {
    if (strict) throw new NotFoundError('Provider', row.providerId);
    return null;
  }
  return {
    provider: provider!,
    model: {
      id: row.id,
      name: row.name,
      modelType: 'llm' as ModelTypeValue,
      config: row.config,
    },
  };
}

async function providerActive(id: string): Promise<boolean> {
  const rows = await getDb().select().from(providers).where(eq(providers.id, id)).limit(1);
  const row = rows[0];
  if (!row) return false;
  return row.status === 'active';
}

async function findRow(id: string): Promise<ModelRow> {
  const rows = await getDb().select().from(models).where(eq(models.id, id)).limit(1);
  const row = rows[0];
  if (!row) throw new NotFoundError('模型', id);
  return row;
}

export const modelStore = {
  async list(): Promise<ModelView[]> {
    const rows = await getDb().select().from(models).orderBy(models.createdAt);
    return rows.map(toView);
  },

  /** 按 provider 过滤列表 */
  async listByProvider(providerId: string): Promise<ModelView[]> {
    const rows = await getDb()
      .select()
      .from(models)
      .where(eq(models.providerId, providerId))
      .orderBy(models.createdAt);
    return rows.map(toView);
  },

  async get(id: string): Promise<ModelView> {
    return toView(await findRow(id));
  },

  async create(input: CreateModelInput): Promise<ModelView> {
    const provider = await getRunnableProvider(input.providerId);
    if (!provider) throw new NotFoundError('Provider', input.providerId);
    const insertData: ModelCreate = {
      providerId: input.providerId,
      name: input.name,
      modelType: input.modelType,
      config: input.config,
      status: input.status ?? 'active',
    };
    const inserted = await getDb().insert(models).values(insertData).returning();
    const row = inserted[0];
    if (!row) throw new Error('创建模型失败');
    return toView(row);
  },

  async update(id: string, patch: UpdateModelInput): Promise<ModelView> {
    await findRow(id);
    const data: ModelUpdate = {};
    if (patch.providerId !== undefined) data.providerId = patch.providerId;
    if (patch.name !== undefined) data.name = patch.name;
    if (patch.modelType !== undefined) data.modelType = patch.modelType;
    if (patch.config !== undefined) data.config = patch.config;
    if (patch.status !== undefined) data.status = patch.status;
    const updated = await getDb()
      .update(models)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(models.id, id))
      .returning();
    const row = updated[0];
    if (!row) throw new Error('更新模型失败');
    return toView(row);
  },

  async remove(id: string): Promise<{ id: string }> {
    await findRow(id);
    await getDb().delete(models).where(eq(models.id, id));
    return { id };
  },
};
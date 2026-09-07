/**
 * Provider 存储服务 —— providers 表 CRUD。
 * 凭据：写时逐字段加密落库，读时对外脱敏返回；仅 internal 方法解密供网关使用。
 */
import { eq, count } from 'drizzle-orm';
import { models, providers } from '@pulse/db';
import type {
  CreateProviderInput,
  ProviderTypeValue,
  ProviderView,
  UpdateProviderInput,
} from '@pulse/contracts';
import { getDb } from '../lib/db.js';
import {
  decryptCredentials,
  encryptCredentials,
  getRuntimeEncryptionKey,
  maskCredentials,
} from '../lib/models/crypto.js';
import type { ProviderDescriptor } from '../lib/models/types.js';
import { NotFoundError } from '../lib/errors.js';

type ProviderRow = typeof providers.$inferSelect;
/** create 需满足必填列 */
type ProviderCreate = typeof providers.$inferInsert;
/** update 支持局部更新 */
type ProviderUpdate = Partial<typeof providers.$inferInsert>;

/** 供网关内部使用：解密后的可执行上下文 */
export async function getRunnableProvider(id: string): Promise<ProviderDescriptor | null> {
  const rows = await getDb().select().from(providers).where(eq(providers.id, id)).limit(1);
  const row = rows[0];
  if (!row) return null;
  return decryptRow(row);
}

function decryptRow(row: ProviderRow): ProviderDescriptor {
  let credentials: Record<string, string | number | boolean> = {};
  if (row.credentials && Object.keys(row.credentials).length > 0) {
    try {
      credentials = decryptCredentials(row.credentials, getRuntimeEncryptionKey());
    } catch (err) {
      throw new Error(
        `Provider「${row.name}」凭据解密失败（密钥不匹配或数据损坏）: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
  return {
    id: row.id,
    type: row.type as ProviderTypeValue,
    name: row.name,
    config: row.config,
    credentials,
  };
}

function toView(row: ProviderRow): ProviderView {
  const masked = maskCredentials(row.credentials);
  return {
    id: row.id,
    type: row.type as ProviderTypeValue,
    name: row.name,
    description: row.description,
    config: row.config,
    credentials: masked.credentials,
    hasCredentials: masked.hasCredentials,
    status: row.status as 'active' | 'disabled',
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export const providerStore = {
  /** 列表（凭据脱敏） */
  async list(): Promise<ProviderView[]> {
    const rows = await getDb().select().from(providers).orderBy(providers.createdAt);
    return rows.map(toView);
  },

  async get(id: string): Promise<ProviderView> {
    const row = await this.findRow(id);
    return toView(row);
  },

  async create(input: CreateProviderInput): Promise<ProviderView> {
    const insertData: ProviderCreate = {
      type: input.type,
      name: input.name,
      description: input.description,
      config: input.config,
      credentials: input.credentials
        ? encryptCredentials(input.credentials, getRuntimeEncryptionKey())
        : undefined,
      status: input.status ?? 'active',
    };
    const inserted = await getDb().insert(providers).values(insertData).returning();
    const row = inserted[0];
    if (!row) throw new Error('创建 Provider 失败');
    return toView(row);
  },

  async update(id: string, patch: UpdateProviderInput): Promise<ProviderView> {
    await this.findRow(id); // 404 提前
    const data: ProviderUpdate = {};
    if (patch.name !== undefined) data.name = patch.name;
    if (patch.description !== undefined) data.description = patch.description;
    if (patch.type !== undefined) data.type = patch.type;
    if (patch.config !== undefined) data.config = patch.config;
    if (patch.status !== undefined) data.status = patch.status;
    // 仅当显式提供 credentials 时才重写入库（省略则保持原样）
    if (patch.credentials !== undefined) {
      data.credentials = encryptCredentials(patch.credentials, getRuntimeEncryptionKey());
    }
    const updated = await getDb()
      .update(providers)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(providers.id, id))
      .returning();
    const row = updated[0];
    if (!row) throw new Error('更新 Provider 失败');
    return toView(row);
  },

  async remove(id: string): Promise<{ id: string }> {
    await this.findRow(id);
    await getDb().delete(providers).where(eq(providers.id, id));
    return { id };
  },

  /** 统计某 provider 下的模型数 */
  async modelCount(id: string): Promise<number> {
    const rows = await getDb()
      .select({ total: count() })
      .from(models)
      .where(eq(models.providerId, id));
    return rows[0]?.total ?? 0;
  },

  async findRow(id: string): Promise<ProviderRow> {
    const rows = await getDb().select().from(providers).where(eq(providers.id, id)).limit(1);
    const row = rows[0];
    if (!row) throw new NotFoundError('Provider', id);
    return row;
  },
};
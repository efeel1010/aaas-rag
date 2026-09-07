/**
 * Dataset 存储服务 —— datasets CRUD 与「绑定 embedding 模型 / 切分配置」。
 */
import { eq } from 'drizzle-orm';
import { datasets, models } from '@pulse/db';
import type {
  CreateDatasetInput,
  DatasetStatus,
  DatasetView,
  SplitterType,
  UpdateDatasetInput,
} from '@pulse/contracts';
import { getDb } from '../lib/db.js';
import { ConflictError, NotFoundError } from '../lib/errors.js';

type DatasetRow = typeof datasets.$inferSelect;
type DatasetCreate = typeof datasets.$inferInsert;
type DatasetUpdate = Partial<typeof datasets.$inferInsert>;

function toView(row: DatasetRow): DatasetView {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    embeddingModelId: row.embeddingModelId,
    embeddingModelName: row.embeddingModelName,
    icon: row.icon,
    color: row.color,
    docCount: row.docCount,
    splitter: row.splitter as SplitterType,
    chunkSize: row.chunkSize,
    chunkOverlap: row.chunkOverlap,
    status: row.status as DatasetStatus,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * 校验可绑定的 embedding 模型：必须存在、类型为 embedding、状态 active。
 * 返回绑定所需信息（id 与展示名）。
 */
async function resolveEmbeddingModel(
  modelId: string,
): Promise<{ id: string; name: string }> {
  const rows = await getDb()
    .select({ id: models.id, name: models.name, modelType: models.modelType, status: models.status })
    .from(models)
    .where(eq(models.id, modelId))
    .limit(1);
  const model = rows[0];
  if (!model) throw new NotFoundError('模型', modelId);
  if (model.modelType !== 'embedding') {
    throw new ConflictError(`模型「${model.name}」不是 embedding 类型，无法作为知识库向量模型`);
  }
  if (model.status !== 'active') {
    throw new ConflictError(`模型「${model.name}」已停用，无法绑定`);
  }
  return { id: model.id, name: model.name };
}

async function findRow(id: string): Promise<DatasetRow> {
  const rows = await getDb().select().from(datasets).where(eq(datasets.id, id)).limit(1);
  const row = rows[0];
  if (!row) throw new NotFoundError('数据集', id);
  return row;
}

export const datasetStore = {
  async list(): Promise<DatasetView[]> {
    const rows = await getDb().select().from(datasets).orderBy(datasets.createdAt);
    return rows.map(toView);
  },

  async get(id: string): Promise<DatasetView> {
    return toView(await findRow(id));
  },

  /** 供内部检索使用：仅校验存在 */
  async find(id: string): Promise<DatasetRow> {
    return findRow(id);
  },

  async create(input: CreateDatasetInput): Promise<DatasetView> {
    const binding = input.embeddingModelId
      ? await resolveEmbeddingModel(input.embeddingModelId)
      : undefined;
    const data: DatasetCreate = {
      name: input.name,
      description: input.description,
      icon: input.icon,
      color: input.color,
      embeddingModelId: binding?.id,
      embeddingModelName: binding?.name,
      splitter: input.splitter ?? 'recursive',
      chunkSize: input.chunkSize ?? 800,
      chunkOverlap: input.chunkOverlap ?? 200,
      status: input.status ?? 'active',
    };
    const inserted = await getDb().insert(datasets).values(data).returning();
    const row = inserted[0];
    if (!row) throw new Error('创建数据集失败');
    return toView(row);
  },

  async update(id: string, patch: UpdateDatasetInput): Promise<DatasetView> {
    await findRow(id);
    const data: DatasetUpdate = {};
    if (patch.name !== undefined) data.name = patch.name;
    if (patch.description !== undefined) data.description = patch.description;
    if (patch.icon !== undefined) data.icon = patch.icon;
    if (patch.color !== undefined) data.color = patch.color;
    if (patch.splitter !== undefined) data.splitter = patch.splitter;
    if (patch.chunkSize !== undefined) data.chunkSize = patch.chunkSize;
    if (patch.chunkOverlap !== undefined) data.chunkOverlap = patch.chunkOverlap;
    if (patch.status !== undefined) data.status = patch.status;
    if (patch.embeddingModelId !== undefined) {
      if (patch.embeddingModelId === null) {
        // 解绑
        data.embeddingModelId = null;
        data.embeddingModelName = null;
      } else {
        const binding = await resolveEmbeddingModel(patch.embeddingModelId);
        data.embeddingModelId = binding.id;
        data.embeddingModelName = binding.name;
      }
    }
    const updated = await getDb()
      .update(datasets)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(datasets.id, id))
      .returning();
    const row = updated[0];
    if (!row) throw new Error('更新数据集失败');
    return toView(row);
  },

  async remove(id: string): Promise<{ id: string }> {
    await findRow(id);
    await getDb().delete(datasets).where(eq(datasets.id, id));
    return { id };
  },

  /** 文档数量：+delta（上传 +1 / 删除 -1） */
  async adjustDocCount(datasetId: string, delta: number): Promise<void> {
    const row = await findRow(datasetId);
    const next = Math.max(0, row.docCount + delta);
    await getDb()
      .update(datasets)
      .set({ docCount: next, updatedAt: new Date() })
      .where(eq(datasets.id, datasetId));
  },
};
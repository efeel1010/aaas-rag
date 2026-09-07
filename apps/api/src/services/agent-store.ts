/**
 * Agent 存储服务 —— agents / agent_datasets / intents / agent_intents 的 CRUD 与绑定维护。
 *
 * 绑定语义：
 *  - datasets / intents 均为「全量替换」：创建或更新时传入数组即整体覆盖（传 [] 清空）；
 *  - 意图支持两种维护方式：intentId 复用已存在意图（不修改其定义），
 *    或不提供 intentId 时按 name/description/examples 新建意图再绑定；
 *  - agent_datasets.weight 记录知识库关联权重（多库检索的相对重要度）。
 *
 * 校验：
 *  - 绑定的对话模型必须存在、为 llm 类型、active；
 *  - 绑定的知识库/被复用的意图必须存在。
 */
import { eq, inArray } from 'drizzle-orm';
import { agentDatasets, agentIntents, agents, datasets, intents, models } from '@pulse/db';
import type {
  AgentDatasetBinding,
  AgentDatasetView,
  AgentIntentInput,
  AgentIntentView,
  AgentStatus,
  AgentType,
  AgentView,
  CreateAgentInput,
  IntentStrategy,
  UpdateAgentInput,
} from '@pulse/contracts';
import { getDb } from '../lib/db.js';
import { ConflictError, NotFoundError } from '../lib/errors.js';
import { getRunnableModelChain } from './model-store.js';
import type { ModelDescriptor, ProviderDescriptor } from '../lib/models/types.js';
import type { IntentCandidate } from './intent-service.js';

type AgentRow = typeof agents.$inferSelect;
type AgentUpdate = Partial<typeof agents.$inferInsert>;

/** agent 关联查询展开形态（drizzle with relations 的结果） */
interface AgentJoined {
  id: string;
  name: string;
  description: string | null;
  systemPrompt: string | null;
  type: string;
  modelId: string | null;
  rerankModelId: string | null;
  /** 启用的工具名（绑定即切换 ReAct 工具循环编排） */
  tools: string[];
  status: string;
  createdAt: Date;
  updatedAt: Date;
  model: { id: string; name: string } | null;
  rerankModel: { id: string; name: string } | null;
  agentDatasets: {
    id: string;
    datasetId: string;
    weight: number;
    dataset: { id: string; name: string } | null;
  }[];
  agentIntents: {
    id: string;
    intentId: string;
    datasetId: string | null;
    priority: number;
    /** agent_intents.settings（jsonb）：workflow 策略时承载 workflowInputs 等运行时配置 */
    settings: Record<string, unknown> | null;
    intent: {
      id: string;
      name: string;
      description: string | null;
      examples: string[];
      strategy: string;
      responseTemplate: string | null;
      workflowId: string | null;
    } | null;
  }[];
}

/** Agent 运行时上下文（会话编排输入：模型 + 知识库 + 意图已装配） */
export interface AgentRuntimeContext {
  agentId: string;
  name: string;
  systemPrompt: string | null;
  modelId: string;
  /** 可选：Agent 绑定的 rerank 模型（重排检索结果）；未绑定为 null */
  rerankModelId: string | null;
  /** 启用的工具名（绑定非空即进入 ReAct 工具循环编排） */
  tools: string[];
  provider: ProviderDescriptor;
  model: ModelDescriptor;
  /** 主备模型链（主 + config.fallbackModelId 链式备用），网关调用失败自动降级 */
  modelChain: Array<{ provider: ProviderDescriptor; model: ModelDescriptor }>;
  datasets: AgentDatasetView[];
  intents: IntentCandidate[];
}

/**
 * 从 agent_intents.settings 读取 workflowInputs（约定键）。
 * 仅接受「普通对象」取值；取不到（null/undefined/非对象）返回 undefined。
 */
function readWorkflowInputs(
  settings: Record<string, unknown> | null | undefined,
): Record<string, unknown> | undefined {
  const value = settings?.workflowInputs;
  if (value === null || value === undefined) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function toView(row: AgentJoined): AgentView {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    systemPrompt: row.systemPrompt,
    type: row.type as AgentType,
    modelId: row.modelId,
    modelName: row.model?.name ?? null,
    rerankModelId: row.rerankModelId,
    rerankModelName: row.rerankModel?.name ?? null,
    status: row.status as AgentStatus,
    tools: row.tools ?? [],
    datasets: row.agentDatasets.map((ad): AgentDatasetView => ({
      datasetId: ad.datasetId,
      datasetName: ad.dataset?.name ?? null,
      weight: ad.weight,
    })),
    intents: row.agentIntents.map((ai): AgentIntentView => ({
      agentIntentId: ai.id,
      intentId: ai.intentId,
      name: ai.intent?.name ?? '',
      description: ai.intent?.description ?? null,
      examples: ai.intent?.examples ?? [],
      strategy: (ai.intent?.strategy ?? 'retrieval') as IntentStrategy,
      responseTemplate: ai.intent?.responseTemplate ?? null,
      workflowId: ai.intent?.workflowId ?? null,
      workflowInputs: readWorkflowInputs(ai.settings),
      datasetId: ai.datasetId,
      priority: ai.priority,
    })),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toIntentCandidate(ai: AgentJoined['agentIntents'][number]): IntentCandidate {
  return {
    intentId: ai.intentId,
    name: ai.intent?.name ?? '',
    description: ai.intent?.description ?? null,
    examples: ai.intent?.examples ?? [],
    strategy: (ai.intent?.strategy ?? 'retrieval') as IntentStrategy,
    responseTemplate: ai.intent?.responseTemplate ?? null,
    workflowId: ai.intent?.workflowId ?? null,
    workflowInputs: readWorkflowInputs(ai.settings),
    datasetId: ai.datasetId,
    priority: ai.priority,
  };
}

async function findRow(id: string): Promise<AgentRow> {
  const rows = await getDb().select().from(agents).where(eq(agents.id, id)).limit(1);
  const row = rows[0];
  if (!row) throw new NotFoundError('Agent', id);
  return row;
}

async function findJoined(id: string): Promise<AgentJoined> {
  const row = await getDb().query.agents.findFirst({
    where: eq(agents.id, id),
    with: {
      model: true,
      rerankModel: true,
      agentDatasets: { with: { dataset: true } },
      agentIntents: { with: { intent: true } },
    },
  });
  if (!row) throw new NotFoundError('Agent', id);
  return row as unknown as AgentJoined;
}

/** 校验可绑定模型：必须存在、llm 类型、active（与 dataset-store 绑定 embedding 模型同构） */
async function resolveLlmModel(modelId: string): Promise<{ id: string; name: string }> {
  const rows = await getDb()
    .select({
      id: models.id,
      name: models.name,
      modelType: models.modelType,
      status: models.status,
    })
    .from(models)
    .where(eq(models.id, modelId))
    .limit(1);
  const m = rows[0];
  if (!m) throw new NotFoundError('模型', modelId);
  if (m.modelType !== 'llm') {
    throw new ConflictError(`模型「${m.name}」不是 llm 类型，无法绑定为对话模型`);
  }
  if (m.status !== 'active') {
    throw new ConflictError(`模型「${m.name}」已停用，无法绑定`);
  }
  return { id: m.id, name: m.name };
}

/** 校验可绑定重排模型：必须存在、rerank 类型、active */
async function resolveRerankModel(modelId: string): Promise<{ id: string; name: string }> {
  const rows = await getDb()
    .select({
      id: models.id,
      name: models.name,
      modelType: models.modelType,
      status: models.status,
    })
    .from(models)
    .where(eq(models.id, modelId))
    .limit(1);
  const m = rows[0];
  if (!m) throw new NotFoundError('模型', modelId);
  if (m.modelType !== 'rerank') {
    throw new ConflictError(`模型「${m.name}」不是 rerank 类型，无法绑定为重排模型`);
  }
  if (m.status !== 'active') {
    throw new ConflictError(`模型「${m.name}」已停用，无法绑定`);
  }
  return { id: m.id, name: m.name };
}

async function validateDatasets(bindings: AgentDatasetBinding[]): Promise<void> {
  if (bindings.length === 0) return;
  const ids = bindings.map((b) => b.datasetId);
  const rows = await getDb()
    .select({ id: datasets.id })
    .from(datasets)
    .where(inArray(datasets.id, ids));
  const found = new Set(rows.map((r) => r.id));
  for (const b of bindings) {
    if (!found.has(b.datasetId)) throw new NotFoundError('数据集', b.datasetId);
  }
}

/** 全量替换 Agent 的知识库绑定 */
async function replaceDatasets(agentId: string, bindings: AgentDatasetBinding[]): Promise<void> {
  await getDb().delete(agentDatasets).where(eq(agentDatasets.agentId, agentId));
  if (bindings.length === 0) return;
  await getDb()
    .insert(agentDatasets)
    .values(bindings.map((b) => ({ agentId, datasetId: b.datasetId, weight: b.weight ?? 100 })));
}

/** 全量替换 Agent 的意图绑定（新建意图 / 复用意图两种方式） */
async function replaceIntents(agentId: string, inputs: AgentIntentInput[]): Promise<void> {
  await getDb().delete(agentIntents).where(eq(agentIntents.agentId, agentId));
  for (const item of inputs) {
    let intentId = item.intentId;
    if (intentId) {
      const rows = await getDb()
        .select({ id: intents.id })
        .from(intents)
        .where(eq(intents.id, intentId))
        .limit(1);
      if (!rows[0]) throw new NotFoundError('意图', intentId);
    } else {
      const created = await getDb()
        .insert(intents)
        .values({
          name: item.name,
          description: item.description,
          examples: item.examples ?? [],
          strategy: item.strategy ?? 'retrieval',
          responseTemplate: item.responseTemplate,
          workflowId: item.workflowId,
        })
        .returning();
      intentId = created[0]!.id;
    }
    // workflow 策略：把 workflowInputs 写入 agent_intents.settings（约定键），供运行时触发工作流时透传
    const settings =
      item.workflowInputs !== undefined ? { workflowInputs: item.workflowInputs } : undefined;
    await getDb()
      .insert(agentIntents)
      .values({
        agentId,
        intentId,
        datasetId: item.datasetId ?? null,
        priority: item.priority ?? 0,
        settings,
      });
  }
}

export const agentStore = {
  async list(): Promise<AgentView[]> {
    const rows = await getDb().query.agents.findMany({
      orderBy: (t, { asc }) => [asc(t.createdAt)],
      with: {
        model: true,
        rerankModel: true,
        agentDatasets: { with: { dataset: true } },
        agentIntents: { with: { intent: true } },
      },
    });
    return (rows as unknown as AgentJoined[]).map(toView);
  },

  async get(id: string): Promise<AgentView> {
    return toView(await findJoined(id));
  },

  async create(input: CreateAgentInput): Promise<AgentView> {
    const model = await resolveLlmModel(input.modelId);
    if (input.rerankModelId) await resolveRerankModel(input.rerankModelId);
    if (input.datasets) await validateDatasets(input.datasets);
    const inserted = await getDb()
      .insert(agents)
      .values({
        name: input.name,
        description: input.description,
        systemPrompt: input.systemPrompt,
        type: input.type ?? 'chat',
        modelId: model.id,
        rerankModelId: input.rerankModelId ?? null,
        tools: input.tools ?? [],
        status: input.status ?? 'active',
      })
      .returning();
    const row = inserted[0];
    if (!row) throw new Error('创建 Agent 失败');
    if (input.datasets) await replaceDatasets(row.id, input.datasets);
    if (input.intents) await replaceIntents(row.id, input.intents);
    return this.get(row.id);
  },

  async update(id: string, patch: UpdateAgentInput): Promise<AgentView> {
    await findRow(id);
    const data: AgentUpdate = {};
    if (patch.name !== undefined) data.name = patch.name;
    if (patch.description !== undefined) data.description = patch.description;
    if (patch.systemPrompt !== undefined) data.systemPrompt = patch.systemPrompt;
    if (patch.type !== undefined) data.type = patch.type;
    if (patch.status !== undefined) data.status = patch.status;
    if (patch.modelId !== undefined) {
      const model = await resolveLlmModel(patch.modelId);
      data.modelId = model.id;
    }
    if (patch.rerankModelId !== undefined) {
      if (patch.rerankModelId === null) {
        data.rerankModelId = null;
      } else {
        const rr = await resolveRerankModel(patch.rerankModelId);
        data.rerankModelId = rr.id;
      }
    }
    if (patch.tools !== undefined) data.tools = patch.tools;
    if (Object.keys(data).length > 0) {
      await getDb()
        .update(agents)
        .set({ ...data, updatedAt: new Date() })
        .where(eq(agents.id, id));
    }
    if (patch.datasets !== undefined) {
      await validateDatasets(patch.datasets);
      await replaceDatasets(id, patch.datasets);
    }
    if (patch.intents !== undefined) await replaceIntents(id, patch.intents);
    return this.get(id);
  },

  async remove(id: string): Promise<{ id: string }> {
    await findRow(id);
    // agent_datasets / agent_intents / conversations 由 FK cascade 清理
    await getDb().delete(agents).where(eq(agents.id, id));
    return { id };
  },

  /** 会话编排入口：装配可执行运行时上下文（模型 + 解密 provider + 知识库 + 意图） */
  async loadRuntime(agentId: string): Promise<AgentRuntimeContext> {
    const row = await findJoined(agentId);
    if (row.status !== 'active') {
      throw new ConflictError(`Agent「${row.name}」已停用，无法对话`);
    }
    if (!row.modelId) {
      throw new ConflictError(`Agent「${row.name}」未绑定对话模型，无法对话`);
    }
    const modelChain = await getRunnableModelChain(row.modelId);
    const datasets = row.agentDatasets
      .map((ad) => ({
        datasetId: ad.datasetId,
        datasetName: ad.dataset?.name ?? null,
        weight: ad.weight,
      }))
      .sort((a, b) => b.weight - a.weight);
    return {
      agentId: row.id,
      name: row.name,
      systemPrompt: row.systemPrompt,
      modelId: row.modelId,
      rerankModelId: row.rerankModelId,
      tools: row.tools ?? [],
      provider: modelChain[0]!.provider,
      model: modelChain[0]!.model,
      modelChain,
      datasets,
      intents: row.agentIntents.map(toIntentCandidate),
    };
  },
};

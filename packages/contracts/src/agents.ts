/**
 * M4 Agent（智能体编排层）契约 —— agents / agent_datasets / intents / agent_intents。
 *
 * Agent = 对话模型绑定（modelId）+ 系统提示词 + 知识库白名单（agent_datasets，含权重）
 *        + 意图集合（agent_intents，关联可复用意图 intents，可限定知识库子集）。
 *
 * 意图路由策略（intents.strategy）：
 *  - retrieval：命中后按 agent_intents.datasetId 子集检索，交给 LLM 生成（默认）；
 *  - direct    ：直接返回 responseTemplate 话术，不调用 LLM；
 *  - workflow  ：触发关联 workflowId（M5 起执行真实工作流，工作流输出作为本轮回复）；
 *  - fallback  ：未命中任何意图时的兜底意图。
 */
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Agent
// ---------------------------------------------------------------------------

export const agentStatusSchema = z.enum(['active', 'disabled']);
export type AgentStatus = z.infer<typeof agentStatusSchema>;

export const agentTypeSchema = z.enum(['chat', 'workflow', 'advanced']);
export type AgentType = z.infer<typeof agentTypeSchema>;

/**
 * Agent 启用的工具名（对运行时 ToolRegistry 注册的工具名）。
 * 绑定工具后，Agent 编排从「直线：意图→检索→LLM」切换为「ReAct 工具循环」：
 * 由 LLM 自主决定是否调用工具（含 local_retrieval 时会替代原固定检索分支）。
 * 值定义为非空字符串；具体可用性由运行时注册表校验（未注册/未启用的工具在装配时被过滤）。
 */
export const agentToolNameSchema = z.string().trim().min(1).max(64);
export type AgentToolName = z.infer<typeof agentToolNameSchema>;

/** 知识库绑定（agent_datasets）—— 全量替换语义 */
export const agentDatasetBindingSchema = z.object({
  datasetId: z.string().uuid(),
  /** 关联权重 1-1000，越高越优先（多库检索时相对重要度） */
  weight: z.number().int().min(1).max(1000).optional(),
});
export type AgentDatasetBinding = z.infer<typeof agentDatasetBindingSchema>;

// ---------------------------------------------------------------------------
// Intent
// ---------------------------------------------------------------------------

export const intentStrategySchema = z.enum(['retrieval', 'direct', 'workflow', 'fallback']);
export type IntentStrategy = z.infer<typeof intentStrategySchema>;

/**
 * 创建/更新 Agent 时维护的意图项：
 *  - 提供 intentId 表示复用已存在的通用意图（仅校验存在性，不修改其定义）；
 *  - 不提供 intentId 则按 name/description/examples 新建意图并绑定；
 *  - datasetId 为该意图在此 Agent 下的知识库子集（agent_intents.datasetId），
 *    命中该意图时优先检索该子集；缺省回退 Agent 全量知识库。
 */
export const agentIntentInputSchema = z.object({
  intentId: z.string().uuid().optional(),
  name: z.string().trim().min(1).max(128),
  description: z.string().max(512).optional(),
  examples: z.array(z.string().trim().min(1).max(512)).max(50).optional(),
  strategy: intentStrategySchema.optional(),
  responseTemplate: z.string().max(8192).optional(),
  workflowId: z.string().uuid().optional(),
  /**
   * workflow 策略下触发工作流时透传的额外输入参数（jsonb，随 agent_intents.settings 持久化）。
   *  - 固定值：如 { "step": 5 } 直接并入工作流输入；
   *  - 从用户 query 提取：值形如 { "$extract": "number" }，运行时从 query 解析步骤号，
   *    解析失败则省略该键（不传给工作流）。
   */
  workflowInputs: z.record(z.string(), z.unknown()).optional(),
  datasetId: z.string().uuid().nullable().optional(),
  priority: z.number().int().min(0).max(1000).optional(),
});
export type AgentIntentInput = z.infer<typeof agentIntentInputSchema>;

// ---------------------------------------------------------------------------
// Create / Update
// ---------------------------------------------------------------------------

export const createAgentInputSchema = z.object({
  name: z.string().trim().min(1).max(128),
  description: z.string().max(512).optional(),
  /** 系统提示词，Agent 编排时拼入首条 system 消息 */
  systemPrompt: z
    .string()
    .max(16 * 1024)
    .optional(),
  /** 绑定的对话模型（须为 llm 类型、active 状态） */
  modelId: z.string().uuid(),
  /** 可选：绑定的重排模型（须为 rerank 类型、active 状态）；绑定后 Agent 检索启用 rerank 重排 */
  rerankModelId: z.string().uuid().nullish(),
  type: agentTypeSchema.optional(),
  status: agentStatusSchema.optional(),
  /** 知识库白名单（全量替换语义） */
  datasets: z.array(agentDatasetBindingSchema).max(100).optional(),
  /** 意图集合（全量替换语义；含新建/复用两种方式） */
  intents: z.array(agentIntentInputSchema).max(100).optional(),
  /**
   * 启用的工具清单（对 ToolRegistry 注册的工具名，如 local_retrieval / http_request）。
   * 绑定即切换为 ReAct 工具循环编排；传 [] 或不传维持原直线编排（向后兼容）。
   */
  tools: z.array(agentToolNameSchema).max(20).optional(),
});
export type CreateAgentInput = z.infer<typeof createAgentInputSchema>;

/** 局部更新；datasets / intents 传数组时即为全量替换（传 [] 清空） */
export const updateAgentInputSchema = createAgentInputSchema
  .partial()
  .extend({ rerankModelId: z.string().uuid().nullable().optional() });
export type UpdateAgentInput = z.infer<typeof updateAgentInputSchema>;

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

export const agentDatasetViewSchema = z.object({
  datasetId: z.string().uuid(),
  datasetName: z.string().nullable(),
  weight: z.number().int(),
});
export type AgentDatasetView = z.infer<typeof agentDatasetViewSchema>;

export const agentIntentViewSchema = z.object({
  /** agent_intents 关联记录 id（更新/删除时定位） */
  agentIntentId: z.string().uuid(),
  intentId: z.string().uuid(),
  name: z.string(),
  description: z.string().nullable(),
  examples: z.array(z.string()),
  strategy: intentStrategySchema,
  responseTemplate: z.string().nullable(),
  workflowId: z.string().uuid().nullable(),
  /** workflow 策略下透传给工作流的额外输入参数（见 agentIntentInputSchema 说明） */
  workflowInputs: z.record(z.string(), z.unknown()).nullish(),
  /** 该意图在此 Agent 下的知识库子集 */
  datasetId: z.string().uuid().nullable(),
  priority: z.number().int(),
});
export type AgentIntentView = z.infer<typeof agentIntentViewSchema>;

export const agentViewSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  description: z.string().nullable(),
  systemPrompt: z.string().nullable(),
  type: agentTypeSchema,
  modelId: z.string().uuid().nullable(),
  modelName: z.string().nullable(),
  rerankModelId: z.string().uuid().nullable(),
  rerankModelName: z.string().nullable(),
  status: agentStatusSchema,
  datasets: z.array(agentDatasetViewSchema),
  intents: z.array(agentIntentViewSchema),
  /** 启用的工具名（未绑定工具默认为空数组） */
  tools: z.array(agentToolNameSchema).default([]),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type AgentView = z.infer<typeof agentViewSchema>;

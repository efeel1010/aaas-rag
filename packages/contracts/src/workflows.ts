/**
 * M5 工作流编排契约 —— workflows / workflow_nodes / workflow_edges / 运行。
 *
 * 工作流 = 一个有向无环图（DAG）：
 *  - start 节点声明输入字段（inputs），运行入参经其注入变量空间；
 *  - 各业务节点（llm / knowledge_retrieval / intent / condition / code /
 *    http_request / template）从「变量空间」读取并写入变量；
 *  - end 节点声明输出字段（outputs），把变量映射为对外返回结果；
 *  - edges 定义节点连线与分支条件：condition 节点在边上声明「条件」，
 *    intent 节点在边上声明「分支名 + 示例」。
 *
 * 节点/边/输入输出定义全部经 zod 严格校验（.strict() 拒绝未知字段），
 * 保证画布（M6）与引擎（M5）共用同一套可执行 schema。
 */
import { z } from 'zod';

// ---------------------------------------------------------------------------
// 基础枚举
// ---------------------------------------------------------------------------

/** 工作流生命周期：草稿 → 已发布 → 已归档 */
export const workflowStatusSchema = z.enum(['draft', 'published', 'archived']);
export type WorkflowStatus = z.infer<typeof workflowStatusSchema>;

/** 节点类型全集 */
export const workflowNodeTypeSchema = z.enum([
  'start',
  'llm',
  'knowledge_retrieval',
  'intent',
  'condition',
  'iteration',
  'code',
  'http_request',
  'template',
  'end',
]);
export type WorkflowNodeType = z.infer<typeof workflowNodeTypeSchema>;

/** 输入/输出字段值类型 */
export const workflowValueTypeSchema = z.enum([
  'string',
  'number',
  'boolean',
  'object',
  'array',
  'any',
]);
export type WorkflowValueType = z.infer<typeof workflowValueTypeSchema>;

/** 条件操作符（condition 节点 / 边条件） */
export const workflowConditionOperatorSchema = z.enum([
  'eq',
  'ne',
  'gt',
  'gte',
  'lt',
  'lte',
  'contains',
  'starts_with',
  'ends_with',
  'is_empty',
  'is_not_empty',
  'in',
  'not_in',
  'regex',
  'truthy',
  'falsy',
]);
export type WorkflowConditionOperator = z.infer<typeof workflowConditionOperatorSchema>;

// ---------------------------------------------------------------------------
// 输入 / 输出字段
// ---------------------------------------------------------------------------

/** start 节点的输入字段声明 */
export const workflowInputFieldSchema = z
  .object({
    name: z.string().trim().min(1).max(128),
    label: z.string().trim().min(1).max(128).optional(),
    type: workflowValueTypeSchema.default('string'),
    required: z.boolean().default(true),
    description: z.string().max(512).optional(),
    default: z.unknown().optional(),
  })
  .strict();
export type WorkflowInputField = z.infer<typeof workflowInputFieldSchema>;

/** end 节点的输出字段声明：把变量 from 映射为对外输出名 name */
export const workflowOutputFieldSchema = z
  .object({
    name: z.string().trim().min(1).max(128),
    from: z.string().trim().min(1).max(128),
    type: workflowValueTypeSchema.default('any'),
    description: z.string().max(512).optional(),
  })
  .strict();
export type WorkflowOutputField = z.infer<typeof workflowOutputFieldSchema>;

// ---------------------------------------------------------------------------
// 节点 data 配置（按 type 判别联合，严格校验）
// ---------------------------------------------------------------------------

const nodeCommon = {
  id: z.string().trim().min(1).max(128),
  name: z.string().trim().min(1).max(128).optional(),
  position: z
    .object({ x: z.number(), y: z.number() })
    .strict()
    .optional(),
};

/** start：声明输入字段，运行入参经其写入变量空间 */
const startNodeConfigSchema = z
  .object({
    inputs: z.array(workflowInputFieldSchema).max(200).default([]),
  })
  .strict();

/** llm：经项目模型网关（lib/models）或 LangChain ChatOpenAI 调用模型 */
const llmNodeConfigSchema = z
  .object({
    modelId: z.string().uuid(),
    system: z.string().max(16 * 1024).optional(),
    /** 变量模板，渲染后作为用户消息（支持 {{var}} / {{a.b}} / {{list[0]}}） */
    prompt: z.string().max(64 * 1024),
    temperature: z.number().min(0).max(2).optional(),
    maxTokens: z.number().int().positive().optional(),
    /** 输出变量名（写入生成文本） */
    output: z.string().trim().min(1).max(128).default('answer'),
    /**
     * 执行引擎：
     *  - gateway（默认）：走项目 lib/models 模型网关（支持 mock / 凭据解密 / 多 provider）；
     *  - langchain：经 @langchain/openai ChatOpenAI 执行（真实模式，需 provider 为 openai 系）。
     */
    engine: z.enum(['gateway', 'langchain']).default('gateway'),
  })
  .strict();

/** knowledge_retrieval：混合检索（M3 检索服务），输出 RetrievalResult */
const knowledgeRetrievalNodeConfigSchema = z
  .object({
    /** 固定知识库列表（datasetIds 与 datasetIdsVariable 二选一，后者优先） */
    datasetIds: z.array(z.string().uuid()).max(50).optional(),
    /** 从变量读取知识库 id 数组 */
    datasetIdsVariable: z.string().trim().min(1).max(128).optional(),
    /** 检索 query（变量模板） */
    query: z.string().trim().min(1).max(2048),
    topK: z.number().int().min(1).max(100).default(6),
    /** 可选：绑定 rerank 模型后，RRF 候选先经该模型重排再取 topK */
    rerankModelId: z.string().uuid().optional(),
    /** 输出变量名（写入 RetrievalResult 对象） */
    output: z.string().trim().min(1).max(128).default('retrieval'),
    /** 可选：另写入「知识上下文文本」（供 llm prompt 直接引用） */
    contextOutput: z.string().trim().min(1).max(128).optional(),
  })
  .strict();

/** intent：意图判断。分支在边上声明（condition.branch + examples），未命中走兜底边 */
const intentNodeConfigSchema = z
  .object({
    /** 待分类的查询来源变量（缺省 query） */
    queryVariable: z.string().trim().min(1).max(128).default('query'),
    /** 命中分支写入的变量名 */
    output: z.string().trim().min(1).max(128).default('intent'),
  })
  .strict();

/** condition：条件分支。各分支条件在边上声明（condition.variable + operator + value） */
const conditionNodeConfigSchema = z
  .object({
    /** 可选：把命中分支的意图/标签写入该变量（便于下游查看） */
    output: z.string().trim().min(1).max(128).optional(),
  })
  .strict();

/**
 * iteration：迭代。遍历数组变量，对每个元素渲染 bodyTemplate（支持 {{item}}、
 * {{item.field}}、{{index}}），逐项结果聚合为数组写入 output。
 */
const iterationNodeConfigSchema = z
  .object({
    /** 待遍历的数组变量路径（如 keywords / items / hits） */
    arrayVariable: z.string().trim().min(1).max(128),
    /** 当前元素写入的变量名（模板内以 {{item}} / {{item.x}} 引用） */
    itemVariable: z.string().trim().min(1).max(128).default('item'),
    /** 每项渲染的模板（支持 {{item}}、{{item.field}}、{{index}}） */
    bodyTemplate: z.string().max(64 * 1024),
    /** 聚合结果数组写入的变量名 */
    output: z.string().trim().min(1).max(128).default('results'),
  })
  .strict();

/** code：JS 代码（受控执行，node:vm 受限上下文，无 require/process/fetch/timers） */
const codeNodeConfigSchema = z
  .object({
    /** 函数体，签名 (ctx) => Partial<variables>，ctx = { variables, inputs } */
    code: z.string().min(1).max(32 * 1024),
    timeoutMs: z.number().int().min(10).max(10_000).default(3000),
  })
  .strict();

/** http_request：发 HTTP 请求（协议限 http/https） */
const httpRequestNodeConfigSchema = z
  .object({
    method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).default('GET'),
    /** URL（变量模板） */
    url: z.string().trim().min(1).max(2048),
    /** 请求头（值可为变量模板）；record 最多 50 项 */
    headers: z.record(z.string(), z.string()).refine((h) => Object.keys(h).length <= 50, '请求头最多 50 项').optional(),
    /** 请求体（变量模板，渲染后按 JSON 解析；非 JSON 字符串也可） */
    body: z.string().max(64 * 1024).optional(),
    timeoutMs: z.number().int().min(100).max(60_000).default(10_000),
    /** 输出变量名（写入 { status, data, headers }） */
    output: z.string().trim().min(1).max(128).default('http'),
  })
  .strict();

/** template：字符串模板渲染（{{var}}），输出到变量 */
const templateNodeConfigSchema = z
  .object({
    template: z.string().max(64 * 1024),
    output: z.string().trim().min(1).max(128).default('text'),
  })
  .strict();

/** end：输出字段声明（缺省时把全部变量作为输出） */
const endNodeConfigSchema = z
  .object({
    outputs: z.array(workflowOutputFieldSchema).max(200).default([]),
  })
  .strict();

/** 节点定义（创建/更新工作流时提交的节点列表项） */
export const workflowNodeInputSchema = z.discriminatedUnion('type', [
  z.object({ ...nodeCommon, type: z.literal('start'), data: startNodeConfigSchema }).strict(),
  z.object({ ...nodeCommon, type: z.literal('llm'), data: llmNodeConfigSchema }).strict(),
  z
    .object({ ...nodeCommon, type: z.literal('knowledge_retrieval'), data: knowledgeRetrievalNodeConfigSchema })
    .strict(),
  z.object({ ...nodeCommon, type: z.literal('intent'), data: intentNodeConfigSchema }).strict(),
  z.object({ ...nodeCommon, type: z.literal('condition'), data: conditionNodeConfigSchema }).strict(),
  z.object({ ...nodeCommon, type: z.literal('iteration'), data: iterationNodeConfigSchema }).strict(),
  z.object({ ...nodeCommon, type: z.literal('code'), data: codeNodeConfigSchema }).strict(),
  z.object({ ...nodeCommon, type: z.literal('http_request'), data: httpRequestNodeConfigSchema }).strict(),
  z.object({ ...nodeCommon, type: z.literal('template'), data: templateNodeConfigSchema }).strict(),
  z.object({ ...nodeCommon, type: z.literal('end'), data: endNodeConfigSchema }).strict(),
]);
export type WorkflowNodeInput = z.infer<typeof workflowNodeInputSchema>;

// ---------------------------------------------------------------------------
// 边与边条件
// ---------------------------------------------------------------------------

/**
 * 边条件：
 *  - condition 节点：variable + operator + value 组成「分支条件」，缺省整段 = 兜底/else 分支；
 *  - intent 节点：branch + examples 定义「分支名与示例问法」，缺省整段 = 兜底分支；
 *  - 其余节点忽略 condition。
 */
export const workflowEdgeConditionSchema = z
  .object({
    branch: z.string().trim().min(1).max(128).optional(),
    examples: z.array(z.string().trim().min(1).max(512)).max(50).optional(),
    variable: z.string().trim().min(1).max(128).optional(),
    operator: workflowConditionOperatorSchema.optional(),
    value: z.unknown().optional(),
  })
  .strict();
export type WorkflowEdgeCondition = z.infer<typeof workflowEdgeConditionSchema>;

/** 边定义（sourceHandle / targetHandle 供画布多端口使用，引擎按边顺序求值） */
export const workflowEdgeInputSchema = z
  .object({
    id: z.string().trim().min(1).max(128),
    sourceNodeId: z.string().trim().min(1).max(128),
    targetNodeId: z.string().trim().min(1).max(128),
    sourceHandle: z.string().trim().max(128).optional(),
    targetHandle: z.string().trim().max(128).optional(),
    condition: workflowEdgeConditionSchema.optional(),
  })
  .strict();
export type WorkflowEdgeInput = z.infer<typeof workflowEdgeInputSchema>;

// ---------------------------------------------------------------------------
// Create / Update
// ---------------------------------------------------------------------------

/** 工作流图基础结构（不含跨字段校验；供 create / update 复用）。.strict() 拒绝未知字段 */
const workflowGraphBase = z
  .object({
    name: z.string().trim().min(1).max(128),
    description: z.string().max(512).optional(),
    status: workflowStatusSchema.optional(),
    nodes: z.array(workflowNodeInputSchema).min(2).max(500),
    edges: z.array(workflowEdgeInputSchema).max(2000),
  })
  .strict();

/**
 * 图拓扑校验（create / update 共用）：
 *  - 恰好一个 start、至少一个 end；
 *  - 边端点必须存在于节点集；
 *  - start 无入边、end 无出边。
 * 局部更新（nodes/edges 未提供）时跳过对应检查。
 */
function refineGraph<const T extends { nodes?: unknown; edges?: unknown }>(v: T, ctx: z.RefinementCtx): void {
  const nodes = Array.isArray(v.nodes) ? v.nodes : undefined;
  const edges = Array.isArray(v.edges) ? v.edges : undefined;
  if (nodes) {
    const starts = (nodes as { type: string }[]).filter((n) => n.type === 'start');
    if (starts.length !== 1) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['nodes'], message: '工作流必须且只能包含一个 start 节点' });
    }
    const ends = (nodes as { type: string }[]).filter((n) => n.type === 'end');
    if (ends.length < 1) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['nodes'], message: '工作流至少需要一个 end 节点' });
    }
  }
  if (edges) {
    const nodeIds = new Set((nodes as { id: string }[] | undefined)?.map((n) => n.id) ?? []);
    if (nodes) {
      for (const edge of edges as { id: string; sourceNodeId: string; targetNodeId: string }[]) {
        if (!nodeIds.has(edge.sourceNodeId)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['edges'],
            message: `边 ${edge.id} 的 sourceNodeId「${edge.sourceNodeId}」不存在`,
          });
        }
        if (!nodeIds.has(edge.targetNodeId)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['edges'],
            message: `边 ${edge.id} 的 targetNodeId「${edge.targetNodeId}」不存在`,
          });
        }
      }
      for (const node of nodes as { id: string; type: string }[]) {
        if (node.type === 'end' && (edges as { sourceNodeId: string }[]).some((e) => e.sourceNodeId === node.id)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['edges'],
            message: `end 节点「${node.id}」不允许有出边`,
          });
        }
        if (node.type === 'start' && (edges as { targetNodeId: string }[]).some((e) => e.targetNodeId === node.id)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['edges'],
            message: `start 节点「${node.id}」不允许有入边`,
          });
        }
      }
    }
  }
}

/** 创建工作流（nodes/edges 一次性整体提交） */
export const createWorkflowInputSchema = workflowGraphBase.superRefine(refineGraph);
export type CreateWorkflowInput = z.infer<typeof createWorkflowInputSchema>;

/** 局部更新；nodes / edges 传数组时整体替换 */
export const updateWorkflowInputSchema = workflowGraphBase.partial().superRefine(refineGraph);
export type UpdateWorkflowInput = z.infer<typeof updateWorkflowInputSchema>;

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

export const workflowNodeViewSchema = z.object({
  id: z.string(),
  workflowId: z.string().uuid(),
  type: workflowNodeTypeSchema,
  name: z.string().nullable(),
  data: z.record(z.string(), z.unknown()).nullable(),
  position: z.record(z.string(), z.unknown()).nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type WorkflowNodeView = z.infer<typeof workflowNodeViewSchema>;

export const workflowEdgeViewSchema = z.object({
  id: z.string(),
  workflowId: z.string().uuid(),
  sourceNodeId: z.string(),
  targetNodeId: z.string(),
  sourceHandle: z.string().nullable(),
  targetHandle: z.string().nullable(),
  condition: workflowEdgeConditionSchema.nullable(),
  createdAt: z.string(),
});
export type WorkflowEdgeView = z.infer<typeof workflowEdgeViewSchema>;

export const workflowViewSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  description: z.string().nullable(),
  status: workflowStatusSchema,
  version: z.number().int().positive(),
  nodes: z.array(workflowNodeViewSchema),
  edges: z.array(workflowEdgeViewSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type WorkflowView = z.infer<typeof workflowViewSchema>;

// ---------------------------------------------------------------------------
// 运行（run）
// ---------------------------------------------------------------------------

/** 触发工作流：workflowId + 输入（缺省 {}） */
export const workflowRunRequestSchema = z
  .object({
    workflowId: z.string().uuid(),
    inputs: z.record(z.string(), z.unknown()).default({}),
    /** 服务端是否以 SSE 流式输出（本 schema 由 JSON 接口复用；流式接口走独立 SSE 编码） */
    stream: z.boolean().default(false),
  })
  .strict();
export type WorkflowRunRequest = z.infer<typeof workflowRunRequestSchema>;

/** 单节点执行结果（observability：每次运行记录） */
export const workflowNodeResultSchema = z.object({
  nodeId: z.string(),
  name: z.string().nullable(),
  type: workflowNodeTypeSchema,
  status: z.enum(['success', 'error']),
  /** 该节点写入的变量（部分） */
  output: z.record(z.string(), z.unknown()).nullable(),
  error: z.string().nullable(),
  startedAt: z.string(),
  endedAt: z.string(),
});
export type WorkflowNodeResult = z.infer<typeof workflowNodeResultSchema>;

/** 一次性运行结果 */
export const workflowRunResultSchema = z.object({
  runId: z.string().uuid(),
  workflowId: z.string().uuid(),
  status: z.enum(['success', 'failed']),
  inputs: z.record(z.string(), z.unknown()),
  outputs: z.record(z.string(), z.unknown()),
  nodeResults: z.array(workflowNodeResultSchema),
  error: z.string().nullable(),
  createdAt: z.string(),
  durationMs: z.number().nonnegative(),
});
export type WorkflowRunResult = z.infer<typeof workflowRunResultSchema>;

/** 运行日志视图（workflow_runs 表回读形态，列表/详情共用） */
export const workflowRunViewSchema = workflowRunResultSchema.extend({
  nodeResults: z.array(workflowNodeResultSchema).default([]),
});
export type WorkflowRunView = z.infer<typeof workflowRunViewSchema>;

/** 工作流流式事件（SSE：node_end → done / error） */
export const workflowStreamEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('node_end'),
    runId: z.string().uuid(),
    nodeId: z.string(),
    name: z.string().nullable(),
    nodeType: workflowNodeTypeSchema,
    status: z.enum(['success', 'error']),
    output: z.record(z.string(), z.unknown()).nullable(),
    error: z.string().nullable(),
    startedAt: z.string(),
    endedAt: z.string(),
  }),
  z.object({
    type: z.literal('done'),
    runId: z.string().uuid(),
    status: z.enum(['success', 'failed']),
    outputs: z.record(z.string(), z.unknown()),
    nodeResults: z.array(workflowNodeResultSchema),
    error: z.string().nullable(),
    durationMs: z.number().nonnegative(),
    createdAt: z.string(),
  }),
  z.object({ type: z.literal('error'), runId: z.string().uuid(), code: z.string(), message: z.string() }),
]);
export type WorkflowStreamEvent = z.infer<typeof workflowStreamEventSchema>;

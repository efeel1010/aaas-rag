/**
 * M5 节点执行器 —— 各节点类型的执行逻辑（与 LangGraph 解耦的纯函数）。
 *
 * 约定：每个节点从「变量空间」读取，返回「要写入的变量增量」：
 *  - start               → 把 inputs 全部注入变量空间；
 *  - end                 → 按 outputs 字段映射变量 → 输出（缺省全量变量）；
 *  - llm                 → 经模型网关 / ChatOpenAI 补全，写 cfg.output；
 *  - knowledge_retrieval → 混合检索，写 cfg.output（RetrievalResult）+ 可选上下文文本；
 *  - intent              → 确定性分支分类，写 cfg.output = 分支名 | null；
 *  - condition           → 按出边条件求值，写 cfg.output = 命中分支名（可选）；
 *  - code                → node:vm 受控执行 (ctx) => Partial<variables>；
 *  - http_request        → fetch（可注入），写 { status, data, headers }；
 *  - template            → 渲染 {{var}} 模板，写 cfg.output。
 */
import vm from 'node:vm';
import { workflowNodeInputSchema, type WorkflowNodeInput } from '@pulse/contracts';
import { formatRetrievalContext } from '../agent-runtime.js';
import { classifyMock } from '../intent-service.js';
import { findBranch } from './condition.js';
import { renderTemplate, resolvePath } from './template.js';
import type {
  ExecutorDeps,
  WorkflowEdgeDefinition,
  WorkflowNodeDefinition,
  WorkflowState,
} from './types.js';
import { WorkflowExecutionError } from './types.js';

/** 用 contracts 判别联合校验节点 data（拒绝未知字段，保证画布/引擎同构） */
export function parseWorkflowNode(node: WorkflowNodeDefinition): WorkflowNodeInput {
  // name 在 DB 为 nullable，契约层为 optional string（创建时省略而非传 null）—— 引擎边界把 null 归一化为 undefined
  return workflowNodeInputSchema.parse({
    id: node.id,
    name: node.name ?? undefined,
    type: node.type,
    data: node.data ?? {},
  });
}

/**
 * 执行单个节点。state.variables 为当前变量空间（含此前所有节点写入）。
 * 返回 Partial<WorkflowState>：{ variables: 增量 } 或 { outputs }（end）。
 */
export async function executeNode(
  node: WorkflowNodeInput,
  state: WorkflowState,
  outgoing: WorkflowEdgeDefinition[],
  deps: ExecutorDeps,
): Promise<Partial<WorkflowState>> {
  const variables = state.variables ?? {};
  switch (node.type) {
    case 'start':
      return { variables: { ...state.inputs } };
    case 'end':
      return { outputs: buildEndOutputs(node, variables) };
    case 'llm':
      return { variables: await execLlm(node, variables, deps) };
    case 'knowledge_retrieval':
      return { variables: await execRetrieval(node, variables, deps) };
    case 'intent':
      return { variables: execIntent(node, variables, outgoing) };
    case 'condition':
      return { variables: execCondition(node, variables, outgoing) };
    case 'iteration':
      return { variables: execIteration(node, variables) };
    case 'code':
      return { variables: execCode(node, variables, state.inputs) };
    case 'http_request':
      return { variables: await execHttp(node, variables, deps) };
    case 'template':
      return { variables: execTemplate(node, variables) };
    default: {
      // 类型穷举守卫：未来新增节点类型未在此处理时，TS 编译即报错
      const exhaustive: never = node;
      void exhaustive;
      throw new WorkflowExecutionError(`不支持的节点类型: ${String(node)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// end
// ---------------------------------------------------------------------------

/** end：按 outputs 字段映射（缺省输出全部变量） */
function buildEndOutputs(
  node: Extract<WorkflowNodeInput, { type: 'end' }>,
  variables: Record<string, unknown>,
): Record<string, unknown> {
  if (node.data.outputs.length === 0) return { ...variables };
  const outputs: Record<string, unknown> = {};
  for (const field of node.data.outputs) {
    outputs[field.name] = resolvePath(variables, field.from);
  }
  return outputs;
}

// ---------------------------------------------------------------------------
// llm
// ---------------------------------------------------------------------------

async function execLlm(
  node: Extract<WorkflowNodeInput, { type: 'llm' }>,
  variables: Record<string, unknown>,
  deps: ExecutorDeps,
): Promise<Record<string, unknown>> {
  const prompt = renderTemplate(node.data.prompt, variables);
  const content = await deps.completeChat({
    modelId: node.data.modelId,
    system: node.data.system,
    prompt,
    temperature: node.data.temperature,
    maxTokens: node.data.maxTokens,
    engine: node.data.engine,
  });
  return { [node.data.output]: content };
}

// ---------------------------------------------------------------------------
// knowledge_retrieval
// ---------------------------------------------------------------------------

async function execRetrieval(
  node: Extract<WorkflowNodeInput, { type: 'knowledge_retrieval' }>,
  variables: Record<string, unknown>,
  deps: ExecutorDeps,
): Promise<Record<string, unknown>> {
  const query = renderTemplate(node.data.query, variables);
  let datasetIds = node.data.datasetIds ?? [];
  if (node.data.datasetIdsVariable) {
    const fromVar = resolvePath(variables, node.data.datasetIdsVariable);
    if (Array.isArray(fromVar)) {
      datasetIds = fromVar.filter((x): x is string => typeof x === 'string');
    }
  }
  if (datasetIds.length === 0) {
    throw new WorkflowExecutionError(`检索节点「${node.name ?? node.id}」未解析到任何知识库`);
  }
  const result = await deps.retrieve(query, datasetIds, node.data.topK, node.data.rerankModelId);
  const out: Record<string, unknown> = { [node.data.output]: result };
  if (node.data.contextOutput) {
    out[node.data.contextOutput] = formatRetrievalContext(result.hits);
  }
  return out;
}

// ---------------------------------------------------------------------------
// intent（确定性分支分类，复用 intent-service 的 mock 打分）
// ---------------------------------------------------------------------------

function execIntent(
  node: Extract<WorkflowNodeInput, { type: 'intent' }>,
  variables: Record<string, unknown>,
  outgoing: WorkflowEdgeDefinition[],
): Record<string, unknown> {
  const query = String(resolvePath(variables, node.data.queryVariable) ?? '');
  const candidates = outgoing.flatMap((edge) => {
    const cond = edge.condition;
    if (!cond?.branch) return [];
    return [
      {
        intentId: cond.branch,
        name: cond.branch,
        description: null,
        examples: cond.examples ?? [],
        strategy: 'retrieval' as const,
        responseTemplate: null,
        workflowId: null,
        datasetId: null,
        priority: 0,
      },
    ];
  });
  const match = classifyMock(query, candidates);
  return { [node.data.output]: match?.name ?? null };
}

// ---------------------------------------------------------------------------
// condition
// ---------------------------------------------------------------------------

function execCondition(
  node: Extract<WorkflowNodeInput, { type: 'condition' }>,
  variables: Record<string, unknown>,
  outgoing: WorkflowEdgeDefinition[],
): Record<string, unknown> {
  if (!node.data.output) return {};
  const hit = findBranch(outgoing, variables);
  if (!hit) return { [node.data.output]: null };
  return { [node.data.output]: hit.branchLabel };
}

// ---------------------------------------------------------------------------
// iteration（内联模板迭代：遍历数组，逐项渲染，聚合结果）
// ---------------------------------------------------------------------------

function execIteration(
  node: Extract<WorkflowNodeInput, { type: 'iteration' }>,
  variables: Record<string, unknown>,
): Record<string, unknown> {
  const arr = resolvePath(variables, node.data.arrayVariable);
  if (!Array.isArray(arr)) {
    throw new WorkflowExecutionError(
      `迭代节点「${node.name ?? node.id}」的数组变量「${node.data.arrayVariable}」不存在或不是数组`,
    );
  }
  const itemVar = node.data.itemVariable;
  const results = arr.map((item, index) => {
    // 迭代作用域：继承现有变量 + 当前项 + 下标；模板内以 {{item}} / {{item.x}} / {{index}} 引用
    const scope: Record<string, unknown> = { ...variables, [itemVar]: item, index };
    return renderTemplate(node.data.bodyTemplate, scope);
  });
  return { [node.data.output]: results };
}

// ---------------------------------------------------------------------------
// code（node:vm 受控执行）
// ---------------------------------------------------------------------------

function execCode(
  node: Extract<WorkflowNodeInput, { type: 'code' }>,
  variables: Record<string, unknown>,
  inputs: Record<string, unknown>,
): Record<string, unknown> {
  // 函数体形如 (ctx) => ({ ... })，在隔离上下文求值后立即以 ctx 调用
  const source = `(${node.data.code})(ctx)`;
  const sandbox: Record<string, unknown> = { ctx: { variables, inputs } };
  const context = vm.createContext(sandbox);
  let result: unknown;
  try {
    result = new vm.Script(source, { filename: `workflow-code-${node.id}.js` }).runInContext(context, {
      timeout: node.data.timeoutMs,
    });
  } catch (err) {
    throw new WorkflowExecutionError(
      `代码节点「${node.name ?? node.id}」执行失败: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (result === null || typeof result !== 'object' || Array.isArray(result)) {
    throw new WorkflowExecutionError(`代码节点「${node.name ?? node.id}」必须返回一个对象（要写入的变量集合）`);
  }
  return result as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// http_request
// ---------------------------------------------------------------------------

async function execHttp(
  node: Extract<WorkflowNodeInput, { type: 'http_request' }>,
  variables: Record<string, unknown>,
  deps: ExecutorDeps,
): Promise<Record<string, unknown>> {
  const url = renderTemplate(node.data.url, variables);
  if (!/^https?:\/\//i.test(url)) {
    throw new WorkflowExecutionError(`HTTP 节点「${node.name ?? node.id}」URL 仅允许 http/https: ${url}`);
  }
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(node.data.headers ?? {})) {
    headers[k] = renderTemplate(v, variables);
  }
  const body = node.data.body !== undefined ? renderTemplate(node.data.body, variables) : undefined;
  const response = await deps.http({ method: node.data.method, url, headers, body, timeoutMs: node.data.timeoutMs });
  return { [node.data.output]: response };
}

// ---------------------------------------------------------------------------
// template
// ---------------------------------------------------------------------------

function execTemplate(
  node: Extract<WorkflowNodeInput, { type: 'template' }>,
  variables: Record<string, unknown>,
): Record<string, unknown> {
  return { [node.data.output]: renderTemplate(node.data.template, variables) };
}

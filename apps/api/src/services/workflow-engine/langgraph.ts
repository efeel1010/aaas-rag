/**
 * M5 LangGraph 图构建 —— 把 DB 中的 workflow_nodes / workflow_edges 映射为
 * @langchain/langgraph 的 StateGraph。
 *
 * 映射约定：
 *  - 状态 = { inputs, variables, outputs }：inputs 为运行入参，variables 为跨节点
 *    聚合的变量空间（merge reducer，节点返回增量即合并），outputs 为 end 节点映射结果；
 *  - 每个 workflow 节点 → 一个 LangGraph 节点（名称加 wf_ 前缀避免与 START/END 冲突）；
 *  - condition / intent 节点 → addConditionalEdges（按边条件 / 分支分类路由）；
 *  - end 节点 → addEdge(END)；其余节点按出边逐一 addEdge（fan-out 支持并行）；
 *  - 每个节点执行器外层包裹 hook，完成/失败时回调（供 execute 记录 / stream 发事件）。
 */
import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import type { WorkflowNodeResult, WorkflowNodeType } from '@pulse/contracts';
import { findBranch, fallbackEdge } from './condition.js';
import { executeNode, parseWorkflowNode } from './executors.js';
import type {
  ExecutorDeps,
  NodeHook,
  WorkflowEdgeDefinition,
  WorkflowGraphDefinition,
} from './types.js';
import { NOOP_HOOK, WorkflowExecutionError } from './types.js';

// ---------------------------------------------------------------------------
// 状态注解：variables 用 merge reducer（节点写增量即合并）
// ---------------------------------------------------------------------------

export const WorkflowStateAnnotation = Annotation.Root({
  inputs: Annotation<Record<string, unknown>>(),
  variables: Annotation<Record<string, unknown>>({
    reducer: (left, right) => ({ ...left, ...right }),
    default: () => ({}),
  }),
  outputs: Annotation<Record<string, unknown>>(),
});

export type WorkflowStateValue = typeof WorkflowStateAnnotation.State;

/** 节点名前缀：规避与 LangGraph 内置 START/END 以及画布 id 的冲突 */
const NODE_PREFIX = 'wf_';

function lgNode(id: string): string {
  return `${NODE_PREFIX}${id}`;
}

/** 收集某节点的所有出边 */
function groupOutEdges(edges: WorkflowEdgeDefinition[]): Map<string, WorkflowEdgeDefinition[]> {
  const map = new Map<string, WorkflowEdgeDefinition[]>();
  for (const edge of edges) {
    const list = map.get(edge.sourceNodeId) ?? [];
    list.push(edge);
    map.set(edge.sourceNodeId, list);
  }
  return map;
}

// ---------------------------------------------------------------------------
// 节点执行器包装：捕获完成/失败 → hook
// ---------------------------------------------------------------------------

function makeNodeFn(
  node: ReturnType<typeof parseWorkflowNode>,
  outgoing: WorkflowEdgeDefinition[],
  deps: ExecutorDeps,
  hook: NodeHook,
): (state: WorkflowStateValue) => Promise<Partial<WorkflowStateValue>> {
  return async (state) => {
    const startedAt = new Date().toISOString();
    try {
      const delta = await executeNode(node, state, outgoing, deps);
      hook.onNodeEnd(toNodeResult(node, 'success', delta.variables ?? null, null, startedAt));
      return delta as Partial<WorkflowStateValue>;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      hook.onNodeEnd(toNodeResult(node, 'error', null, message, startedAt));
      throw err;
    }
  };
}

function toNodeResult(
  node: { id: string; name?: string | null; type: WorkflowNodeType },
  status: 'success' | 'error',
  output: Record<string, unknown> | null,
  error: string | null,
  startedAt: string,
): WorkflowNodeResult {
  return {
    nodeId: node.id,
    name: node.name ?? null,
    type: node.type,
    status,
    output,
    error,
    startedAt,
    endedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// 条件 / 意图 路由（addConditionalEdges 的 path 函数）
// ---------------------------------------------------------------------------

function makeConditionRouter(
  node: ReturnType<typeof parseWorkflowNode>,
  edges: WorkflowEdgeDefinition[],
): (state: WorkflowStateValue) => string {
  return (state) => {
    const hit = findBranch(edges, state.variables ?? {});
    if (!hit) {
      throw new WorkflowExecutionError(`条件节点「${node.name ?? node.id}」未命中任何分支且无兜底边`);
    }
    return lgNode(hit.edge.targetNodeId);
  };
}

function makeIntentRouter(
  node: Extract<ReturnType<typeof parseWorkflowNode>, { type: 'intent' }>,
  edges: WorkflowEdgeDefinition[],
): (state: WorkflowStateValue) => string {
  return (state) => {
    const branch = state.variables?.[node.data.output] ?? state.variables?.intent;
    if (typeof branch === 'string' && branch.length > 0) {
      const edge = edges.find((e) => e.condition?.branch === branch) ?? fallbackEdge(edges);
      if (edge) return lgNode(edge.targetNodeId);
    }
    const fb = fallbackEdge(edges);
    if (!fb) {
      throw new WorkflowExecutionError(`意图节点「${node.name ?? node.id}」未命中任何分支且无兜底边`);
    }
    return lgNode(fb.targetNodeId);
  };
}

// ---------------------------------------------------------------------------
// 图构建
// ---------------------------------------------------------------------------

/**
 * 构建 LangGraph 状态图。节点名来自 DB（动态字符串），故把 builder 的节点名
 * 泛型放宽为 string，避免逐节点字面量推导导致接线类型报错。
 */
export function buildStateGraph(graph: WorkflowGraphDefinition, deps: ExecutorDeps, hook: NodeHook = NOOP_HOOK) {
  // 经 contracts schema 校验节点定义（data 非法 → 立即抛错，避免运行期踩雷）
  const nodes = graph.nodes.map(parseWorkflowNode);
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const outEdges = groupOutEdges(graph.edges);

  const builder = new StateGraph(WorkflowStateAnnotation) as unknown as StateGraph<
    // 动态节点名 → N 放宽为 string
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    any,
    string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    any
  >;
  for (const node of nodes) {
    builder.addNode(lgNode(node.id), makeNodeFn(node, outEdges.get(node.id) ?? [], deps, hook));
  }

  // 入口：start 节点
  const start = nodes.find((n) => n.type === 'start');
  if (!start) throw new WorkflowExecutionError('工作流缺少 start 节点，无法构建执行图');
  builder.addEdge(START, lgNode(start.id));

  // 逐节点接线
  for (const node of nodes) {
    const outgoing = outEdges.get(node.id) ?? [];
    switch (node.type) {
      case 'condition':
        builder.addConditionalEdges(lgNode(node.id), makeConditionRouter(node, outgoing));
        break;
      case 'intent':
        builder.addConditionalEdges(lgNode(node.id), makeIntentRouter(node, outgoing));
        break;
      case 'end':
        builder.addEdge(lgNode(node.id), END);
        break;
      default:
        if (outgoing.length === 0) {
          // 无出边的普通节点：视为终点（防 LangGraph 悬挂），输出由 end 节点承担
          builder.addEdge(lgNode(node.id), END);
          break;
        }
        for (const edge of outgoing) {
          if (!nodeById.has(edge.targetNodeId)) {
            throw new WorkflowExecutionError(`边 ${edge.id} 指向不存在的节点「${edge.targetNodeId}」`);
          }
          builder.addEdge(lgNode(node.id), lgNode(edge.targetNodeId));
        }
    }
  }

  return builder.compile();
}

/** 供测试 / 扩展使用：把工作流节点 id 映射为 LangGraph 内部节点名 */
export function toLangGraphNodeName(id: string): string {
  return lgNode(id);
}

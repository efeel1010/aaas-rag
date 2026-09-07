/**
 * 工作流编辑器工具 —— 节点类型元数据 / 默认配置 / ReactFlow ↔ 后端图定义互转。
 *
 * 约定：
 *  - ReactFlow 节点：type 直接使用 WorkflowNodeType，data = { config, label }；
 *    config 即后端节点 data（严格按 contracts 判别联合）。
 *  - ReactFlow 边：data = { condition }，与后端边 condition 对齐。
 */
import type {
  CreateWorkflowInput,
  UpdateWorkflowInput,
  WorkflowEdgeCondition,
  WorkflowEdgeInput,
  WorkflowEdgeView,
  WorkflowNodeInput,
  WorkflowNodeType,
  WorkflowNodeView,
  WorkflowView,
} from '@pulse/contracts';
import { createWorkflowInputSchema, updateWorkflowInputSchema } from '@pulse/contracts';
import type { Edge, Node } from '@xyflow/react';
import type { IconName } from '../components/ui/Icon.js';

export type { WorkflowNodeType } from '@pulse/contracts';

// ---------------------------------------------------------------------------
// 节点类型元数据
// ---------------------------------------------------------------------------

export interface NodeTypeMeta {
  type: WorkflowNodeType;
  label: string;
  icon: IconName;
  color: string;
  description: string;
  /** 是否有出边端口（start 除外均可出；end 无） */
  hasSource: boolean;
  /** 是否有入边端口 */
  hasTarget: boolean;
}

export const NODE_TYPE_META: Record<WorkflowNodeType, NodeTypeMeta> = {
  start: {
    type: 'start',
    label: '开始',
    icon: 'play',
    color: '#34d399',
    description: '声明输入字段，运行入参经其注入变量空间',
    hasSource: true,
    hasTarget: false,
  },
  llm: {
    type: 'llm',
    label: 'LLM',
    icon: 'cpu',
    color: '#7c5cff',
    description: '调用对话模型生成文本',
    hasSource: true,
    hasTarget: true,
  },
  knowledge_retrieval: {
    type: 'knowledge_retrieval',
    label: '知识检索',
    icon: 'database',
    color: '#60a5fa',
    description: '混合检索（向量 + 关键词，RRF 融合）',
    hasSource: true,
    hasTarget: true,
  },
  intent: {
    type: 'intent',
    label: '意图判断',
    icon: 'sparkles',
    color: '#fbbf24',
    description: '按分支示例分类查询，分支在出边上声明',
    hasSource: true,
    hasTarget: true,
  },
  condition: {
    type: 'condition',
    label: '条件分支',
    icon: 'branches',
    color: '#fb923c',
    description: '按出边条件表达式选择分支',
    hasSource: true,
    hasTarget: true,
  },
  iteration: {
    type: 'iteration',
    label: '迭代',
    icon: 'refresh',
    color: '#f472b6',
    description: '遍历数组，逐项渲染模板并聚合结果',
    hasSource: true,
    hasTarget: true,
  },
  code: {
    type: 'code',
    label: '代码',
    icon: 'code',
    color: '#a78bfa',
    description: 'JS 代码（受控执行）写入变量',
    hasSource: true,
    hasTarget: true,
  },
  http_request: {
    type: 'http_request',
    label: 'HTTP 请求',
    icon: 'globe',
    color: '#22d3ee',
    description: '发起 HTTP 请求并写入响应',
    hasSource: true,
    hasTarget: true,
  },
  template: {
    type: 'template',
    label: '模板',
    icon: 'template',
    color: '#4ade80',
    description: '渲染 {{var}} 模板输出文本',
    hasSource: true,
    hasTarget: true,
  },
  end: {
    type: 'end',
    label: '结束',
    icon: 'stop',
    color: '#f87171',
    description: '声明输出字段，映射变量为对外结果',
    hasSource: false,
    hasTarget: true,
  },
};

export const NODE_TYPES: WorkflowNodeType[] = [
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
];

/** 画布节点 data 约定 */
export interface WorkflowNodeData {
  /** 后端节点 data（按类型判别联合） */
  config: Record<string, unknown>;
  /** 节点展示名 */
  label: string;
  [key: string]: unknown;
}

/** 画布边 data 约定 */
export interface WorkflowEdgeData {
  condition?: WorkflowEdgeCondition;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// 默认配置（与后端 schema 对齐）
// ---------------------------------------------------------------------------

function defaultConfig(type: WorkflowNodeType): Record<string, unknown> {
  switch (type) {
    case 'start':
      return { inputs: [] };
    case 'llm':
      return { modelId: '', system: '', prompt: '', temperature: 0.7, maxTokens: 1024, output: 'answer', engine: 'gateway' };
    case 'knowledge_retrieval':
      return { datasetIds: [], query: '', topK: 6, output: 'retrieval', contextOutput: 'context' };
    case 'intent':
      return { queryVariable: 'query', output: 'intent' };
    case 'condition':
      return { output: 'condition_result' };
    case 'iteration':
      return { arrayVariable: '', itemVariable: 'item', bodyTemplate: '{{item}}', output: 'results' };
    case 'code':
      return { code: '(ctx) => ({ greeting: `你好，${ctx.variables.query ?? "世界"}` })', timeoutMs: 3000 };
    case 'http_request':
      return { method: 'GET', url: '', headers: {}, body: '', timeoutMs: 10000, output: 'http' };
    case 'template':
      return { template: '{{query}}', output: 'text' };
    case 'end':
      return { outputs: [] };
    default:
      return {};
  }
}

let seq = 0;
export function genNodeId(prefix = 'node'): string {
  seq += 1;
  return `${prefix}_${Date.now().toString(36)}_${seq}`;
}
export function genEdgeId(): string {
  seq += 1;
  return `edge_${Date.now().toString(36)}_${seq}`;
}

/** 新建节点（含默认配置） */
export function createRfNode(
  type: WorkflowNodeType,
  position: { x: number; y: number },
  label?: string,
): RfNode {
  return {
    id: genNodeId(),
    type,
    position,
    data: {
      config: defaultConfig(type),
      label: label ?? NODE_TYPE_META[type]?.label ?? type,
    } as WorkflowNodeData,
  };
}

/** 画布初始图：start → end */
export function initialRfGraph(): RfNode[] {
  return [
    createRfNode('start', { x: 120, y: 200 }),
    createRfNode('end', { x: 640, y: 200 }),
  ];
}

// ---------------------------------------------------------------------------
// 互转
// ---------------------------------------------------------------------------

/** ReactFlow 节点完整类型（含 id/position） */
export type RfNode = Node<WorkflowNodeData>;
/** ReactFlow 边完整类型（含 source/target） */
export type RfEdge = Edge<WorkflowEdgeData>;

/** 画布节点 → 后端节点定义（data 由画布任意配置，后端 zod 严格校验兜底） */
export function rfNodesToInput(nodes: RfNode[]): WorkflowNodeInput[] {
  return nodes.map(
    (n) =>
      ({
        id: n.id,
        type: n.type,
        name: n.data.label,
        data: n.data.config,
        position: n.position,
      }) as WorkflowNodeInput,
  );
}

/** 画布边 → 后端边定义 */
export function rfEdgesToInput(edges: RfEdge[]): WorkflowEdgeInput[] {
  return edges.map((e) => ({
    id: e.id,
    sourceNodeId: e.source,
    targetNodeId: e.target,
    sourceHandle: e.sourceHandle ?? undefined,
    targetHandle: e.targetHandle ?? undefined,
    condition: e.data?.condition,
  }));
}

/** 后端节点视图 → 画布节点 */
export function viewNodesToRf(nodes: WorkflowNodeView[]): RfNode[] {
  return nodes.map((n) => ({
    id: n.id,
    type: n.type,
    position: (n.position as { x: number; y: number } | null) ?? { x: 0, y: 0 },
    data: {
      config: (n.data ?? {}) as Record<string, unknown>,
      label: n.name ?? NODE_TYPE_META[n.type]?.label ?? n.type,
    },
  }));
}

/** 后端边视图 → 画布边 */
export function viewEdgesToRf(edges: WorkflowEdgeView[]): RfEdge[] {
  return edges.map((e) => ({
    id: e.id,
    source: e.sourceNodeId,
    target: e.targetNodeId,
    sourceHandle: e.sourceHandle ?? undefined,
    targetHandle: e.targetHandle ?? undefined,
    data: e.condition ? { condition: e.condition } : undefined,
  }));
}

// ---------------------------------------------------------------------------
// 保存校验（复用 contracts schema）
// ---------------------------------------------------------------------------

export function validateGraph(
  input: CreateWorkflowInput,
  isUpdate = false,
): { ok: true } | { ok: false; message: string } {
  const result = isUpdate
    ? updateWorkflowInputSchema.safeParse(input as UpdateWorkflowInput)
    : createWorkflowInputSchema.safeParse(input);
  if (result.success) return { ok: true };
  const first = result.error.issues[0];
  const path = first?.path.join('.');
  return {
    ok: false,
    message: first ? `${path ? `${path}: ` : ''}${first.message}` : '图校验失败',
  };
}

/** 从后端 view 反解可提交的图定义（编辑回显用） */
export function viewToInput(view: WorkflowView): CreateWorkflowInput {
  return {
    name: view.name,
    description: view.description ?? undefined,
    status: view.status,
    nodes: rfNodesToInput(viewNodesToRf(view.nodes)),
    edges: rfEdgesToInput(viewEdgesToRf(view.edges)),
  };
}

// ---------------------------------------------------------------------------
// 边条件展示
// ---------------------------------------------------------------------------

export function valueLabel(value: unknown): string {
  if (Array.isArray(value)) return value.map((v) => String(v)).join(',');
  if (typeof value === 'object' && value !== null) return JSON.stringify(value);
  return String(value ?? '');
}

export function edgeConditionLabel(condition?: WorkflowEdgeCondition | null): string {
  if (!condition) return '';
  if (condition.branch) return condition.branch;
  if (condition.variable) {
    return `${condition.variable} ${condition.operator ?? ''} ${
      condition.operator === 'is_empty' || condition.operator === 'is_not_empty'
        ? ''
        : valueLabel(condition.value)
    }`.trim();
  }
  return '';
}

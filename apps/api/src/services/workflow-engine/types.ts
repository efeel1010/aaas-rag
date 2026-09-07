/**
 * M5 工作流引擎内部类型 —— 引擎与存储之间的图模型约定。
 *
 * 这些类型由 workflow-store 从 DB 的 workflow_nodes / workflow_edges 装配，
 * 再由引擎（langgraph.ts / executors.ts）消费。contracts 负责对外契约校验，
 * 这里的类型负责「引擎可执行」的运行时形态。
 */
import type {
  RetrievalResult,
  WorkflowEdgeCondition,
  WorkflowNodeResult,
  WorkflowNodeType,
} from '@pulse/contracts';

/** 节点定义（来自 workflow_nodes 行 + 经 contracts 校验后的 data） */
export interface WorkflowNodeDefinition {
  id: string;
  type: WorkflowNodeType;
  name: string | null;
  /** 节点配置原文（存 DB jsonb；运行前经 contracts schema 二次校验） */
  data: Record<string, unknown> | null;
}

/** 边定义（来自 workflow_edges 行） */
export interface WorkflowEdgeDefinition {
  id: string;
  sourceNodeId: string;
  targetNodeId: string;
  condition: WorkflowEdgeCondition | null;
}

/** 可执行的工作流图（loadGraphForRun 返回形态） */
export interface WorkflowGraphDefinition {
  id: string;
  name: string;
  status: 'draft' | 'published' | 'archived';
  nodes: WorkflowNodeDefinition[];
  edges: WorkflowEdgeDefinition[];
}

/** HTTP 节点出参（写入变量空间的 { status, data, headers }） */
export interface HttpResponseSpec {
  status: number;
  data: unknown;
  headers: Record<string, string>;
}

/** http_request 节点执行入参（URL/头/体已渲染） */
export interface HttpRequestSpec {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs: number;
}

/** 节点执行器的可注入依赖（单测 / mock 可替换） */
export interface ExecutorDeps {
  /** mock 判定（MOCK_MODELS=true 时 LLM 回显、检索确定性） */
  isMock: () => boolean;
  /**
   * LLM 补全：
   *  - engine=gateway（默认）：经项目模型网关 lib/models（支持 mock / 凭据解密）；
   *  - engine=langchain：经 @langchain/openai ChatOpenAI（真实模式）。
   * 返回生成文本。
   */
  completeChat: (input: {
    modelId: string;
    system?: string;
    prompt: string;
    temperature?: number;
    maxTokens?: number;
    engine: 'gateway' | 'langchain';
  }) => Promise<string>;
  /** 混合检索（M3 retrieval-service）；rerankModelId 由检索节点配置传入，可为空 */
  retrieve: (
    query: string,
    datasetIds: string[],
    topK: number,
    rerankModelId?: string | null,
  ) => Promise<RetrievalResult>;
  /** HTTP 请求执行器 */
  http: (request: HttpRequestSpec) => Promise<HttpResponseSpec>;
}

/** LangGraph 状态：输入注入 → 变量空间聚合 → 输出映射 */
export interface WorkflowState {
  inputs: Record<string, unknown>;
  variables: Record<string, unknown>;
  outputs: Record<string, unknown>;
}

/** 节点完成回调（observability：execute 记录数组 / stream 发送 SSE 事件） */
export interface NodeHook {
  onNodeEnd(result: WorkflowNodeResult): void;
}

export const NOOP_HOOK: NodeHook = { onNodeEnd: () => {} };

/** 引擎内部错误：图定义 / 路由 / 执行失败（统一转为 failed run） */
export class WorkflowExecutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkflowExecutionError';
  }
}

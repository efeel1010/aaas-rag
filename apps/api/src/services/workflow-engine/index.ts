/**
 * M5 工作流引擎公开 API。
 *
 * 双层结构：
 *  - 纯引擎层：executeGraph / streamGraph / buildStateGraph —— 不触 DB，单测可直接注入 stub；
 *  - 服务层：executeWorkflow / streamWorkflow —— 装载已发布工作流图 + 执行 + 落运行日志。
 *
 * 运行语义：
 *  - 状态注入：{ inputs: <运行入参>, variables: {}, outputs: {} }；
 *  - start 节点把 inputs 写入 variables；
 *  - 各节点从 variables 读、写增量；
 *  - end 节点把 variables 映射为 outputs；
 *  - 节点完成/失败经 hook 产出 nodeResults（observability），stream 额外转发 node_end SSE 事件。
 */
import { randomUUID } from 'node:crypto';
import { SystemMessage, HumanMessage } from '@langchain/core/messages';
import { ChatOpenAI } from '@langchain/openai';
import { workflowRunResultSchema, type WorkflowNodeResult, type WorkflowRunResult, type WorkflowStreamEvent } from '@pulse/contracts';
import { completeWithFallback } from '../../lib/models/index.js';
import { isMockMode } from '../../lib/models/providers/index.js';
import { hybridRetrieve } from '../retrieval-service.js';
import { getRunnableModelChain } from '../model-store.js';
import type { ModelDescriptor, ProviderDescriptor } from '../../lib/models/types.js';
import { workflowStore } from '../workflow-store.js';
import { AsyncQueue } from './async-queue.js';
import { buildStateGraph } from './langgraph.js';
import type { ExecutorDeps, NodeHook, WorkflowGraphDefinition } from './types.js';

// ---------------------------------------------------------------------------
// 默认依赖（真实模式走模型网关 + 混合检索 + fetch；mock 模式由网关内建回显）
// ---------------------------------------------------------------------------

export function defaultDeps(): ExecutorDeps {
  return {
    isMock: () => process.env.MOCK_MODELS === 'true',
    completeChat: async ({ modelId, system, prompt, temperature, maxTokens, engine }) => {
      const chain = await getRunnableModelChain(modelId);
      if (engine === 'langchain' && !isMockMode()) {
        // langchain 引擎：走 ChatOpenAI（真实模式）；降级只取主模型
        const primary = chain[0]!;
        return completeViaLangchain(primary.provider, primary.model, { system, prompt, temperature, maxTokens });
      }
      const messages = [];
      if (system) messages.push({ role: 'system' as const, content: system });
      messages.push({ role: 'user' as const, content: prompt });
      const result = await completeWithFallback(chain, { messages, temperature, maxTokens });
      return result.content;
    },
    retrieve: async (query, datasetIds, topK, rerankModelId) =>
      hybridRetrieve({ query, datasetIds, topK, rffK: 60, rerankModelId }),
    http: async ({ method, url, headers, body, timeoutMs }) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(url, {
          method,
          headers,
          body: body !== undefined ? body : undefined,
          signal: controller.signal,
        });
        const text = await res.text();
        let data: unknown = text;
        try {
          data = JSON.parse(text);
        } catch {
          // 非 JSON 响应保留原文
        }
        const responseHeaders: Record<string, string> = {};
        res.headers.forEach((value, key) => {
          responseHeaders[key] = value;
        });
        return { status: res.status, data, headers: responseHeaders };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/** engine=langchain：经 @langchain/openai ChatOpenAI 补全（真实模式） */
async function completeViaLangchain(
  provider: ProviderDescriptor,
  model: ModelDescriptor,
  opts: { system?: string; prompt: string; temperature?: number; maxTokens?: number },
): Promise<string> {
  const apiKey = String(provider.credentials.apiKey ?? provider.credentials.api_key ?? '');
  const baseURL = (provider.config?.baseURL ?? provider.config?.base_url) as string | undefined;
  const llm = new ChatOpenAI({
    model: model.name,
    apiKey,
    temperature: opts.temperature,
    maxTokens: opts.maxTokens,
    ...(baseURL ? { configuration: { baseURL } } : {}),
  });
  const messages = [];
  if (opts.system) messages.push(new SystemMessage(opts.system));
  messages.push(new HumanMessage(opts.prompt));
  const res = await llm.invoke(messages);
  return typeof res.content === 'string' ? res.content : JSON.stringify(res.content);
}

// ---------------------------------------------------------------------------
// 纯引擎层（不触 DB）
// ---------------------------------------------------------------------------

/** 一次性执行图，返回完整运行结果（含节点级明细） */
export async function executeGraph(
  graph: WorkflowGraphDefinition,
  inputs: Record<string, unknown>,
  deps: ExecutorDeps,
): Promise<WorkflowRunResult> {
  const runId = randomUUID();
  const startedAt = Date.now();
  const nodeResults: WorkflowNodeResult[] = [];
  const hook: NodeHook = { onNodeEnd: (r) => nodeResults.push(r) };
  const compiled = buildStateGraph(graph, deps, hook);

  let status: 'success' | 'failed' = 'success';
  let error: string | null = null;
  let outputs: Record<string, unknown> = {};
  try {
    const final = await compiled.invoke({ inputs, variables: {}, outputs: {} });
    outputs = final.outputs ?? {};
  } catch (err) {
    status = 'failed';
    error = err instanceof Error ? err.message : String(err);
  }
  const createdAt = new Date().toISOString();
  const durationMs = Date.now() - startedAt;
  return { runId, workflowId: graph.id, status, inputs, outputs, nodeResults, error, createdAt, durationMs };
}

/** 流式执行图：节点完成时实时产出 node_end 事件，末尾产出 done 事件 */
export async function* streamGraph(
  graph: WorkflowGraphDefinition,
  inputs: Record<string, unknown>,
  deps: ExecutorDeps,
): AsyncIterable<WorkflowStreamEvent> {
  const runId = randomUUID();
  const startedAt = Date.now();
  const nodeResults: WorkflowNodeResult[] = [];
  const queue = new AsyncQueue<WorkflowStreamEvent>();

  const hook: NodeHook = {
    onNodeEnd: (r) => {
      nodeResults.push(r);
      queue.push({
        type: 'node_end',
        runId,
        nodeId: r.nodeId,
        name: r.name,
        nodeType: r.type,
        status: r.status,
        output: r.output,
        error: r.error,
        startedAt: r.startedAt,
        endedAt: r.endedAt,
      });
    },
  };
  const compiled = buildStateGraph(graph, deps, hook);

  let status: 'success' | 'failed' = 'success';
  let error: string | null = null;
  let outputs: Record<string, unknown> = {};
  const execution = (async () => {
    try {
      const final = await compiled.invoke({ inputs, variables: {}, outputs: {} });
      outputs = final.outputs ?? {};
    } catch (err) {
      status = 'failed';
      error = err instanceof Error ? err.message : String(err);
    } finally {
      queue.close();
    }
  })();

  // 消费节点事件（实时），完成后等待执行线程收尾
  for await (const evt of queue) {
    yield evt;
  }
  await execution;

  const createdAt = new Date().toISOString();
  const durationMs = Date.now() - startedAt;
  yield {
    type: 'done',
    runId,
    status,
    outputs,
    nodeResults,
    error,
    durationMs,
    createdAt,
  };
}

// ---------------------------------------------------------------------------
// 服务层（装载已发布工作流 + 执行 + 落运行日志）
// ---------------------------------------------------------------------------

/** 一次性执行已发布工作流（run 接口） */
export async function executeWorkflow(
  workflowId: string,
  inputs: Record<string, unknown>,
): Promise<WorkflowRunResult> {
  const graph = await workflowStore.loadGraphForRun(workflowId);
  const result = await executeGraph(graph, inputs, defaultDeps());
  await workflowStore.recordRun(result);
  return result;
}

/** 流式执行已发布工作流（run/stream 接口），运行日志在 done 事件后落库 */
export async function* streamWorkflow(
  workflowId: string,
  inputs: Record<string, unknown>,
): AsyncIterable<WorkflowStreamEvent> {
  const graph = await workflowStore.loadGraphForRun(workflowId);
  let recorded: WorkflowRunResult | null = null;
  for await (const evt of streamGraph(graph, inputs, defaultDeps())) {
    if (evt.type === 'done') {
      recorded = workflowRunResultSchema.parse({
        runId: evt.runId,
        workflowId,
        status: evt.status,
        inputs,
        outputs: evt.outputs,
        nodeResults: evt.nodeResults,
        error: evt.error,
        createdAt: evt.createdAt,
        durationMs: evt.durationMs,
      });
    }
    yield evt;
  }
  if (recorded) {
    await workflowStore.recordRun(recorded);
  }
}

export { buildStateGraph } from './langgraph.js';
export type { ExecutorDeps, NodeHook, WorkflowGraphDefinition, WorkflowNodeDefinition, WorkflowEdgeDefinition } from './types.js';

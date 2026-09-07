/**
 * M4 Agent 运行时（会话编排）—— 单轮 Agent 对话的完整编排：
 *
 *   加载 Agent 上下文 → 意图识别 → 确定检索范围 →（可选）混合检索 topK →
 *   组装 prompt（系统提示 + 意图话术 + 知识上下文 + 历史）→ 调用 LLM（流式）→ 记忆落库
 *
 * 路由策略：
 *  - 命中意图（strategy=retrieval）→ 检索该意图绑定的知识库子集（无子集则用 Agent 全量库）；
 *  - 命中意图（strategy=direct）   → 直接返回 responseTemplate 话术，不调用 LLM；
 *  - 命中意图（strategy=workflow） → 执行关联工作流（executeWorkflow），工作流输出作为本轮回复；
 *  - 未命中 / Agent 未配置意图      → 全知识库检索 + LLM 生成。
 *
 * 依赖注入：createAgentRuntime(deps) 允许替换 loadAgent/classifyIntent/retrieve/chatStream/
 * runWorkflow/conversation，便于单测在无 DB / 无网络下验证编排装配。
 */
import type {
  AgentChatResult,
  AgentIntentHit,
  AgentStreamEvent,
  AgentToolCall,
  ChatMessage,
  ModelStreamEvent,
  RetrievalHitView,
  RetrievalResult,
  WorkflowRunResult,
} from '@pulse/contracts';
import { chatStreamWithFallback, completeWithFallback } from '../lib/models/index.js';
import { AppError } from '../lib/errors.js';
import { hybridRetrieve } from './retrieval-service.js';
import { agentStore, type AgentRuntimeContext } from './agent-store.js';
import { conversationStore } from './conversation-store.js';
import { createIntentService, type IntentCandidate, type IntentMatch } from './intent-service.js';
import { executeWorkflow } from './workflow-engine/index.js';
import { assembleTools, getTool } from '../lib/tools/registry.js';
import type { Tool, ToolContext, ToolRunOutcome } from '../lib/tools/types.js';
import { createToolCallLoop } from './tool-call-loop.js';
// 副作用：注册内置工具（local_retrieval / http_request）
import '../lib/tools/index.js';

// ---------------------------------------------------------------------------
// 纯逻辑：检索范围 / 响应计划 / prompt 组装（可直接单测）
// ---------------------------------------------------------------------------

export type RetrievalMode = 'intent_subset' | 'full' | 'none';

export interface RetrievalScope {
  datasetIds: string[];
  mode: RetrievalMode;
}

/** 由意图命中与 Agent 知识库列表决定检索范围 */
export function resolveRetrievalScope(
  intent: IntentMatch | null,
  datasets: { datasetId: string; weight: number }[],
): RetrievalScope {
  if (intent?.datasetId) return { datasetIds: [intent.datasetId], mode: 'intent_subset' };
  if (datasets.length > 0) return { datasetIds: datasets.map((d) => d.datasetId), mode: 'full' };
  return { datasetIds: [], mode: 'none' };
}

export type ResponsePlan =
  | { kind: 'direct'; template: string }
  | { kind: 'llm' }
  | { kind: 'workflow'; workflowId: string | null };

/** 由意图策略决定本轮响应的执行方式 */
export function resolveResponsePlan(intent: IntentMatch | null): ResponsePlan {
  if (!intent) return { kind: 'llm' };
  switch (intent.strategy) {
    case 'direct':
      if (intent.responseTemplate && intent.responseTemplate.trim().length > 0) {
        return { kind: 'direct', template: intent.responseTemplate };
      }
      return { kind: 'llm' };
    case 'workflow':
      return { kind: 'workflow', workflowId: intent.workflowId };
    default:
      return { kind: 'llm' };
  }
}

/** 把检索命中格式化为知识上下文文本 */
export function formatRetrievalContext(hits: RetrievalHitView[]): string {
  if (hits.length === 0) return '';
  const lines = hits.map((h, i) => {
    const doc = typeof h.metadata?.documentName === 'string' ? h.metadata.documentName : '未知文档';
    return `${i + 1}. [${doc}] ${h.content}`;
  });
  return `[知识库检索结果]\n${lines.join('\n')}`;
}

export interface BuildPromptInput {
  systemPrompt: string | null;
  intent: IntentMatch | null;
  context: string;
  history: ChatMessage[];
  query: string;
}

/** 组装 LLM 消息序列：system（系统提示 + 意图话术 + 知识上下文）+ 历史 + 当前问题 */
export function buildAgentPrompt(input: BuildPromptInput): ChatMessage[] {
  const parts: string[] = [];
  if (input.systemPrompt?.trim()) parts.push(input.systemPrompt.trim());
  if (input.intent) {
    parts.push(`[当前意图] ${input.intent.name}`);
    if (input.intent.responseTemplate?.trim()) {
      parts.push(`[意图话术] ${input.intent.responseTemplate.trim()}`);
    }
  }
  if (input.context.trim()) parts.push(input.context.trim());

  const messages: ChatMessage[] = [];
  const system = parts.join('\n\n');
  if (system.length > 0) messages.push({ role: 'system', content: system });
  messages.push(...input.history);
  messages.push({ role: 'user', content: input.query });
  return messages;
}

/**
 * 把工作流运行结果转换为对话回复文本。
 * 优先取常见输出字段名（answer/output/text/content/result）中的字符串；
 * 只有一个值取该值；否则整体 JSON 序列化。
 */
export function workflowOutputText(outputs: Record<string, unknown>): string {
  const prefer = ['answer', 'output', 'text', 'content', 'result'];
  for (const key of prefer) {
    const value = outputs[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  const values = Object.values(outputs).filter((v) => v !== undefined && v !== null);
  if (values.length === 1) return JSON.stringify(values[0]);
  if (values.length > 1) return JSON.stringify(outputs);
  return '';
}

// ---------------------------------------------------------------------------
// 纯逻辑：workflowInputs 组装 + 步骤号提取（可直接单测）
// ---------------------------------------------------------------------------

/** $extract 提取标记的键名：{ "$extract": "number" } 表示从用户 query 解析步骤号 */
export const WORKFLOW_EXTRACT_KEY = '$extract';

/** 中文数字 1-10（含大写/两 的兼容写法）到数值的映射 */
const CN_STEP_NUM: Record<string, number> = {
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
  十: 10,
  两: 2,
  壹: 1,
  贰: 2,
  叁: 3,
  肆: 4,
  伍: 5,
  陆: 6,
  柒: 7,
  捌: 8,
  玖: 9,
  拾: 10,
};

/** 步骤号候选字符：中文数字或 1-2 位阿拉伯数字 */
const STEP_CN = '[一二三四五六七八九十两壹贰叁肆伍陆柒捌玖拾]';

/** 依次尝试精确匹配「深入第N / 第N步 / 步骤N / 第N」，命中即返回（第一个落在合法区间的结果） */
const STEP_PATTERNS: RegExp[] = [
  new RegExp(`深入第\\s*(${STEP_CN}|\\d{1,2})`),
  new RegExp(`第\\s*(${STEP_CN}|\\d{1,2})\\s*步`),
  new RegExp(`步骤\\s*(${STEP_CN}|\\d{1,2})`),
  new RegExp(`第\\s*(${STEP_CN}|\\d{1,2})`),
];

/** 把捕获到的「中文数字 / 阿拉伯数字」解析为 [1,10] 的步数；不在区间返回 null */
function parseStepNumber(raw: string): number | null {
  if (/^\d+$/.test(raw)) {
    const n = Number(raw);
    return n >= 1 && n <= 10 ? n : null;
  }
  const n = CN_STEP_NUM[raw];
  return n !== undefined && n >= 1 && n <= 10 ? n : null;
}

/**
 * 从用户 query 解析步骤号（tag 为提取器类别，当前仅支持 'number'）。
 * 支持「第N步 / 步骤N / 深入第N / 第N」下的中文数字或阿拉伯数字，N ∈ [1,10]；
 * 解析不到或越界返回 null（调用方据此省略该键，不传给工作流）。
 */
export function extractStepFromQuery(query: string, tag: 'number' = 'number'): number | null {
  if (!query || tag !== 'number') return null;
  for (const pattern of STEP_PATTERNS) {
    const match = query.match(pattern);
    if (match?.[1] !== undefined) {
      const n = parseStepNumber(match[1]);
      if (n !== null) return n;
    }
  }
  return null;
}

function isExtractMarker(value: unknown): value is { $extract: string } {
  if (typeof value !== 'object' || value === null) return false;
  const marker = (value as { $extract?: unknown }).$extract;
  return typeof marker === 'string';
}

export interface BuildWorkflowInputInput {
  query: string;
  /** 意图配置的额外输入（主体为固定值；$extract 标记则从 query 提取） */
  workflowInputs?: Record<string, unknown>;
  /** 可选：序列化后的会话历史（缺省不传） */
  history?: string;
}

/**
 * 构造工作流触发输入：base = { query }，再并入 workflowInputs。
 *  - 固定值：直接写入；
 *  - { "$extract": "number" }：用 extractStepFromQuery 从 query 解析步骤号，失败则省略该键；
 *  - 未知提取器 / 解析失败：省略该键（不传给工作流）。
 */
export function buildWorkflowInput(input: BuildWorkflowInputInput): Record<string, unknown> {
  const out: Record<string, unknown> = { query: input.query };
  if (input.history !== undefined && input.history.length > 0) out.history = input.history;
  if (!input.workflowInputs) return out;
  for (const [key, value] of Object.entries(input.workflowInputs)) {
    if (isExtractMarker(value)) {
      if (value.$extract === 'number') {
        const step = extractStepFromQuery(input.query, value.$extract);
        if (step !== null) out[key] = step;
      }
      continue;
    }
    out[key] = value;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 运行时依赖
// ---------------------------------------------------------------------------

export interface TurnInput {
  agentId: string;
  sessionId?: string;
  query: string;
  temperature?: number;
  maxTokens?: number;
  topK?: number;
}

export interface TurnMeta {
  conversationId: string;
  sessionId: string;
  agentId: string;
  intent: AgentIntentHit | null;
  retrievedDatasets: string[];
  /** 回答引用的知识库命中切片（固定检索路径在此回传） */
  citations: RetrievalHitView[];
}

export interface AgentRuntimeDeps {
  isMock: () => boolean;
  loadAgent: (agentId: string) => Promise<AgentRuntimeContext>;
  classifyIntent: (query: string, ctx: AgentRuntimeContext) => Promise<IntentMatch | null>;
  /** 混合检索；rerankModelId 由调用方传入（Agent 绑定的重排模型，可为空） */
  retrieve: (
    query: string,
    datasetIds: string[],
    topK: number,
    rerankModelId?: string | null,
  ) => Promise<RetrievalResult>;
  chatStream: (
    messages: ChatMessage[],
    opts: { temperature?: number; maxTokens?: number },
    ctx: AgentRuntimeContext,
  ) => AsyncIterable<ModelStreamEvent>;
  /** 执行已发布工作流（strategy=workflow 命中时调用） */
  runWorkflow: (workflowId: string, inputs: Record<string, unknown>) => Promise<WorkflowRunResult>;
  /** 工具装配：把 Agent 配置的工具名解析为可用工具数组（缺省走 ToolRegistry + isEnabled 过滤） */
  resolveTools?: (ctx: AgentRuntimeContext) => Tool[];
  /** 工具执行器（缺省走 ToolRegistry：校验参数 → run，异常归一为 error outcome 降级） */
  runTool?: (
    name: string,
    args: Record<string, unknown>,
    toolCtx: ToolContext,
  ) => Promise<ToolRunOutcome>;
  /** 工具循环最大轮数（缺省 env.AGENT_TOOL_MAX_ROUNDS） */
  toolLoopMaxRounds?: number;
  conversation: Pick<
    typeof conversationStore,
    'getOrCreate' | 'loadHistory' | 'saveMessage' | 'findConversation'
  >;
}

// ---------------------------------------------------------------------------
// 默认实现
// ---------------------------------------------------------------------------

/** 构建工具执行上下文：注入 Agent 信息与本地检索实现（local_retrieval 依赖） */
export function defaultToolContext(ctx: AgentRuntimeContext): ToolContext {
  return {
    agent: { agentId: ctx.agentId, rerankModelId: ctx.rerankModelId, datasets: ctx.datasets },
    retrieve: (query: string, datasetIds: string[], topK: number, rerankModelId?: string | null) =>
      hybridRetrieve({ query, datasetIds, topK, rffK: 60, rerankModelId }),
  };
}

/**
 * 默认工具执行器：按名取工具 → Zod 参数校验 → run。
 * 任何异常（未注册 / 参数非法 / 执行失败）归一为 error outcome（降级不中断循环）。
 */
export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  toolCtx: ToolContext,
): Promise<ToolRunOutcome> {
  const startedAt = Date.now();
  const tool = getTool(name);
  if (!tool) {
    return {
      name,
      args,
      status: 'error',
      latencyMs: Date.now() - startedAt,
      error: `工具未注册: ${name}`,
    };
  }
  try {
    const parsed = tool.parameters.parse(args);
    const result = await tool.run(parsed, toolCtx);
    return {
      name,
      args,
      status: 'success',
      latencyMs: Date.now() - startedAt,
      text: result.text,
      data: result.data,
    };
  } catch (err) {
    return {
      name,
      args,
      status: 'error',
      latencyMs: Date.now() - startedAt,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function defaultDeps(): AgentRuntimeDeps {
  const isMock = () => process.env.MOCK_MODELS === 'true';
  return {
    isMock,
    loadAgent: (agentId) => agentStore.loadRuntime(agentId),
    classifyIntent: async (query, ctx) => {
      const service = createIntentService({
        isMock,
        classify: async (prompt) => {
          // 真实模式：用 Agent 绑定模型做意图分类（mock 模式走确定性匹配，不会到达这里）
          const result = await completeWithFallback(ctx.modelChain, {
            messages: [{ role: 'user', content: prompt }],
          });
          return result.content;
        },
      });
      return service.classify(query, ctx.intents);
    },
    retrieve: async (query, datasetIds, topK, rerankModelId) =>
      hybridRetrieve({ query, datasetIds, topK, rffK: 60, rerankModelId }),
    chatStream: async function* (messages, opts, ctx) {
      yield* chatStreamWithFallback(ctx.modelChain, {
        messages,
        temperature: opts.temperature,
        maxTokens: opts.maxTokens,
        stream: true,
      });
    },
    runWorkflow: (workflowId, inputs) => executeWorkflow(workflowId, inputs),
    resolveTools: (ctx) => assembleTools(ctx.tools, defaultToolContext(ctx)),
    runTool: executeTool,
    conversation: conversationStore,
  };
}

function toIntentHit(intent: IntentMatch | null): AgentIntentHit {
  if (!intent) return { intentId: null, name: null, strategy: null };
  return { intentId: intent.intentId, name: intent.name, strategy: intent.strategy };
}

function historyMessages(history: { role: string; content: string }[]): ChatMessage[] {
  return history
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));
}

// ---------------------------------------------------------------------------
// 运行时
// ---------------------------------------------------------------------------

export interface AgentRuntime {
  /** 流式单轮：依次产出 meta → delta* → usage → done（或 error） */
  streamTurn(input: TurnInput): AsyncIterable<AgentStreamEvent>;
  /** 一次性单轮：聚合流为完整结果 */
  chatOnce(input: TurnInput): Promise<AgentChatResult>;
}

/**
 * 构造 Agent 运行时。deps 缺省接真实存储/模型网关；测试可注入 stub。
 */
export function createAgentRuntime(deps?: Partial<AgentRuntimeDeps>): AgentRuntime {
  const d: AgentRuntimeDeps = { ...defaultDeps(), ...deps };

  async function* streamTurn(input: TurnInput): AsyncIterable<AgentStreamEvent> {
    const ctx = await d.loadAgent(input.agentId);

    // 1) 意图识别
    const intent = await d.classifyIntent(input.query, ctx);

    // 2) 响应计划（先于检索：direct 话术无需检索，避免浪费一次混合检索）
    const plan = resolveResponsePlan(intent);

    // 3) 工具循环开关：绑定工具且响应为 LLM 生成（direct/workflow 意图维持既有直达路径，不进工具循环）
    const toolEnabled = ctx.tools.length > 0 && plan.kind === 'llm';

    // 4) 检索范围（direct 直达话术 / workflow 自带检索节点 → 不检索）
    //    工具模式下不做固定检索（LLM 自主决定是否调 local_retrieval），
    //    retrievedDatasets 表达「可检索范围」= Agent 绑定的知识库
    const scope =
      plan.kind === 'direct' || plan.kind === 'workflow'
        ? { datasetIds: [], mode: 'none' as const }
        : toolEnabled
          ? { datasetIds: ctx.datasets.map((d) => d.datasetId), mode: 'full' as const }
          : resolveRetrievalScope(intent, ctx.datasets);

    // 5) 混合检索（非工具模式、范围内非空时；Agent 绑定 rerank 模型则传入开启重排）
    const retrieval =
      !toolEnabled && scope.datasetIds.length > 0
        ? await d.retrieve(input.query, scope.datasetIds, input.topK ?? 6, ctx.rerankModelId)
        : null;

    // 6) 会话与记忆
    const conv = await d.conversation.getOrCreate(ctx.agentId, input.sessionId);
    const history = historyMessages(await d.conversation.loadHistory(conv.conversationId, 10));
    await d.conversation.saveMessage({
      conversationId: conv.conversationId,
      agentId: ctx.agentId,
      role: 'user',
      content: input.query,
    });

    const meta: TurnMeta = {
      conversationId: conv.conversationId,
      sessionId: conv.sessionId,
      agentId: ctx.agentId,
      intent: toIntentHit(intent),
      retrievedDatasets: scope.datasetIds,
      citations: retrieval?.hits ?? [],
    };
    yield { type: 'meta', ...meta };

    // 6) direct 话术直达（不调用 LLM）
    if (plan.kind === 'direct') {
      yield { type: 'delta', content: plan.template };
      yield { type: 'usage', inputTokens: 0, outputTokens: 0, model: ctx.model.name };
      await d.conversation.saveMessage({
        conversationId: conv.conversationId,
        agentId: ctx.agentId,
        role: 'assistant',
        content: plan.template,
      });
      yield { type: 'done', createdAt: new Date().toISOString() };
      return;
    }

    // 7) workflow 意图 → 执行关联工作流（不再回退「LLM + 话术」，输出作为本轮回复）
    if (plan.kind === 'workflow') {
      if (!plan.workflowId) {
        const message = '该意图配置为 workflow 策略但未绑定工作流，请先在 Agent 配置中关联工作流';
        await d.conversation.saveMessage({
          conversationId: conv.conversationId,
          agentId: ctx.agentId,
          role: 'assistant',
          content: '(工作流未配置)',
          error: message,
        });
        yield { type: 'error', code: 'WORKFLOW_NOT_CONFIGURED', message };
        return;
      }
      let content = '';
      let runError: string | null = null;
      try {
        // 从装配好的候选意图读取 workflowInputs（识别命中只返回意图标识，额外输入向上取候选）
        const matched = ctx.intents.find((c) => c.intentId === intent?.intentId);
        const workflowInput = buildWorkflowInput({
          query: input.query,
          workflowInputs: matched?.workflowInputs,
        });
        const run = await d.runWorkflow(plan.workflowId, workflowInput);
        if (run.status === 'failed') {
          runError = run.error ?? '工作流执行失败';
        } else {
          content = workflowOutputText(run.outputs);
        }
      } catch (err) {
        runError = err instanceof Error ? err.message : String(err);
      }
      if (runError) {
        await d.conversation.saveMessage({
          conversationId: conv.conversationId,
          agentId: ctx.agentId,
          role: 'assistant',
          content: '(工作流执行失败)',
          error: runError,
        });
        yield { type: 'error', code: 'WORKFLOW_EXECUTION_ERROR', message: runError };
        return;
      }
      await d.conversation.saveMessage({
        conversationId: conv.conversationId,
        agentId: ctx.agentId,
        role: 'assistant',
        content,
      });
      if (content.length > 0) yield { type: 'delta', content };
      yield { type: 'usage', inputTokens: 0, outputTokens: 0 };
      yield { type: 'done', createdAt: new Date().toISOString() };
      return;
    }

    // 8) 工具循环：绑定工具的 Agent 由 LLM 自主决定是否调用工具（含 local_retrieval 替代固定检索分支）
    if (toolEnabled) {
      const toolCtx = defaultToolContext(ctx);
      const tools = d.resolveTools ? d.resolveTools(ctx) : assembleTools(ctx.tools, toolCtx);
      // 收集 local_retrieval 成功命中，用于「引用溯源」透出
      const citations: RetrievalHitView[] = [];
      const runToolWithCitations = async (
        name: string,
        args: Record<string, unknown>,
        tctx: ToolContext,
      ): Promise<ToolRunOutcome> => {
        const outcome = await (d.runTool ? d.runTool(name, args, tctx) : executeTool(name, args, tctx));
        if (
          name === 'local_retrieval' &&
          outcome.status === 'success' &&
          Array.isArray((outcome.data as { hits?: unknown } | undefined)?.hits)
        ) {
          citations.push(...((outcome.data as { hits: RetrievalHitView[] }).hits));
        }
        return outcome;
      };
      const loop = createToolCallLoop({
        complete: async (prompt) => {
          const result = await completeWithFallback(ctx.modelChain, {
            messages: [{ role: 'user', content: prompt }],
          });
          return { content: result.content, model: result.model, usage: result.usage };
        },
        runTool: runToolWithCitations,
        isMock: d.isMock,
        maxRounds: d.toolLoopMaxRounds,
      });
      const loopResult = await loop.runToolCallLoop({
        query: input.query,
        systemPrompt: ctx.systemPrompt,
        intentName: intent?.name ?? null,
        history,
        tools,
        ctx: toolCtx,
      });

      // 透出每次工具调用（tool_call 事件）
      for (const oc of loopResult.toolCalls) {
        yield {
          type: 'tool_call',
          name: oc.name,
          args: oc.args,
          status: oc.status,
          latencyMs: oc.latencyMs,
        };
      }
      // 最终答语以 delta 流式透出（非流式 LLM 一次性产出完整文本；保证 chatOnce/SSE 均可见）
      if (loopResult.content.length > 0) {
        yield { type: 'delta', content: loopResult.content };
      }
      await d.conversation.saveMessage({
        conversationId: conv.conversationId,
        agentId: ctx.agentId,
        role: 'assistant',
        content: loopResult.content,
        tokenCount: loopResult.usage?.outputTokens ?? 0,
        usage: loopResult.usage ? { ...loopResult.usage } : null,
      });
      // 引用溯源：工具模式下 local_retrieval 命中在 meta 之后产生，单独补发 citations 事件
      if (citations.length > 0) yield { type: 'citations', citations };
      yield {
        type: 'usage',
        inputTokens: loopResult.usage?.inputTokens ?? 0,
        outputTokens: loopResult.usage?.outputTokens ?? 0,
        model: ctx.model.name,
      };
      yield { type: 'done', createdAt: new Date().toISOString() };
      return;
    }

    // 9) 组装 prompt + 调用 LLM（retrieval 生成）—— 非工具模式既有路径
    const messages = buildAgentPrompt({
      systemPrompt: ctx.systemPrompt,
      intent,
      context: formatRetrievalContext(retrieval?.hits ?? []),
      history,
      query: input.query,
    });

    const startedAt = Date.now();
    let content = '';
    let usage: { inputTokens: number; outputTokens: number } | undefined;
    for await (const evt of d.chatStream(
      messages,
      { temperature: input.temperature, maxTokens: input.maxTokens },
      ctx,
    )) {
      switch (evt.type) {
        case 'delta':
          content += evt.content;
          yield evt;
          break;
        case 'usage':
          usage = { inputTokens: evt.inputTokens, outputTokens: evt.outputTokens };
          yield { ...evt, model: ctx.model.name };
          break;
        case 'done':
          break; // 统一在落库后发送
        case 'error': {
          await d.conversation.saveMessage({
            conversationId: conv.conversationId,
            agentId: ctx.agentId,
            role: 'assistant',
            content: content || '(生成失败)',
            error: evt.message,
          });
          yield { type: 'error', code: evt.code, message: evt.message };
          return;
        }
      }
    }
    const latencyMs = Date.now() - startedAt;
    await d.conversation.saveMessage({
      conversationId: conv.conversationId,
      agentId: ctx.agentId,
      role: 'assistant',
      content,
      tokenCount: usage?.outputTokens ?? 0,
      usage: usage ? { ...usage } : null,
      latencyMs,
    });
    yield {
      type: 'usage',
      inputTokens: usage?.inputTokens ?? 0,
      outputTokens: usage?.outputTokens ?? 0,
      model: ctx.model.name,
    };
    yield { type: 'done', createdAt: new Date().toISOString() };
  }

  async function chatOnce(input: TurnInput): Promise<AgentChatResult> {
    let meta: TurnMeta | undefined;
    let citations: RetrievalHitView[] | undefined;
    let content = '';
    let usage: { inputTokens: number; outputTokens: number } | undefined;
    let model: string | undefined;
    let createdAt: string | undefined;
    let toolCalls: AgentToolCall[] | undefined;
    for await (const evt of streamTurn(input)) {
      switch (evt.type) {
        case 'meta':
          // meta 事件在运行时携带 citations（固定检索路径），此处从事件对象读取
          meta = evt as unknown as TurnMeta;
          citations = meta.citations;
          break;
        case 'citations':
          citations = evt.citations;
          break;
        case 'delta':
          content += evt.content;
          break;
        case 'tool_call':
          toolCalls = toolCalls ?? [];
          toolCalls.push({
            name: evt.name,
            args: evt.args,
            status: evt.status,
            latencyMs: evt.latencyMs,
          });
          break;
        case 'usage':
          usage = { inputTokens: evt.inputTokens, outputTokens: evt.outputTokens };
          model = evt.model;
          break;
        case 'done':
          createdAt = evt.createdAt;
          break;
        case 'error':
          throw new AppError(evt.message, evt.code, 502);
      }
    }
    if (!meta) throw new AppError('Agent 编排未产生会话元数据', 'INTERNAL_ERROR', 500);
    return {
      conversationId: meta.conversationId,
      sessionId: meta.sessionId,
      agentId: meta.agentId,
      intent: meta.intent,
      retrievedDatasets: meta.retrievedDatasets,
      citations,
      content,
      model,
      usage,
      toolCalls,
      createdAt: createdAt ?? new Date().toISOString(),
    };
  }

  return { streamTurn, chatOnce };
}

/** 供编排层复用：IntentMatch 判空辅助 */
export function hasIntent(intent: IntentMatch | null): intent is IntentMatch {
  return intent !== null;
}

export type { IntentCandidate };

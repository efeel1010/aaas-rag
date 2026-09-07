/**
 * M4 Agent 运行时（会话编排）单测 —— 纯逻辑装配 + streamTurn/chatOnce 注入式编排。
 *
 * 覆盖：
 *  - resolveRetrievalScope / resolveResponsePlan / formatRetrievalContext / buildAgentPrompt 纯函数；
 *  - streamTurn 事件序列（meta→delta→usage→done）与记忆落库；
 *  - direct 意图直接返回话术、不调 LLM；
 *  - 检索范围正确传递、prompt 携带知识上下文；
 *  - chatOnce 聚合为完整结果。
 */
import { describe, expect, it, vi } from 'vitest';
import type { AgentRuntimeContext } from '../../src/services/agent-store.js';
import type { IntentMatch } from '../../src/services/intent-service.js';
import type { IntentCandidate } from '../../src/services/intent-service.js';
import type {
  ChatMessage,
  ConversationMessage,
  ModelStreamEvent,
  RetrievalResult,
  WorkflowRunResult,
} from '@pulse/contracts';
import {
  buildAgentPrompt,
  buildWorkflowInput,
  createAgentRuntime,
  extractStepFromQuery,
  formatRetrievalContext,
  resolveResponsePlan,
  resolveRetrievalScope,
  workflowOutputText,
} from '../../src/services/agent-runtime.js';
import { localRetrievalTool } from '../../src/lib/tools/implementations.js';
import type { Tool, ToolContext, ToolRunOutcome } from '../../src/lib/tools/types.js';

const UUID = '00000000-0000-0000-0000-000000000000';
const AGENT_ID = '11111111-1111-1111-1111-111111111111';
const MODEL_ID = '22222222-2222-2222-2222-222222222222';
const DS_ID = '33333333-3333-3333-3333-333333333333';
const CONV_ID = '44444444-4444-4444-4444-444444444444';
const SESSION = 'session-1';

// ---------------------------------------------------------------------------
// 装配辅助
// ---------------------------------------------------------------------------

function runtimeCtx(overrides: Partial<AgentRuntimeContext> = {}): AgentRuntimeContext {
  return {
    agentId: AGENT_ID,
    name: '客服助手',
    systemPrompt: '你是客服助手',
    modelId: MODEL_ID,
    rerankModelId: null,
    tools: [],
    provider: { id: UUID, type: 'openai', name: 'mock', config: null, credentials: {} },
    model: { id: MODEL_ID, name: 'mock-llm', modelType: 'llm', config: null },
    modelChain: [
      { provider: { id: UUID, type: 'openai', name: 'mock', config: null, credentials: {} }, model: { id: MODEL_ID, name: 'mock-llm', modelType: 'llm', config: null } },
    ],
    datasets: [],
    intents: [],
    ...overrides,
  };
}

function intentMatch(overrides: Partial<IntentMatch> = {}): IntentMatch {
  return {
    intentId: UUID,
    name: '退货',
    strategy: 'retrieval',
    responseTemplate: null,
    workflowId: null,
    datasetId: null,
    score: 3,
    matchedBy: 'mock',
    ...overrides,
  };
}

function intentCandidate(overrides: Partial<IntentCandidate> = {}): IntentCandidate {
  return {
    intentId: UUID,
    name: '退货',
    description: null,
    examples: [],
    strategy: 'retrieval',
    responseTemplate: null,
    workflowId: null,
    datasetId: null,
    priority: 0,
    ...overrides,
  };
}

function retrievalResult(overrides: Partial<RetrievalResult> = {}): RetrievalResult {
  return {
    query: '怎么退货',
    datasetIds: [DS_ID],
    topK: 6,
    total: 1,
    hits: [
      {
        chunkId: UUID,
        documentId: UUID,
        datasetId: DS_ID,
        content: '本店商品支持7天无理由退货',
        tokens: 8,
        metadata: { documentName: '售后政策.md' },
        score: 0.9,
        vectorScore: 0.9,
        keywordScore: null,
        source: 'vector',
      },
    ],
    ...overrides,
  };
}

function conversationStub() {
  return {
    getOrCreate: vi.fn(async () => ({ conversationId: CONV_ID, sessionId: SESSION })),
    loadHistory: vi.fn(async (): Promise<ConversationMessage[]> => []),
    saveMessage: vi.fn(
      async (input: {
        conversationId: string;
        agentId: string;
        role: 'user' | 'assistant';
        content: string;
      }): Promise<ConversationMessage> => ({
        id: UUID,
        conversationId: input.conversationId,
        role: input.role,
        content: input.content,
        status: 'complete',
        usage: null,
        tokenCount: 0,
        error: null,
        createdAt: new Date().toISOString(),
      }),
    ),
    findConversation: vi.fn(),
  };
}

type ChatStreamFn = (
  messages: ChatMessage[],
  opts: { temperature?: number; maxTokens?: number },
  ctx: AgentRuntimeContext,
) => AsyncIterable<ModelStreamEvent>;

function runtimeStubs(
  opts: {
    ctx?: AgentRuntimeContext;
    classifyIntent?: (query: string, ctx: AgentRuntimeContext) => Promise<IntentMatch | null>;
    retrieve?: (
      query: string,
      datasetIds: string[],
      topK: number,
      rerankModelId?: string | null,
    ) => Promise<RetrievalResult>;
    chatStream?: ChatStreamFn;
    runWorkflow?: (
      workflowId: string,
      inputs: Record<string, unknown>,
    ) => Promise<WorkflowRunResult>;
    resolveTools?: (ctx: AgentRuntimeContext) => Tool[];
    runTool?: (
      name: string,
      args: Record<string, unknown>,
      toolCtx: ToolContext,
    ) => Promise<ToolRunOutcome>;
  } = {},
) {
  const conversation = conversationStub();
  const loadAgent = vi.fn(async () => opts.ctx ?? runtimeCtx());
  const classifyIntent = vi.fn(
    opts.classifyIntent ??
      (async (_query: string, _ctx: AgentRuntimeContext): Promise<IntentMatch | null> =>
        intentMatch()),
  );
  const retrieve = vi.fn(
    opts.retrieve ??
      (async (
        _query: string,
        _datasetIds: string[],
        _topK: number,
        _rerankModelId?: string | null,
      ): Promise<RetrievalResult> => retrievalResult()),
  );
  const chatStream = vi.fn(
    opts.chatStream ??
      async function* (
        _messages: ChatMessage[],
        _opts: { temperature?: number; maxTokens?: number },
        _ctx: AgentRuntimeContext,
      ): AsyncIterable<ModelStreamEvent> {
        yield { type: 'delta', content: '根据知识库，' };
        yield { type: 'delta', content: '支持7天无理由退货。' };
        yield { type: 'usage', inputTokens: 12, outputTokens: 5 };
        yield { type: 'done' };
      },
  );
  const runWorkflow = vi.fn(
    opts.runWorkflow ??
      (async (
        _workflowId: string,
        _inputs: Record<string, unknown>,
      ): Promise<WorkflowRunResult> => ({
        runId: UUID,
        workflowId: UUID,
        status: 'success',
        inputs: { query: 'x' },
        outputs: { answer: '工作流输出：7天无理由退货' },
        nodeResults: [],
        error: null,
        createdAt: new Date().toISOString(),
        durationMs: 1,
      })),
  );
  // 工具执行默认 stub：避免落入真实 hybridRetrieve / 外网 fetch
  const runTool = vi.fn(
    opts.runTool ??
      (async (name: string, args: Record<string, unknown>): Promise<ToolRunOutcome> => ({
        name,
        args,
        status: 'success',
        latencyMs: 1,
        text: `${name} 命中：支持7天无理由退货`,
        data: {
          hits: [{ content: '支持7天无理由退货', metadata: { documentName: '售后政策.md' } }],
        },
      })),
  );
  const runtime = createAgentRuntime({
    isMock: () => true,
    loadAgent,
    classifyIntent,
    retrieve,
    chatStream,
    runWorkflow,
    resolveTools: opts.resolveTools,
    runTool,
    conversation,
  });
  return {
    runtime,
    loadAgent,
    classifyIntent,
    retrieve,
    chatStream,
    runWorkflow,
    runTool,
    conversation,
  };
}

/** 收集 streamTurn 全部事件（含 async generator 终止） */
async function collect(stream: AsyncIterable<{ type: string }>): Promise<{ type: string }[]> {
  const events: { type: string }[] = [];
  for await (const evt of stream) events.push(evt);
  return events;
}

// ---------------------------------------------------------------------------
// 纯函数：检索范围
// ---------------------------------------------------------------------------

describe('resolveRetrievalScope', () => {
  it('命中意图且带知识库子集 → intent_subset 单库', () => {
    const scope = resolveRetrievalScope(intentMatch({ datasetId: DS_ID }), []);
    expect(scope).toEqual({ datasetIds: [DS_ID], mode: 'intent_subset' });
  });

  it('未命中但 Agent 绑定了知识库 → full 全库', () => {
    const scope = resolveRetrievalScope(null, [{ datasetId: DS_ID, weight: 100 }]);
    expect(scope).toEqual({ datasetIds: [DS_ID], mode: 'full' });
  });

  it('意图无子集时回退 Agent 全库（dataset 列表参与）', () => {
    const scope = resolveRetrievalScope(intentMatch(), [{ datasetId: DS_ID, weight: 200 }]);
    expect(scope.mode).toBe('full');
    expect(scope.datasetIds).toEqual([DS_ID]);
  });

  it('两者皆无 → none 空检索', () => {
    expect(resolveRetrievalScope(null, [])).toEqual({ datasetIds: [], mode: 'none' });
  });
});

// ---------------------------------------------------------------------------
// 纯函数：响应计划
// ---------------------------------------------------------------------------

describe('resolveResponsePlan', () => {
  it('未命中 → llm', () => {
    expect(resolveResponsePlan(null)).toEqual({ kind: 'llm' });
  });

  it('direct 且带话术 → 直接返回，不调 LLM', () => {
    expect(
      resolveResponsePlan(intentMatch({ strategy: 'direct', responseTemplate: '已为您登记' })),
    ).toEqual({
      kind: 'direct',
      template: '已为您登记',
    });
  });

  it('direct 但话术为空 → 降级 llm', () => {
    expect(
      resolveResponsePlan(intentMatch({ strategy: 'direct', responseTemplate: '  ' })),
    ).toEqual({
      kind: 'llm',
    });
  });

  it('workflow → 触发关联工作流（携带 workflowId）', () => {
    expect(resolveResponsePlan(intentMatch({ strategy: 'workflow', workflowId: UUID }))).toEqual({
      kind: 'workflow',
      workflowId: UUID,
    });
  });

  it('retrieval / 默认 → llm 生成', () => {
    expect(resolveResponsePlan(intentMatch({ strategy: 'retrieval' }))).toEqual({ kind: 'llm' });
  });
});

// ---------------------------------------------------------------------------
// 纯函数：知识上下文 / prompt 组装
// ---------------------------------------------------------------------------

describe('formatRetrievalContext', () => {
  it('无命中 → 空串', () => {
    expect(formatRetrievalContext([])).toBe('');
  });

  it('命中 → 带文档名的编号列表', () => {
    const text = formatRetrievalContext(retrievalResult().hits);
    expect(text).toContain('[知识库检索结果]');
    expect(text).toContain('1. [售后政策.md]');
    expect(text).toContain('7天无理由退货');
  });

  it('metadata 缺文档名 → 未知文档兜底', () => {
    const text = formatRetrievalContext([{ ...retrievalResult().hits[0]!, metadata: null }]);
    expect(text).toContain('[未知文档]');
  });
});

describe('buildAgentPrompt', () => {
  const history: ChatMessage[] = [
    { role: 'user', content: '上一问' },
    { role: 'assistant', content: '上一答' },
  ];

  it('system 携带 系统提示 + 意图名 + 知识上下文；历史在前、当前问题在尾', () => {
    const messages = buildAgentPrompt({
      systemPrompt: '你是客服助手',
      intent: intentMatch({ name: '退货', responseTemplate: '已登记' }),
      context: '[知识库检索结果]...',
      history,
      query: '怎么退货',
    });
    expect(messages[0]?.role).toBe('system');
    expect(messages[0]?.content).toContain('你是客服助手');
    expect(messages[0]?.content).toContain('[当前意图] 退货');
    expect(messages[0]?.content).toContain('[意图话术] 已登记');
    expect(messages[0]?.content).toContain('[知识库检索结果]');
    expect(messages[1]).toEqual({ role: 'user', content: '上一问' });
    expect(messages[2]).toEqual({ role: 'assistant', content: '上一答' });
    expect(messages[messages.length - 1]).toEqual({ role: 'user', content: '怎么退货' });
  });

  it('无系统提示/无意图/无上下文 → 仅用户消息', () => {
    const messages = buildAgentPrompt({
      systemPrompt: null,
      intent: null,
      context: '',
      history: [],
      query: 'hi',
    });
    expect(messages).toEqual([{ role: 'user', content: 'hi' }]);
  });
});

// ---------------------------------------------------------------------------
// 编排：streamTurn
// ---------------------------------------------------------------------------

describe('streamTurn 编排', () => {
  it('direct 意图：meta→delta(话术)→usage→done，不调用检索与 LLM，双消息落库', async () => {
    const { runtime, retrieve, chatStream, conversation } = runtimeStubs({
      classifyIntent: async () =>
        intentMatch({ strategy: 'direct', responseTemplate: '已为您登记售后' }),
    });
    const events = await collect(
      runtime.streamTurn({ agentId: AGENT_ID, sessionId: SESSION, query: '怎么退货' }),
    );

    expect(events.map((e) => e.type)).toEqual(['meta', 'delta', 'usage', 'done']);
    expect(events[1]).toMatchObject({ type: 'delta', content: '已为您登记售后' });
    // direct 直达话术：不检索（meta 检索范围为 []）、不调 LLM
    expect(events[0]).toMatchObject({ type: 'meta', retrievedDatasets: [] });
    expect(retrieve).not.toHaveBeenCalled();
    expect(chatStream).not.toHaveBeenCalled();
    expect(conversation.saveMessage).toHaveBeenCalledTimes(2);
    const roles = conversation.saveMessage.mock.calls.map((c) => c[0]?.role);
    expect(roles).toEqual(['user', 'assistant']);
  });

  it('retrieval 意图：检索传递意图子集，prompt 带知识上下文，LLM 流式累加并落库', async () => {
    const { runtime, retrieve, chatStream, conversation } = runtimeStubs({
      ctx: runtimeCtx({ datasets: [{ datasetId: DS_ID, datasetName: '商品库', weight: 100 }] }),
      classifyIntent: async () => intentMatch({ datasetId: DS_ID }),
    });

    const events = await collect(
      runtime.streamTurn({ agentId: AGENT_ID, sessionId: SESSION, query: '怎么退货', topK: 3 }),
    );

    // 检索范围：意图子集 DS_ID（Agent 未绑定 rerank 模型 → 第 4 参为 null）
    expect(retrieve).toHaveBeenCalledWith('怎么退货', [DS_ID], 3, null);
    // 事件序列：meta → delta×2 → usage×2 → done
    expect(events[0]).toMatchObject({ type: 'meta', intent: { intentId: UUID } });
    expect(events.filter((e) => e.type === 'delta').length).toBe(2);
    // LLM 消息：system 含知识上下文，尾部为用户 query
    const chatMessages = chatStream.mock.calls[0]?.[0] as ChatMessage[] | undefined;
    expect(chatMessages?.[0]?.role).toBe('system');
    expect(chatMessages?.[0]?.content).toContain('7天无理由退货');
    expect(chatMessages?.[chatMessages.length - 1]).toEqual({ role: 'user', content: '怎么退货' });
    // 双消息落库
    expect(conversation.saveMessage).toHaveBeenCalledTimes(2);
    const assistantCall = conversation.saveMessage.mock.calls[1]?.[0];
    expect(assistantCall).toMatchObject({ role: 'assistant', tokenCount: 5 });
  });

  it('无意图 + 无知识库：检索为空，纯 LLM 生成', async () => {
    const { runtime, retrieve } = runtimeStubs({
      ctx: runtimeCtx({ datasets: [], intents: [] }),
      classifyIntent: async () => null,
    });
    const events = await collect(runtime.streamTurn({ agentId: AGENT_ID, query: '随便聊聊' }));
    expect(retrieve).not.toHaveBeenCalled();
    expect(events[0]).toMatchObject({ type: 'meta', retrievedDatasets: [] });
    expect(events.some((e) => e.type === 'done')).toBe(true);
  });

  it('Agent 绑定 rerank 模型 → 检索第 4 参透传 rerankModelId', async () => {
    const { runtime, retrieve } = runtimeStubs({
      ctx: runtimeCtx({
        datasets: [{ datasetId: DS_ID, datasetName: '商品库', weight: 100 }],
        rerankModelId: MODEL_ID,
      }),
      classifyIntent: async () => null, // 全库检索
    });
    await collect(runtime.streamTurn({ agentId: AGENT_ID, query: '怎么退货', topK: 4 }));
    expect(retrieve).toHaveBeenCalledWith('怎么退货', [DS_ID], 4, MODEL_ID);
  });

  it('LLM 流中 error → 落库 failed 消息并产出 error 事件', async () => {
    const { runtime, conversation } = runtimeStubs({
      chatStream: async function* (
        _messages: ChatMessage[],
        _opts: { temperature?: number; maxTokens?: number },
        _ctx: AgentRuntimeContext,
      ): AsyncIterable<ModelStreamEvent> {
        yield { type: 'error', code: 'UPSTREAM', message: '上游超时' };
      },
    });
    const events = await collect(runtime.streamTurn({ agentId: AGENT_ID, query: 'x' }));
    expect(events[events.length - 1]).toMatchObject({ type: 'error', code: 'UPSTREAM' });
    const failed = conversation.saveMessage.mock.calls[1]?.[0];
    expect(failed).toMatchObject({ role: 'assistant', error: '上游超时' });
  });
});

// ---------------------------------------------------------------------------
// 编排：chatOnce
// ---------------------------------------------------------------------------

describe('chatOnce 聚合', () => {
  it('聚合流式结果为完整 AgentChatResult（含意图/检索范围/用量）', async () => {
    const { runtime } = runtimeStubs({
      ctx: runtimeCtx({ datasets: [{ datasetId: DS_ID, datasetName: '商品库', weight: 100 }] }),
      classifyIntent: async () => intentMatch({ datasetId: DS_ID }),
    });
    const result = await runtime.chatOnce({
      agentId: AGENT_ID,
      sessionId: SESSION,
      query: '怎么退货',
    });
    expect(result.agentId).toBe(AGENT_ID);
    expect(result.sessionId).toBe(SESSION);
    expect(result.conversationId).toBe(CONV_ID);
    expect(result.content).toContain('7天无理由退货');
    expect(result.intent).toMatchObject({ intentId: UUID, strategy: 'retrieval' });
    expect(result.retrievedDatasets).toEqual([DS_ID]);
    expect(result.usage).toEqual({ inputTokens: 12, outputTokens: 5 });
    expect(result.model).toBe('mock-llm');
    expect(typeof result.createdAt).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// 纯函数：工作流输出 → 对话回复文本
// ---------------------------------------------------------------------------

describe('workflowOutputText', () => {
  it('优先取常见输出字段名中的字符串', () => {
    expect(workflowOutputText({ answer: '回答' })).toBe('回答');
    expect(workflowOutputText({ foo: 'a', content: '正文', bar: 'b' })).toBe('正文');
  });

  it('仅一个值取该值；多值 JSON 序列化；空输出返回空串', () => {
    expect(workflowOutputText({ only: 'x' })).toBe('"x"');
    expect(workflowOutputText({ a: 1, b: 2 })).toBe('{"a":1,"b":2}');
    expect(workflowOutputText({})).toBe('');
  });
});

// ---------------------------------------------------------------------------
// 纯函数：步骤号提取（workflowInputs 的 $extract:number 支持）
// ---------------------------------------------------------------------------

describe('extractStepFromQuery', () => {
  it('「第N步」阿拉伯数字与中文数字均命中', () => {
    expect(extractStepFromQuery('请深入分析第3步')).toBe(3);
    expect(extractStepFromQuery('请解释一下第三步的结论')).toBe(3);
  });

  it('「步骤N / 深入第N / 第N」形态命中', () => {
    expect(extractStepFromQuery('按照步骤5执行')).toBe(5);
    expect(extractStepFromQuery('深入第7层分析')).toBe(7);
    expect(extractStepFromQuery('先看第2')).toBe(2);
  });

  it('中文数字 1-10 全覆盖（一到十）', () => {
    const cn = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
    cn.forEach((word, i) => {
      expect(extractStepFromQuery(`第${word}步`)).toBe(i + 1);
    });
  });

  it('越界（0 / 11）→ null；非步骤数字不误命中', () => {
    expect(extractStepFromQuery('第0步')).toBeNull();
    expect(extractStepFromQuery('第11步')).toBeNull();
    expect(extractStepFromQuery('一共50个步骤')).toBeNull();
    expect(extractStepFromQuery('完全没有数字')).toBeNull();
  });

  it('空 query / 非 number 提取器 → null', () => {
    expect(extractStepFromQuery('  ')).toBeNull();
    expect(extractStepFromQuery('')).toBeNull();
    // @ts-expect-error 类型层面仅允许 number，此处验证非 number 类别时保守返回 null
    expect(extractStepFromQuery('第3步', 123)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 纯函数：工作流输入组装（固定值 + $extract 提取 + 失败省略）
// ---------------------------------------------------------------------------

describe('buildWorkflowInput', () => {
  it('无 workflowInputs → 仅 { query }', () => {
    expect(buildWorkflowInput({ query: '怎么退货' })).toEqual({ query: '怎么退货' });
  });

  it('固定值直接并入（如 { step: 5 }）', () => {
    const out = buildWorkflowInput({ query: '深入分析', workflowInputs: { step: 5 } });
    expect(out).toEqual({ query: '深入分析', step: 5 });
  });

  it('$extract:number 从 query 解析步骤号填充该键', () => {
    const out = buildWorkflowInput({
      query: '请深入第三层分析',
      workflowInputs: { step: { $extract: 'number' } },
    });
    expect(out).toEqual({ query: '请深入第三层分析', step: 3 });
  });

  it('提取失败 → 省略该键（不传给工作流），其余键保留', () => {
    const out = buildWorkflowInput({
      query: '继续深入',
      workflowInputs: { step: { $extract: 'number' }, level: 'hard' },
    });
    expect(out).toEqual({ query: '继续深入', level: 'hard' });
    expect(out).not.toHaveProperty('step');
  });

  it('未知提取器 → 省略该键；$extract 非字符串不当作标记', () => {
    const out = buildWorkflowInput({
      query: '任意',
      workflowInputs: { bad: { $extract: 'unsupported' }, kept: { $extract: 3 } },
    });
    expect(out).toEqual({ query: '任意', kept: { $extract: 3 } });
  });

  it('history 非空时透传 history 键', () => {
    const out = buildWorkflowInput({
      query: 'q',
      workflowInputs: { step: 2 },
      history: '前轮会话',
    });
    expect(out).toEqual({ query: 'q', history: '前轮会话', step: 2 });
  });
});

// ---------------------------------------------------------------------------
// 编排：workflow 策略
// ---------------------------------------------------------------------------

describe('streamTurn workflow 策略', () => {
  it('命中 workflow 意图：调用 runWorkflow({ query })，工作流输出作为 delta 回复并落库', async () => {
    const { runtime, runWorkflow, retrieve, chatStream, conversation } = runtimeStubs({
      classifyIntent: async () => intentMatch({ strategy: 'workflow', workflowId: UUID }),
    });
    const events = await collect(
      runtime.streamTurn({ agentId: AGENT_ID, sessionId: SESSION, query: '怎么退货' }),
    );

    // workflow 自带检索节点 → Agent 层不检索、不调 LLM
    expect(events.map((e) => e.type)).toEqual(['meta', 'delta', 'usage', 'done']);
    expect(events[0]).toMatchObject({
      type: 'meta',
      intent: { strategy: 'workflow' },
      retrievedDatasets: [],
    });
    expect(retrieve).not.toHaveBeenCalled();
    expect(chatStream).not.toHaveBeenCalled();
    // 以 query 作为工作流输入
    expect(runWorkflow).toHaveBeenCalledWith(UUID, { query: '怎么退货' });
    expect(events[1]).toMatchObject({ type: 'delta', content: '工作流输出：7天无理由退货' });
    // 双消息落库（user + assistant 工作流输出）
    expect(conversation.saveMessage).toHaveBeenCalledTimes(2);
    expect(conversation.saveMessage.mock.calls[1]?.[0]).toMatchObject({
      role: 'assistant',
      content: '工作流输出：7天无理由退货',
    });
  });

  it('workflow 意图带固定值 workflowInputs：触发工作流时与 { query } 合并透传', async () => {
    const { runtime, runWorkflow } = runtimeStubs({
      ctx: runtimeCtx({
        intents: [intentCandidate({ workflowInputs: { step: 5, lang: 'zh' } })],
      }),
      classifyIntent: async () => intentMatch({ strategy: 'workflow', workflowId: UUID }),
    });
    await collect(runtime.streamTurn({ agentId: AGENT_ID, query: '深入分析' }));
    expect(runWorkflow).toHaveBeenCalledWith(UUID, { query: '深入分析', step: 5, lang: 'zh' });
  });

  it('workflow 意图带 $extract:number：从 query 解析步骤号传给工作流', async () => {
    const { runtime, runWorkflow } = runtimeStubs({
      ctx: runtimeCtx({
        intents: [intentCandidate({ workflowInputs: { step: { $extract: 'number' } } })],
      }),
      classifyIntent: async () => intentMatch({ strategy: 'workflow', workflowId: UUID }),
    });
    await collect(runtime.streamTurn({ agentId: AGENT_ID, query: '请深入第三层继续分析' }));
    expect(runWorkflow).toHaveBeenCalledWith(UUID, { query: '请深入第三层继续分析', step: 3 });
  });

  it('workflow 意图 $extract 提取失败：省略该键，仅透传 { query }（不传给工作流）', async () => {
    const { runtime, runWorkflow } = runtimeStubs({
      ctx: runtimeCtx({
        intents: [intentCandidate({ workflowInputs: { step: { $extract: 'number' } } })],
      }),
      classifyIntent: async () => intentMatch({ strategy: 'workflow', workflowId: UUID }),
    });
    await collect(runtime.streamTurn({ agentId: AGENT_ID, query: '没有步骤的继续深入' }));
    expect(runWorkflow).toHaveBeenCalledWith(UUID, { query: '没有步骤的继续深入' });
    expect(runWorkflow.mock.calls[0]?.[1]).not.toHaveProperty('step');
  });

  it('chatOnce 聚合 workflow 回复（带固定值 workflowInputs 透传）', async () => {
    const { runtime, runWorkflow } = runtimeStubs({
      ctx: runtimeCtx({
        intents: [intentCandidate({ workflowInputs: { step: 5 } })],
      }),
      classifyIntent: async () => intentMatch({ strategy: 'workflow', workflowId: UUID }),
    });
    const result = await runtime.chatOnce({
      agentId: AGENT_ID,
      sessionId: SESSION,
      query: '深入分析',
    });
    expect(result.content).toBe('工作流输出：7天无理由退货');
    expect(runWorkflow).toHaveBeenCalledWith(UUID, { query: '深入分析', step: 5 });
  });

  it('workflow 执行失败（run.status=failed）→ error 事件，不回退 LLM', async () => {
    const { runtime, chatStream, conversation } = runtimeStubs({
      classifyIntent: async () => intentMatch({ strategy: 'workflow', workflowId: UUID }),
      runWorkflow: async () => ({
        runId: UUID,
        workflowId: UUID,
        status: 'failed',
        inputs: {},
        outputs: {},
        nodeResults: [],
        error: 'LLM 节点上游超时',
        createdAt: new Date().toISOString(),
        durationMs: 10,
      }),
    });
    const events = await collect(runtime.streamTurn({ agentId: AGENT_ID, query: 'x' }));
    expect(events[events.length - 1]).toMatchObject({
      type: 'error',
      code: 'WORKFLOW_EXECUTION_ERROR',
      message: 'LLM 节点上游超时',
    });
    expect(chatStream).not.toHaveBeenCalled();
    expect(conversation.saveMessage.mock.calls[1]?.[0]).toMatchObject({
      role: 'assistant',
      error: 'LLM 节点上游超时',
    });
  });

  it('workflow 执行抛异常 → error 事件', async () => {
    const { runtime } = runtimeStubs({
      classifyIntent: async () => intentMatch({ strategy: 'workflow', workflowId: UUID }),
      runWorkflow: async () => {
        throw new Error('工作流不存在');
      },
    });
    const events = await collect(runtime.streamTurn({ agentId: AGENT_ID, query: 'x' }));
    expect(events[events.length - 1]).toMatchObject({
      type: 'error',
      code: 'WORKFLOW_EXECUTION_ERROR',
      message: '工作流不存在',
    });
  });

  it('workflow 意图未绑定工作流 → error（不静默降级 LLM）', async () => {
    const { runtime, chatStream, conversation } = runtimeStubs({
      classifyIntent: async () => intentMatch({ strategy: 'workflow', workflowId: null }),
    });
    const events = await collect(runtime.streamTurn({ agentId: AGENT_ID, query: 'x' }));
    expect(events[events.length - 1]).toMatchObject({
      type: 'error',
      code: 'WORKFLOW_NOT_CONFIGURED',
    });
    expect(chatStream).not.toHaveBeenCalled();
    expect(conversation.saveMessage.mock.calls[1]?.[0]).toMatchObject({
      role: 'assistant',
      error: expect.stringContaining('未绑定工作流'),
    });
  });

  it('chatOnce 聚合 workflow 回复', async () => {
    const { runtime } = runtimeStubs({
      classifyIntent: async () => intentMatch({ strategy: 'workflow', workflowId: UUID }),
    });
    const result = await runtime.chatOnce({
      agentId: AGENT_ID,
      sessionId: SESSION,
      query: '怎么退货',
    });
    expect(result.content).toBe('工作流输出：7天无理由退货');
    expect(result.intent).toMatchObject({ strategy: 'workflow' });
    expect(result.retrievedDatasets).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 编排差异：绑定工具 vs 未绑定工具（M-A ReAct 工具循环）
// ---------------------------------------------------------------------------

describe('streamTurn 工具循环编排差异', () => {
  const toolQuery = '请检索知识库中的退货政策';
  const toolCtx = runtimeCtx({
    tools: ['local_retrieval'],
    datasets: [{ datasetId: DS_ID, datasetName: '商品库', weight: 100 }],
  });

  it('绑定工具：进入工具循环 —— 不执行固定检索、产出 tool_call 事件、LLM 生成被工具循环取代', async () => {
    const { runtime, retrieve, chatStream, runTool, conversation } = runtimeStubs({
      ctx: toolCtx,
      resolveTools: () => [localRetrievalTool],
      classifyIntent: async () => null, // 未命中意图 → llm 类 → 工具循环
    });
    const events = await collect(runtime.streamTurn({ agentId: AGENT_ID, query: toolQuery }));

    // 固定检索被跳过（local_retrieval 由 LLM 自主决定是否调用）
    expect(retrieve).not.toHaveBeenCalled();
    // 工具循环调用 local_retrieval（mock 决策命中本地检索关键词）
    expect(runTool).toHaveBeenCalledWith(
      'local_retrieval',
      { query: toolQuery },
      expect.anything(),
    );
    // 事件序列：meta → tool_call → usage → done（无 delta，因为工具结果直接作为答语）
    const types = events.map((e) => e.type);
    expect(types).toContain('tool_call');
    expect(types[types.length - 1]).toBe('done');
    const toolCallEvent = events.find((e) => e.type === 'tool_call');
    expect(toolCallEvent).toMatchObject({ name: 'local_retrieval', status: 'success' });
    // meta 检索范围为 Agent 可检索知识库
    expect(events[0]).toMatchObject({ type: 'meta', retrievedDatasets: [DS_ID] });
    // 未走原 chatStream（工具循环接管生成）
    expect(chatStream).not.toHaveBeenCalled();
    // 双消息落库（user + assistant 工具循环答语）
    expect(conversation.saveMessage).toHaveBeenCalledTimes(2);
  });

  it('chatOnce 聚合工具循环结果：toolCalls 透出（name/args/status/latencyMs）', async () => {
    const { runtime } = runtimeStubs({
      ctx: toolCtx,
      resolveTools: () => [localRetrievalTool],
      classifyIntent: async () => null,
    });
    const result = await runtime.chatOnce({
      agentId: AGENT_ID,
      sessionId: SESSION,
      query: toolQuery,
    });
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls?.[0]).toMatchObject({ name: 'local_retrieval', status: 'success' });
    expect(result.toolCalls?.[0]).toHaveProperty('latencyMs');
    expect(result.retrievedDatasets).toEqual([DS_ID]);
    // mock finalize 基于工具返回的 hits 组装答语（含来源标注）
    expect(result.content).toContain('来源：本地知识库');
    expect(result.content).toContain('支持7天无理由退货');
  });

  it('未绑定工具：维持原直线编排 —— 走固定检索 + chatStream，且不产生 tool_call 事件', async () => {
    const { runtime, retrieve, chatStream, runTool } = runtimeStubs({
      ctx: runtimeCtx({
        tools: [],
        datasets: [{ datasetId: DS_ID, datasetName: '商品库', weight: 100 }],
      }),
      classifyIntent: async () => null, // 全库检索
    });
    const events = await collect(
      runtime.streamTurn({ agentId: AGENT_ID, query: toolQuery, topK: 4 }),
    );
    expect(retrieve).toHaveBeenCalledWith(toolQuery, [DS_ID], 4, null);
    expect(chatStream).toHaveBeenCalledTimes(1);
    expect(runTool).not.toHaveBeenCalled();
    expect(events.some((e) => e.type === 'tool_call')).toBe(false);
    expect(events.filter((e) => e.type === 'delta').length).toBe(2);
  });

  it('绑定工具但命中 direct 意图：仍走直答话术（不进工具循环）', async () => {
    const { runtime, retrieve, runTool, chatStream } = runtimeStubs({
      ctx: toolCtx,
      resolveTools: () => [localRetrievalTool],
      classifyIntent: async () =>
        intentMatch({ strategy: 'direct', responseTemplate: '已为您登记售后' }),
    });
    const events = await collect(runtime.streamTurn({ agentId: AGENT_ID, query: '怎么退货' }));
    expect(events.map((e) => e.type)).toEqual(['meta', 'delta', 'usage', 'done']);
    expect(events[1]).toMatchObject({ type: 'delta', content: '已为您登记售后' });
    expect(retrieve).not.toHaveBeenCalled();
    expect(runTool).not.toHaveBeenCalled();
    expect(chatStream).not.toHaveBeenCalled();
    expect(events.some((e) => e.type === 'tool_call')).toBe(false);
  });

  it('绑定工具但 query 无需工具：工具循环不调用工具，仍产出完整答语（mock 兜底）', async () => {
    const { runtime, runTool } = runtimeStubs({
      ctx: toolCtx,
      resolveTools: () => [localRetrievalTool],
      classifyIntent: async () => null,
    });
    const result = await runtime.chatOnce({ agentId: AGENT_ID, query: '你好' });
    expect(runTool).not.toHaveBeenCalled();
    expect(result.toolCalls).toBeUndefined();
    expect(result.content).toContain('未能获取到相关资料');
  });
});

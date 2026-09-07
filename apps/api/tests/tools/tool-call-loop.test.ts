/**
 * M-A ReAct 工具循环单测 —— 决策 prompt / 结构化解析 / mock 确定性决策 /
 * 主循环（单轮、多轮、超限收敛、失败降级、LLM 决策通道）。
 */
import { describe, expect, it, vi } from 'vitest';
import { httpRequestTool, localRetrievalTool } from '../../src/lib/tools/implementations.js';
import { openAlexSearchTool } from '../../src/lib/tools/openalex.js';
import type { ToolContext, ToolRunOutcome } from '../../src/lib/tools/types.js';
import {
  buildToolDecisionPrompt,
  buildToolFinalPrompt,
  createToolCallLoop,
  deterministicFinalize,
  deterministicToolDecision,
  parseToolDecision,
  toolManifest,
} from '../../src/services/tool-call-loop.js';

const DS_ID = '33333333-3333-3333-3333-333333333333';

const ctx: ToolContext = {
  agent: {
    agentId: 'a',
    rerankModelId: null,
    datasets: [{ datasetId: DS_ID, datasetName: '商品库', weight: 100 }],
  },
  retrieve: async () => ({
    query: 'x',
    datasetIds: [DS_ID],
    topK: 6,
    total: 1,
    hits: [
      {
        chunkId: '11111111-1111-1111-1111-111111111111',
        documentId: '22222222-2222-2222-2222-222222222222',
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
  }),
};

function okOutcome(name: string, args: Record<string, unknown>): ToolRunOutcome {
  return { name, args, status: 'success', latencyMs: 3, text: `${name} 结果`, data: { ok: true } };
}

function errOutcome(name: string, args: Record<string, unknown>): ToolRunOutcome {
  return { name, args, status: 'error', latencyMs: 2, error: 'boom' };
}

// ---------------------------------------------------------------------------
// 决策 / 收尾 prompt 与工具清单
// ---------------------------------------------------------------------------

describe('toolManifest / buildToolDecisionPrompt', () => {
  it('toolManifest 列出工具名、描述与参数清单', () => {
    const manifest = toolManifest([localRetrievalTool, httpRequestTool]);
    expect(manifest).toContain('local_retrieval');
    expect(manifest).toContain('http_request');
    expect(manifest).toContain('query');
    expect(manifest).toContain('topK');
    expect(manifest).toContain('url');
  });

  it('决策 prompt 携带系统提示、工具清单、历史、已有工具结果与轮数', () => {
    const prompt = buildToolDecisionPrompt({
      systemPrompt: '你是知识助手',
      intentName: '政策咨询',
      history: [{ role: 'user', content: '上一问' }],
      tools: [localRetrievalTool],
      toolContext: ['[工具调用 1] local_retrieval {"query":"x"} → 结果'],
      query: '退货政策',
      round: 1,
      maxRounds: 3,
    });
    expect(prompt).toContain('你是知识助手');
    expect(prompt).toContain('local_retrieval');
    expect(prompt).toContain('[当前意图] 政策咨询');
    expect(prompt).toContain('user: 上一问');
    expect(prompt).toContain('[工具结果]');
    expect(prompt).toContain('用户问题：退货政策');
    expect(prompt).toContain('（第 2/3 轮）');
  });

  it('收尾 prompt 携带工具结果与强制收敛提示', () => {
    const prompt = buildToolFinalPrompt({
      systemPrompt: '你是知识助手',
      query: '退货政策',
      toolContext: ['local_retrieval 结果'],
      forced: true,
    });
    expect(prompt).toContain('标注来源');
    expect(prompt).toContain('[工具结果]');
    expect(prompt).toContain('已到达最大工具轮数');
  });
});

// ---------------------------------------------------------------------------
// 结构化决策解析
// ---------------------------------------------------------------------------

describe('parseToolDecision', () => {
  it('解析 tools 决策（单/多工具，args 缺省为 {}）', () => {
    const d = parseToolDecision('{"tools":[{"name":"local_retrieval","args":{"query":"x"}}]}');
    expect(d).toEqual({ kind: 'tools', calls: [{ name: 'local_retrieval', args: { query: 'x' } }] });

    const multi = parseToolDecision(
      '{"tools":[{"name":"a","args":{}},{"name":"b","args":{"k":1}}]}',
    );
    expect(multi?.kind).toBe('tools');
    if (multi?.kind === 'tools') expect(multi.calls).toHaveLength(2);
  });

  it('解析 answer 决策', () => {
    const d = parseToolDecision('{"answer":"直接回答"}');
    expect(d).toEqual({ kind: 'answer', content: '直接回答' });
  });

  it('容忍 markdown 代码块包裹与前后缀文本', () => {
    const d = parseToolDecision('```json\n{"tools":[{"name":"a","args":{}}]}\n```');
    expect(d?.kind).toBe('tools');
    const d2 = parseToolDecision('好的，我来处理。{"answer":"完成"}');
    expect(d2).toEqual({ kind: 'answer', content: '完成' });
  });

  it('非法 / 空 tools / 非字符串 answer → null', () => {
    expect(parseToolDecision('not json')).toBeNull();
    expect(parseToolDecision('{"tools":[]}')).toBeNull();
    expect(parseToolDecision('{"tools":[{"name":""}]}')).toBeNull();
    expect(parseToolDecision('{"answer":123}')).toBeNull();
    expect(parseToolDecision('')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Mock 模式：确定性决策 / 收尾
// ---------------------------------------------------------------------------

describe('deterministicToolDecision', () => {
  const tools = [localRetrievalTool, httpRequestTool];

  it('query 命中本地检索关键词 → 选择 local_retrieval', () => {
    const d = deterministicToolDecision({ query: '请检索知识库中的退货政策', tools, priorOutcomes: [] });
    expect(d).toEqual({ kind: 'tools', calls: [{ name: 'local_retrieval', args: { query: '请检索知识库中的退货政策' } }] });
  });

  it('query 含 URL / 外部关键词 → 选择 http_request（提取 URL）', () => {
    const d = deterministicToolDecision({ query: '帮我用 openalex 查一下 https://api.openalex.org/works 上的论文', tools, priorOutcomes: [] });
    expect(d?.kind).toBe('tools');
    if (d?.kind === 'tools') {
      expect(d.calls[0]?.name).toBe('http_request');
      expect(d.calls[0]?.args).toMatchObject({ url: 'https://api.openalex.org/works' });
    }
  });

  it('每个工具至多调用一次（已调用过 → 不再选择，保证收敛）', () => {
    const prior = [okOutcome('local_retrieval', {})];
    const d = deterministicToolDecision({ query: '检索知识库', tools, priorOutcomes: prior });
    expect(d).toBeNull();
  });

  it('query 无工具关键词 → 不需要工具（null）', () => {
    expect(deterministicToolDecision({ query: '你好呀', tools, priorOutcomes: [] })).toBeNull();
  });
});

describe('deterministicToolDecision（openalex_search）', () => {
  it('绑定 openalex_search 且 query 命中学术关键词 → 选择 openalex_search', () => {
    const d = deterministicToolDecision({
      query: '帮我查一下大语言模型相关的学术论文',
      tools: [localRetrievalTool, httpRequestTool, openAlexSearchTool],
      priorOutcomes: [],
    });
    expect(d).toEqual({
      kind: 'tools',
      calls: [{ name: 'openalex_search', args: { query: '帮我查一下大语言模型相关的学术论文' } }],
    });
  });

  it('学术关键词优先于本地检索关键词（「论文」优先于「检索」）', () => {
    const d = deterministicToolDecision({
      query: '检索一下关于检索增强生成的学术论文',
      tools: [localRetrievalTool, openAlexSearchTool],
      priorOutcomes: [],
    });
    expect(d?.kind).toBe('tools');
    if (d?.kind === 'tools') expect(d.calls[0]?.name).toBe('openalex_search');
  });

  it('openalex 已调用过 → 不再选择（保证收敛）', () => {
    const prior = [okOutcome('openalex_search', { query: 'x' })];
    expect(
      deterministicToolDecision({ query: '查论文', tools: [openAlexSearchTool], priorOutcomes: prior }),
    ).toBeNull();
  });
});

describe('deterministicFinalize', () => {
  it('本地检索成功 → 组装来源标注 + 获取时间的最终答语', () => {
    const outcome: ToolRunOutcome = {
      name: 'local_retrieval',
      args: { query: '退货' },
      status: 'success',
      latencyMs: 3,
      text: '命中',
      data: {
        total: 1,
        hits: [{ content: '支持7天无理由退货', metadata: { documentName: '售后政策.md' } }],
      },
    };
    const text = deterministicFinalize({ query: '退货', toolContext: ['hit'], outcomes: [outcome] });
    expect(text).toContain('来源：本地知识库');
    expect(text).toContain('获取时间：');
    expect(text).toContain('7天无理由退货');
    expect(text).toContain('[售后政策.md]');
  });

  it('无工具结果 → 兜底文案', () => {
    const text = deterministicFinalize({ query: 'x', toolContext: [], outcomes: [] });
    expect(text).toContain('未能获取到相关资料');
  });

  it('openalex 检索成功 → 组装来源标注 + 获取时间 + 论文列表', () => {
    const outcome: ToolRunOutcome = {
      name: 'openalex_search',
      args: { query: '大语言模型' },
      status: 'success',
      latencyMs: 3,
      text: '命中',
      data: {
        query: '大语言模型',
        total: 2,
        fetchedAt: '2026-01-01T00:00:00.000Z',
        works: [
          {
            title: 'Survey of LLM',
            abstract: null,
            publication_year: 2024,
            authors: ['Alice', 'Bob'],
            cited_by_count: 10,
            source: 'Journal of AI',
            doi: '10.x/survey',
            open_access_url: null,
          },
        ],
      },
    };
    const text = deterministicFinalize({ query: '大语言模型', toolContext: ['hit'], outcomes: [outcome] });
    expect(text).toContain('来源：OpenAlex 实时数据');
    expect(text).toContain('获取时间：2026-01-01T00:00:00.000Z');
    expect(text).toContain('Survey of LLM');
    expect(text).toContain('Alice, Bob');
    expect(text).toContain('被引 10 次');
  });
});

// ---------------------------------------------------------------------------
// 主循环：Mock 模式
// ---------------------------------------------------------------------------

describe('runToolCallLoop（mock 模式）', () => {
  function mockLoop(opts: { maxRounds?: number; runTool?: typeof okOutcome } = {}) {
    const runTool = vi.fn(
      (name: string, args: Record<string, unknown>) =>
        Promise.resolve((opts.runTool ?? okOutcome)(name, args)),
    );
    const loop = createToolCallLoop({
      complete: vi.fn(async () => {
        throw new Error('mock 模式不应调用 LLM complete');
      }),
      runTool,
      isMock: () => true,
      maxRounds: opts.maxRounds,
    });
    return { loop, runTool };
  }

  it('绑定 local_retrieval：提问命中关键词 → 调用工具 → 结果含 toolCalls 与来源标注', async () => {
    const { loop, runTool } = mockLoop();
    const result = await loop.runToolCallLoop({
      query: '请检索知识库中的退货政策',
      systemPrompt: '你是知识助手',
      intentName: '政策咨询',
      history: [],
      tools: [localRetrievalTool],
      ctx,
    });
    expect(runTool).toHaveBeenCalledTimes(1);
    expect(runTool).toHaveBeenCalledWith('local_retrieval', { query: '请检索知识库中的退货政策' }, ctx);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]).toMatchObject({ name: 'local_retrieval', status: 'success' });
    expect(result.content).toContain('local_retrieval 结果');
    expect(result.forced).toBe(false);
  });

  it('无需工具：不调用任何工具，走兜底 finalize', async () => {
    const { loop, runTool } = mockLoop();
    const result = await loop.runToolCallLoop({
      query: '你好',
      systemPrompt: null,
      intentName: null,
      history: [],
      tools: [localRetrievalTool],
      ctx,
    });
    expect(runTool).not.toHaveBeenCalled();
    expect(result.toolCalls).toEqual([]);
    expect(result.content).toContain('未能获取到相关资料');
  });

  it('多轮：local_retrieval → http_request → 收敛 finalize', async () => {
    const { loop, runTool } = mockLoop();
    const result = await loop.runToolCallLoop({
      query: '请检索知识库，并调用 https://api.example.com/data 查询实时信息',
      systemPrompt: null,
      intentName: null,
      history: [],
      tools: [localRetrievalTool, httpRequestTool],
      ctx,
    });
    const names = runTool.mock.calls.map((c) => c[0] as string);
    expect(names).toEqual(['local_retrieval', 'http_request']);
    expect(result.toolCalls).toHaveLength(2);
    expect(result.forced).toBe(false);
  });

  it('绑定 openalex_search：提问命中学术关键词 → 触发工具 → 答语带来源标注', async () => {
    const runTool = vi.fn(async (name: string, args: Record<string, unknown>) => ({
      name,
      args,
      status: 'success' as const,
      latencyMs: 3,
      text: 'openalex_search 结果',
      data: {
        query: '大语言模型',
        total: 1,
        fetchedAt: '2026-01-01T00:00:00.000Z',
        works: [
          {
            title: 'Survey of LLM',
            abstract: null,
            publication_year: 2024,
            authors: ['Alice'],
            cited_by_count: 10,
            source: 'Journal of AI',
            doi: '10.x/survey',
            open_access_url: null,
          },
        ],
      },
    }));
    const loop = createToolCallLoop({
      complete: vi.fn(async () => {
        throw new Error('mock 模式不应调用 LLM complete');
      }),
      runTool,
      isMock: () => true,
    });
    const result = await loop.runToolCallLoop({
      query: '帮我查一下大语言模型相关的学术论文',
      systemPrompt: null,
      intentName: null,
      history: [],
      tools: [openAlexSearchTool],
      ctx,
    });
    expect(runTool).toHaveBeenCalledTimes(1);
    expect(runTool).toHaveBeenCalledWith(
      'openalex_search',
      { query: '帮我查一下大语言模型相关的学术论文' },
      ctx,
    );
    expect(result.toolCalls[0]).toMatchObject({ name: 'openalex_search', status: 'success' });
    expect(result.content).toContain('来源：OpenAlex 实时数据');
    expect(result.content).toContain('Survey of LLM');
    expect(result.forced).toBe(false);
  });

  it('超限收敛：maxRounds=1 时执行一轮工具后强制收敛', async () => {
    const { loop, runTool } = mockLoop({ maxRounds: 1 });
    const result = await loop.runToolCallLoop({
      query: '请检索知识库中的退货政策',
      systemPrompt: null,
      intentName: null,
      history: [],
      tools: [localRetrievalTool],
      ctx,
    });
    expect(runTool).toHaveBeenCalledTimes(1);
    expect(result.forced).toBe(true);
    expect(result.content).toContain('local_retrieval 结果');
  });

  it('工具失败降级：error outcome 不中断循环，最终答语包含失败信息', async () => {
    const { loop } = mockLoop({ runTool: (name, args) => errOutcome(name, args) });
    const result = await loop.runToolCallLoop({
      query: '请检索知识库中的退货政策',
      systemPrompt: null,
      intentName: null,
      history: [],
      tools: [localRetrievalTool],
      ctx,
    });
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]?.status).toBe('error');
    expect(result.content).toContain('调用失败');
  });
});

// ---------------------------------------------------------------------------
// 主循环：LLM 决策通道
// ---------------------------------------------------------------------------

describe('runToolCallLoop（LLM 决策通道）', () => {
  it('LLM 决策工具 → 执行 → 再决策 answer → 采用为最终答语', async () => {
    const complete = vi
      .fn()
      .mockResolvedValueOnce({
        content: '{"tools":[{"name":"local_retrieval","args":{"query":"退货政策"}}]}',
        model: 'mock-llm',
        usage: { inputTokens: 40, outputTokens: 6 },
      })
      .mockResolvedValueOnce({
        content: '{"answer":"根据知识库，支持7天无理由退货"}',
        model: 'mock-llm',
        usage: { inputTokens: 20, outputTokens: 4 },
      });
    const loop = createToolCallLoop({
      complete,
      runTool: async (name, args) => okOutcome(name, args),
      isMock: () => false,
      maxRounds: 3,
    });
    const result = await loop.runToolCallLoop({
      query: '退货政策',
      systemPrompt: '你是知识助手',
      intentName: null,
      history: [],
      tools: [localRetrievalTool],
      ctx,
    });
    expect(complete).toHaveBeenCalledTimes(2);
    expect(result.content).toBe('根据知识库，支持7天无理由退货');
    expect(result.toolCalls).toHaveLength(1);
    expect(result.usage).toEqual({ inputTokens: 60, outputTokens: 10 });
    expect(result.model).toBe('mock-llm');
  });

  it('LLM 首轮直接 answer：不调用工具', async () => {
    const complete = vi.fn().mockResolvedValue({ content: '{"answer":"直接回答你好"}' });
    const runTool = vi.fn();
    const loop = createToolCallLoop({
      complete,
      runTool,
      isMock: () => false,
      maxRounds: 3,
    });
    const result = await loop.runToolCallLoop({
      query: '你好',
      systemPrompt: null,
      intentName: null,
      history: [],
      tools: [localRetrievalTool],
      ctx,
    });
    expect(runTool).not.toHaveBeenCalled();
    expect(result.content).toBe('直接回答你好');
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it('决策解析失败 → 走收尾生成', async () => {
    const complete = vi
      .fn()
      .mockResolvedValueOnce({ content: 'not json at all' })
      .mockResolvedValueOnce({ content: '基于现有信息给出回答' });
    const runTool = vi.fn();
    const loop = createToolCallLoop({
      complete,
      runTool,
      isMock: () => false,
      maxRounds: 3,
    });
    const result = await loop.runToolCallLoop({
      query: '退货政策',
      systemPrompt: null,
      intentName: null,
      history: [],
      tools: [localRetrievalTool],
      ctx,
    });
    expect(runTool).not.toHaveBeenCalled();
    expect(result.content).toBe('基于现有信息给出回答');
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it('超限收敛（LLM 模式）：达到 maxRounds 后不再请求下一轮，强制收尾', async () => {
    const complete = vi.fn().mockResolvedValue({
      content: '{"tools":[{"name":"local_retrieval","args":{"query":"x"}}]}',
    });
    const loop = createToolCallLoop({
      complete,
      runTool: async (name, args) => okOutcome(name, args),
      isMock: () => false,
      maxRounds: 1,
    });
    const result = await loop.runToolCallLoop({
      query: '退货政策',
      systemPrompt: null,
      intentName: null,
      history: [],
      tools: [localRetrievalTool],
      ctx,
    });
    // maxRounds=1：决策1次（工具）+ 收尾1次
    expect(complete).toHaveBeenCalledTimes(2);
    expect(result.forced).toBe(true);
    expect(result.toolCalls).toHaveLength(1);
  });
});

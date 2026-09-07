/**
 * M-A ReAct 工具循环 —— 让 Agent 自主决定「查第三方 / 查本地 / 多轮工具」。
 *
 * 数据流（每轮 = 一次工具决策 + 一次工具执行）：
 *   LLM 决策（结构化 JSON：{ tools:[{name,args}] } 或 { answer }）→ 执行工具
 *   → 结果回填上下文（含来源标注）→ LLM 决定继续调用或生成最终答语；
 *   轮数超限（maxRounds，默认 env.AGENT_TOOL_MAX_ROUNDS=3）强制收敛到最终生成。
 *
 * 决策 / 收尾通道：
 *  - Mock 模式（MOCK_MODELS=true）：deterministicToolDecision 按 query 关键词确定性
 *    命中选择工具；deterministicFinalize 按工具结果确定性组装最终答语 —— 无外网可测。
 *  - LLM 模式：把可用工具清单（name/description/parameters）与历史、工具结果拼入
 *    决策/收尾 prompt，调用 deps.complete 完成决策与最终生成。
 *
 * 依赖注入：deps.complete（prompt→文本）/ deps.runTool（执行工具）均可替换，便于单测。
 */
import type { ChatMessage } from '@pulse/contracts';
import { env } from '../config/env.js';
import type { Tool, ToolContext, ToolRunOutcome } from '../lib/tools/types.js';
import { outcomeToText } from '../lib/tools/types.js';

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** 单次工具调用意图（LLM 决策产出） */
export interface ToolCallIntent {
  name: string;
  args: Record<string, unknown>;
}

/** 决策结果：tools=需要调用工具；answer=直接给出最终答语（仅 LLM 模式） */
export type ToolDecision =
  | { kind: 'tools'; calls: ToolCallIntent[] }
  | { kind: 'answer'; content: string };

export interface ToolCallLoopDeps {
  /** 模型补全（真实模式：模型网关 complete 封装；mock 模式注入确定性实现） */
  complete: (prompt: string) => Promise<{ content: string; model?: string; usage?: { inputTokens: number; outputTokens: number } }>;
  /** 工具执行器（由装配方从 ToolRegistry 装配；可注入 stub 做单测） */
  runTool: (name: string, args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolRunOutcome>;
  /** mock 判定；缺省读取 MOCK_MODELS */
  isMock?: () => boolean;
  /** 最大轮数；缺省读取 env.AGENT_TOOL_MAX_ROUNDS */
  maxRounds?: number;
}

export interface ToolCallLoopInput {
  query: string;
  systemPrompt: string | null;
  /** 命中意图名（拼入决策 prompt，辅助 LLM 理解当前场景） */
  intentName: string | null;
  history: ChatMessage[];
  /** 可用工具（已按 Agent 配置装配，含 isEnabled 过滤） */
  tools: Tool[];
  /** 工具执行上下文（local_retrieval 的 retrieve / http_request 的 fetch 等） */
  ctx: ToolContext;
}

export interface ToolCallLoopResult {
  content: string;
  toolCalls: ToolRunOutcome[];
  usage?: { inputTokens: number; outputTokens: number };
  model?: string;
  /** 是否因轮数超限强制收敛 */
  forced: boolean;
}

// ---------------------------------------------------------------------------
// 工具清单 / 参数描述（供 LLM 决策）
// ---------------------------------------------------------------------------

/** 把 Zod schema 描述为紧凑参数清单文本（供 LLM 决策） */
function schemaTypeName(s: unknown): string {
  const typeName = (s as { _def?: { typeName?: string } } | undefined)?._def?.typeName;
  switch (typeName) {
    case 'ZodString':
      return 'string';
    case 'ZodNumber':
      return 'number';
    case 'ZodBoolean':
      return 'boolean';
    case 'ZodArray':
      return `array<${schemaTypeName((s as { _def?: { type?: unknown } })._def?.type)}>`;
    case 'ZodEnum':
      return `enum`;
    case 'ZodObject':
      return 'object';
    default:
      return typeName?.replace(/^Zod/, '').toLowerCase() ?? 'any';
  }
}

function describeParameters(parameters: unknown): string {
  const def = (parameters as { _def?: { shape?: unknown } } | undefined)?._def;
  const shapeRaw = def?.shape;
  const shape = typeof shapeRaw === 'function' ? (shapeRaw as () => Record<string, unknown>)() : shapeRaw;
  if (!shape || typeof shape !== 'object') return '{}';
  const entries = Object.entries(shape as Record<string, unknown>);
  if (entries.length === 0) return '{}';
  return `{ ${entries
    .map(([key, schema]) => {
      const optional =
        typeof (schema as { isOptional?: () => boolean }).isOptional === 'function' &&
        (schema as { isOptional: () => boolean }).isOptional();
      return `${key}${optional ? '?' : ''}: ${schemaTypeName(schema)}`;
    })
    .join(', ')} }`;
}

/** 生成工具清单文本：name / description / parameters（供决策 prompt） */
export function toolManifest(tools: Tool[]): string {
  if (tools.length === 0) return '（无可用工具）';
  return tools
    .map((t) => `- ${t.name}：${t.description}\n  parameters: ${describeParameters(t.parameters)}`)
    .join('\n');
}

// ---------------------------------------------------------------------------
// 决策 / 收尾 prompt
// ---------------------------------------------------------------------------

function intentLine(intentName: string | null): string {
  return intentName ? `[当前意图] ${intentName}` : '';
}

function historyText(history: ChatMessage[]): string {
  if (history.length === 0) return '';
  return `[历史对话]\n${history.map((m) => `${m.role}: ${m.content}`).join('\n')}`;
}

/** 工具决策 prompt：工具清单 + 历史 + 已有工具结果 + 当前问题 */
export function buildToolDecisionPrompt(input: {
  systemPrompt: string | null;
  intentName: string | null;
  history: ChatMessage[];
  tools: Tool[];
  toolContext: string[];
  query: string;
  round: number;
  maxRounds: number;
}): string {
  const parts: string[] = [];
  if (input.systemPrompt?.trim()) parts.push(input.systemPrompt.trim());
  parts.push('你可以使用下列工具来获取回答问题所需的信息。工具清单：');
  parts.push(toolManifest(input.tools));
  parts.push(
    '判断是否需要调用工具：当问题需要本地知识库资料、外部实时数据或第三方接口时，先调用工具获取信息；' +
      '已有足够信息或无需工具时直接回答。只输出一个 JSON 对象，不要输出任何其他内容：',
  );
  parts.push(
    '  - 需要调用工具：{"tools":[{"name":"<工具名>","args":{...}}]}（可一次调用多个工具）',
  );
  parts.push('  - 可直接回答：{"answer":"<最终回答>"}');
  parts.push('最终回答必须基于工具返回结果，并标注来源与获取时间。');

  const intent = intentLine(input.intentName);
  if (intent) parts.push(intent);
  const hist = historyText(input.history);
  if (hist) parts.push(hist);
  if (input.toolContext.length > 0) {
    parts.push(`[工具结果]\n${input.toolContext.join('\n')}`);
  }
  parts.push(`用户问题：${input.query}`);
  parts.push(`（第 ${input.round + 1}/${input.maxRounds} 轮）`);
  return parts.join('\n\n');
}

/** 收尾生成 prompt：基于工具结果生成最终答语 */
export function buildToolFinalPrompt(input: {
  systemPrompt: string | null;
  query: string;
  toolContext: string[];
  forced: boolean;
}): string {
  const parts: string[] = [];
  if (input.systemPrompt?.trim()) parts.push(input.systemPrompt.trim());
  parts.push('请基于以下工具执行结果回答用户问题，标注来源（如「来源：本地知识库」「来源：第三方接口」）与获取时间。只输出回答正文。');
  if (input.toolContext.length > 0) {
    parts.push(`[工具结果]\n${input.toolContext.join('\n')}`);
  }
  if (input.forced) {
    parts.push('（已到达最大工具轮数，请基于现有工具结果直接作答，不要再尝试调用工具。）');
  }
  parts.push(`用户问题：${input.query}`);
  return parts.join('\n\n');
}

// ---------------------------------------------------------------------------
// 结构化决策解析
// ---------------------------------------------------------------------------

/** 从模型输出提取首个 JSON 对象并解析为决策；非法返回 null（走收尾生成） */
export function parseToolDecision(raw: string): ToolDecision | null {
  const text = raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  let obj: { answer?: unknown; tools?: unknown };
  try {
    obj = JSON.parse(match[0]) as { answer?: unknown; tools?: unknown };
  } catch {
    return null;
  }
  if (obj.answer !== undefined && obj.answer !== null && typeof obj.answer === 'string') {
    return { kind: 'answer', content: obj.answer };
  }
  if (Array.isArray(obj.tools)) {
    const calls: ToolCallIntent[] = [];
    for (const item of obj.tools) {
      if (!item || typeof item !== 'object') continue;
      const name = (item as { name?: unknown }).name;
      if (typeof name !== 'string' || name.length === 0) continue;
      const args = (item as { args?: unknown }).args;
      calls.push({
        name,
        args:
          args && typeof args === 'object' && !Array.isArray(args)
            ? (args as Record<string, unknown>)
            : {},
      });
    }
    if (calls.length > 0) return { kind: 'tools', calls };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Mock 模式：确定性决策 / 收尾
// ---------------------------------------------------------------------------

const LOCAL_KEYWORDS = ['知识库', '资料', '文档', '检索', '查找', '搜索', '根据', '政策', '售后', '信息', '内容', '规则'];
const OPENALEX_KEYWORDS = ['论文', '学术', '文献', 'openalex', 'doi', '引用数', '被引', '研究'];
const HTTP_KEYWORDS = ['实时', '外部', 'http', 'api', '数据接口'];

/**
 * Mock 模式工具决策：根据 query 关键词确定性命中选择工具；无需工具/已取过该工具则返回 null（走收尾）。
 * 每个工具每轮循环至多调用一次，保证循环可收敛、无外网可测。
 */
export function deterministicToolDecision(input: {
  query: string;
  tools: Tool[];
  priorOutcomes: ToolRunOutcome[];
}): ToolDecision | null {
  const { query, tools, priorOutcomes } = input;
  const q = query.trim().toLowerCase();
  const hasTool = (name: string) => tools.some((t) => t.name === name);
  const called = (name: string) => priorOutcomes.some((o) => o.name === name);

  if (hasTool('openalex_search') && !called('openalex_search')) {
    if (OPENALEX_KEYWORDS.some((k) => q.includes(k))) {
      return { kind: 'tools', calls: [{ name: 'openalex_search', args: { query } }] };
    }
  }
  if (hasTool('local_retrieval') && !called('local_retrieval')) {
    if (LOCAL_KEYWORDS.some((k) => q.includes(k))) {
      return { kind: 'tools', calls: [{ name: 'local_retrieval', args: { query } }] };
    }
  }
  if (hasTool('http_request') && !called('http_request')) {
    if (HTTP_KEYWORDS.some((k) => q.includes(k))) {
      const urlMatch = q.match(/https?:\/\/[^\s，。]+/);
      return {
        kind: 'tools',
        calls: [
          {
            name: 'http_request',
            args: { url: urlMatch?.[0] ?? 'https://example.com/data.json', timeoutMs: 3000 },
          },
        ],
      };
    }
  }
  return null;
}

/** Mock 模式收尾：基于工具结果确定性组装最终答语（含来源标注与获取时间） */
export function deterministicFinalize(input: {
  query: string;
  toolContext: string[];
  outcomes: ToolRunOutcome[];
}): string {
  const now = new Date().toISOString();
  const retrievalOutcome = input.outcomes.find(
    (o) => o.name === 'local_retrieval' && o.status === 'success',
  );
  if (retrievalOutcome?.data && typeof retrievalOutcome.data === 'object') {
    const data = retrievalOutcome.data as { total?: number; hits?: { content: string; metadata?: Record<string, unknown> | null }[] };
    const hits = data.hits ?? [];
    if (hits.length > 0) {
      const lines = hits.map((h, i) => {
        const doc = typeof h.metadata?.documentName === 'string' ? h.metadata.documentName : '未知文档';
        return `${i + 1}. [${doc}] ${h.content}`;
      });
      return `根据本地知识库资料，检索到以下相关信息：\n${lines.join('\n')}\n（来源：本地知识库 · 获取时间：${now}）`;
    }
  }
  const openalexOutcome = input.outcomes.find(
    (o) => o.name === 'openalex_search' && o.status === 'success',
  );
  if (openalexOutcome?.data && typeof openalexOutcome.data === 'object') {
    const data = openalexOutcome.data as {
      query: string;
      total: number;
      fetchedAt: string;
      works: {
        title: string;
        abstract: string | null;
        publication_year: number | null;
        authors: string[];
        cited_by_count: number;
        source: string | null;
        doi: string | null;
        open_access_url: string | null;
      }[];
    };
    const works = data.works ?? [];
    if (works.length > 0) {
      const lines = works.map((w, i) => {
        const year = w.publication_year !== null ? `（${w.publication_year}）` : '';
        return `${i + 1}. ${w.title}${year} —— 作者：${(w.authors ?? []).join(', ') || '未知'}；来源：${w.source ?? '未知'}；被引 ${w.cited_by_count} 次${w.doi ? `；DOI：${w.doi}` : ''}`;
      });
      return `根据 OpenAlex 实时检索到 ${data.total} 篇相关论文：\n${lines.join('\n')}\n（来源：OpenAlex 实时数据 · 获取时间：${data.fetchedAt}）`;
    }
  }
  if (input.toolContext.length > 0) {
    return `基于工具执行结果回答如下：\n${input.toolContext.join('\n')}\n（来源：工具返回 · 获取时间：${now}）`;
  }
  return `抱歉，未能获取到相关资料来回答「${input.query}」。`;
}

// ---------------------------------------------------------------------------
// 主循环
// ---------------------------------------------------------------------------

export function createToolCallLoop(deps: ToolCallLoopDeps) {
  const isMock = deps.isMock ?? (() => process.env.MOCK_MODELS === 'true');
  const maxRounds = deps.maxRounds ?? env.AGENT_TOOL_MAX_ROUNDS;

  async function runToolCallLoop(input: ToolCallLoopInput): Promise<ToolCallLoopResult> {
    const mock = isMock();
    const toolContext: string[] = [];
    const outcomes: ToolRunOutcome[] = [];
    let content = '';
    let usage: { inputTokens: number; outputTokens: number } | undefined;
    let model: string | undefined;
    let forced = false;

    for (let round = 0; round < maxRounds; round++) {
      let decision: ToolDecision | null;
      if (mock) {
        decision = deterministicToolDecision({
          query: input.query,
          tools: input.tools,
          priorOutcomes: outcomes,
        });
      } else {
        const raw = await deps.complete(
          buildToolDecisionPrompt({
            systemPrompt: input.systemPrompt,
            intentName: input.intentName,
            history: input.history,
            tools: input.tools,
            toolContext,
            query: input.query,
            round,
            maxRounds,
          }),
        );
        if (raw.model) model = raw.model;
        if (raw.usage) usage = mergeUsage(usage, raw.usage);
        decision = parseToolDecision(raw.content);
        // LLM 直接给出最终答语 → 采用并结束
        if (decision?.kind === 'answer') {
          content = decision.content;
          break;
        }
        // 决策无效（解析失败/非法）→ 视为不需要工具，走收尾生成
        if (!decision || decision.kind !== 'tools') break;
      }

      // decision 为 null（mock 判定无需工具 / LLM 未决策工具）→ 走收尾生成
      if (!decision || decision.kind !== 'tools') break;

      // 执行本轮工具调用
      for (const call of decision.calls) {
        const outcome = await deps.runTool(call.name, call.args, input.ctx);
        outcomes.push(outcome);
        toolContext.push(
          `[工具调用 ${round + 1}] ${call.name} ${safeStringify(call.args)} → ${outcomeToText(outcome)}`,
        );
      }

      // 达到最大轮数 → 强制收敛（不再请求下一轮决策）
      if (round === maxRounds - 1) {
        forced = true;
        break;
      }
    }

    if (content === '') {
      if (mock) {
        content = deterministicFinalize({ query: input.query, toolContext, outcomes });
      } else {
        const raw = await deps.complete(
          buildToolFinalPrompt({
            systemPrompt: input.systemPrompt,
            query: input.query,
            toolContext,
            forced,
          }),
        );
        if (raw.model) model = raw.model;
        if (raw.usage) usage = mergeUsage(usage, raw.usage);
        content = raw.content;
      }
    }

    return { content, toolCalls: outcomes, usage, model, forced };
  }

  return { runToolCallLoop };
}

/** 跨多轮累加 token 用量 */
function mergeUsage(
  acc: { inputTokens: number; outputTokens: number } | undefined,
  next: { inputTokens: number; outputTokens: number },
): { inputTokens: number; outputTokens: number } {
  return {
    inputTokens: (acc?.inputTokens ?? 0) + next.inputTokens,
    outputTokens: (acc?.outputTokens ?? 0) + next.outputTokens,
  };
}

function safeStringify(args: Record<string, unknown>): string {
  try {
    return JSON.stringify(args);
  } catch {
    return String(args);
  }
}

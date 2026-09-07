/**
 * M4 意图识别引擎 —— 把用户 query 分类到 Agent 绑定的某个意图。
 *
 * 双通道（与模型网关 mock 约定一致）：
 *  - Mock 模式（MOCK_MODELS=true，或 deps.isMock 返回 true）：确定性关键词/示例匹配，
 *    不触网、可复现，用于单测与无外网端到端验证。
 *  - LLM 模式：把候选意图（名称/描述/示例）拼入分类 prompt，调用 Agent 绑定的 LLM
 *    返回 JSON（{ "intentId": "<id>" | null }）；解析失败或未命中返回 null（fallback）。
 *
 * 路由约定：
 *  - 返回非空 IntentMatch → 按命中意图的策略/知识库子集执行；
 *  - 返回 null → 走「全知识库检索 + LLM 生成」兜底（或 Agent 内策略为 fallback 的意图）。
 */
import type { IntentStrategy } from '@pulse/contracts';

/** Agent 绑定意图的候选形态（由 agent-store 装配） */
export interface IntentCandidate {
  intentId: string;
  name: string;
  description: string | null;
  examples: string[];
  strategy: IntentStrategy;
  responseTemplate: string | null;
  workflowId: string | null;
  /** workflow 策略下触发工作流时透传的额外输入参数（由 agent-store 从 settings 装配） */
  workflowInputs?: Record<string, unknown>;
  /** 该意图在此 Agent 下的知识库子集 */
  datasetId: string | null;
  priority: number;
}

/** 识别结果（matchedBy 用于调试/观测） */
export interface IntentMatch {
  intentId: string;
  name: string;
  strategy: IntentStrategy;
  responseTemplate: string | null;
  workflowId: string | null;
  datasetId: string | null;
  score: number;
  matchedBy: 'mock' | 'llm';
}

/** LLM 分类调用签名（真实模式注入；prompt → 模型原始文本输出） */
export type IntentClassifier = (prompt: string) => Promise<string>;

export interface IntentServiceDeps {
  /** mock 判定；缺省读取 MOCK_MODELS */
  isMock?: () => boolean;
  /** LLM 分类实现；缺省抛错（仅 mock 模式可用） */
  classify?: IntentClassifier;
}

/** 未命中任何意图的兜底（null）由调用方处理 */
export type IntentClassification = IntentMatch | null;

export function createIntentService(deps: IntentServiceDeps = {}) {
  const isMock = deps.isMock ?? (() => process.env.MOCK_MODELS === 'true');
  const classifyLlm = deps.classify;

  /**
   * 主入口：给定 query 与候选意图，返回命中的意图；未命中返回 null（fallback）。
   *  - 候选为空：直接 null（无意图配置的 Agent 走全库检索）。
   *  - 同一查询命中多个意图时取 score 最高者；同分取 priority 高者。
   */
  async function classify(
    query: string,
    candidates: IntentCandidate[],
  ): Promise<IntentClassification> {
    if (candidates.length === 0) return null;
    if (isMock()) return classifyMock(query, candidates);
    return classifyByLlm(query, candidates, classifyLlm);
  }

  return { classify };
}

// ---------------------------------------------------------------------------
// Mock 模式：确定性关键词/示例匹配
// ---------------------------------------------------------------------------

/**
 * 确定性分类：
 *  - 名称命中：query 包含意图名 或 意图名包含 query（双向子串，长度 ≥2）→ +3；
 *  - 示例命中：query 与任一示例互为子串（长度 ≥2）→ 每条 +2；
 *  - 得分 ≥ MIN_SCORE 才算命中（避免单字符噪声误判）。
 * 返回最高分意图；并列时按 priority 降序、再按名称字典序（保证确定性）。
 */
export function classifyMock(
  query: string,
  candidates: IntentCandidate[],
  minScore = 2,
): IntentClassification {
  const q = normalize(query);
  if (q.length === 0) return null;

  let best: { cand: IntentCandidate; score: number } | null = null;
  for (const cand of candidates) {
    const score = mockScore(q, cand);
    if (score < minScore) continue;
    if (
      !best ||
      score > best.score ||
      (score === best.score &&
        (cand.priority > best.cand.priority ||
          (cand.priority === best.cand.priority && cand.name.localeCompare(best.cand.name) < 0)))
    ) {
      best = { cand, score };
    }
  }
  if (!best) return null;
  return toMatch(best.cand, best.score, 'mock');
}

function mockScore(q: string, cand: IntentCandidate): number {
  let score = 0;
  const name = normalize(cand.name);
  if (name.length >= 2 && (q.includes(name) || name.includes(q))) score += 3;
  for (const ex of cand.examples) {
    const e = normalize(ex);
    if (e.length < 2) continue;
    if (q.includes(e) || e.includes(q)) score += 2;
  }
  return score;
}

// ---------------------------------------------------------------------------
// LLM 模式：分类 prompt + JSON 解析
// ---------------------------------------------------------------------------

/** 组装意图分类 prompt（把候选意图结构化地交给 LLM） */
export function buildIntentPrompt(query: string, candidates: IntentCandidate[]): string {
  const lines = candidates
    .map((c, i) => {
      const ex = c.examples.length > 0 ? `示例：${c.examples.slice(0, 3).join('；')}` : '';
      return `${i + 1}. id=${c.intentId} 名称=${c.name}${c.description ? `，描述：${c.description}` : ''}${ex ? `，${ex}` : ''}`;
    })
    .join('\n');
  return [
    '你是意图分类器。根据用户输入，从下列候选意图中选择最匹配的一个，只返回 JSON：',
    '{"intentId": "<匹配的意图 id>"}，无法匹配任何意图时返回 {"intentId": null}。',
    '不要输出其他内容。',
    '',
    '候选意图：',
    lines,
    '',
    `用户输入：${query}`,
  ].join('\n');
}

async function classifyByLlm(
  query: string,
  candidates: IntentCandidate[],
  classifyLlm?: IntentClassifier,
): Promise<IntentClassification> {
  if (!classifyLlm) {
    throw new Error('intent-service: LLM 分类实现未注入（非 mock 模式下必须提供 classify）');
  }
  const prompt = buildIntentPrompt(query, candidates);
  const raw = await classifyLlm(prompt);
  const parsed = parseIntentJson(raw);
  if (!parsed?.intentId) return null;
  const cand = candidates.find((c) => c.intentId === parsed.intentId);
  if (!cand) return null;
  return toMatch(cand, 1, 'llm');
}

/** 容忍 markdown 代码块 / 前后缀，从模型输出中提取首个 JSON 对象 */
export function parseIntentJson(raw: string): { intentId: string | null } | null {
  const text = raw
    .trim()
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/, '')
    .trim();
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const obj = JSON.parse(match[0]) as { intentId?: unknown };
    if (obj.intentId === null || obj.intentId === undefined) return { intentId: null };
    if (typeof obj.intentId === 'string' && obj.intentId.length > 0)
      return { intentId: obj.intentId };
    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

function toMatch(cand: IntentCandidate, score: number, matchedBy: 'mock' | 'llm'): IntentMatch {
  return {
    intentId: cand.intentId,
    name: cand.name,
    strategy: cand.strategy,
    responseTemplate: cand.responseTemplate,
    workflowId: cand.workflowId,
    datasetId: cand.datasetId,
    score,
    matchedBy,
  };
}

/** 归一化：去空白、转小写（中文不受影响） */
function normalize(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

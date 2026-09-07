/**
 * M-C OpenAlex 实时学术检索工具 —— openalex_search。
 *
 * 让 Agent 实时检索 OpenAlex 学术文献库（全球论文/著作/数据集），返回结构化条目：
 *  { title, abstract, doi, publication_year, authors[], cited_by_count, open_access_url, source }。
 *
 * 设计要点：
 *  - 参数 manifest 用 Zod 描述（query / perPage 1-25 / yearFrom / yearTo / sort），供 LLM 决策；
 *  - GET https://api.openalex.org/works?search=<query>&per_page=<n>&sort=<sort>&mailto=<email>
 *    （可选 filter=from_publication_date/to_publication_date 做年份过滤；mailto 走 polite pool 5rps）；
 *  - 还原 OpenAlex 反转摘要（abstract_inverted_index -> 完整 abstract 文本）；
 *  - API Key 可选：env.OPENALEX_API_KEY 或 ctx.openAlexApiKey 注入（无 key 也能跑，限 1rps）；
 *  - Mock 模式：env.MOCK_TOOLS / env.MOCK_MODELS 为 true（或 ctx.mockTools 显式注入）时
 *    返回确定性假数据（2-3 条学术条目），保证无外网端到端可测；
 *  - 短缓存：结果以 `tool:openalex:<sha256(args)>` 写入 Redis，TTL 300s；
 *    Redis 不可用 / 读写失败时自动跳过缓存走实时（降级不阻塞）；
 *  - 文本截断：每篇条目文本上限 800 字符，防 LLM 上下文膨胀。
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { logger } from '../logger.js';
import { ensureRedis } from '../redis.js';
import type { Tool, ToolContext } from './types.js';

// ---------------------------------------------------------------------------
// 参数 manifest
// ---------------------------------------------------------------------------

/** 排序方式（OpenAlex sort 参数：字段:方向） */
export const openAlexSortSchema = z.enum([
  'relevance_score:desc',
  'cited_by_count:desc',
  'publication_date:desc',
]);
export type OpenAlexSort = z.infer<typeof openAlexSortSchema>;

export const openAlexSearchArgsSchema = z.object({
  /** 检索关键词（OpenAlex search 全文检索：标题/摘要/关键词等） */
  query: z.string().trim().min(1).max(512),
  /** 返回条数（1-25，缺省 5） */
  perPage: z.number().int().min(1).max(25).optional(),
  /** 起始出版年（含）；转为 filter=from_publication_date:<year>-01-01 */
  yearFrom: z.number().int().min(1800).max(2100).optional(),
  /** 截止出版年（含）；转为 filter=to_publication_date:<year>-12-31 */
  yearTo: z.number().int().min(1800).max(2100).optional(),
  /** 排序（缺省按相关度降序） */
  sort: openAlexSortSchema.optional(),
});
export type OpenAlexSearchArgs = z.infer<typeof openAlexSearchArgsSchema>;

// ---------------------------------------------------------------------------
// 结果结构
// ---------------------------------------------------------------------------

/** 单篇论文的结构化条目（键名与需求/OpenAlex 命名一致） */
export interface OpenAlexWorkEntry {
  title: string;
  abstract: string | null;
  doi: string | null;
  publication_year: number | null;
  authors: string[];
  cited_by_count: number;
  open_access_url: string | null;
  /** 来源期刊 / venue（primary_location.source.display_name） */
  source: string | null;
}

export interface OpenAlexSearchResult {
  query: string;
  total: number;
  perPage: number;
  /** 获取时间（ISO；缓存命中时为原抓取时间） */
  fetchedAt: string;
  /** 是否命中 Redis 短缓存（text 表示会标注「来自缓存」） */
  fromCache: boolean;
  works: OpenAlexWorkEntry[];
}

/** 短缓存接口（可注入 stub 做单测；缺省走 Redis，不可用自动降级） */
export interface ToolCache {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
}

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

export const OPENALEX_BASE_URL = 'https://api.openalex.org/works';
/** OpenAlex 请求超时（ms） */
export const OPENALEX_TIMEOUT_MS = 10_000;
/** 每篇条目文本截断上限（防上下文膨胀） */
export const OPENALEX_ENTRY_TEXT_LIMIT = 800;
/** 短缓存 TTL（s） */
export const OPENALEX_CACHE_TTL_SECONDS = 300;
const OPENALEX_CACHE_PREFIX = 'tool:openalex:';
/** 缺省联络邮箱（未配置 OPENALEX_MAILTO 时的占位） */
export const DEFAULT_OPENALEX_MAILTO = 'pulse-rag@example.com';

// ---------------------------------------------------------------------------
// 纯逻辑：摘要还原 / URL 构建 / 条目归一 / 文本表示 / 缓存键（可直接单测）
// ---------------------------------------------------------------------------

/**
 * 还原 OpenAlex 反转摘要。
 * abstract_inverted_index = { word: [出现位置...] }，按位置拼回原文。
 * 非法 / 空输入返回 null；缺失位置以空串占位（由 join 压缩）。
 */
export function reconstructAbstract(
  invertedIndex: Record<string, number[]> | null | undefined,
): string | null {
  if (!invertedIndex || typeof invertedIndex !== 'object') return null;
  const wordsAt = new Map<number, string>();
  let maxPos = -1;
  for (const [word, positions] of Object.entries(invertedIndex)) {
    if (!Array.isArray(positions)) continue;
    for (const pos of positions) {
      if (!Number.isInteger(pos) || pos < 0) continue;
      wordsAt.set(pos, word);
      if (pos > maxPos) maxPos = pos;
    }
  }
  if (maxPos < 0) return null;
  const words: string[] = [];
  for (let i = 0; i <= maxPos; i++) {
    words.push(wordsAt.get(i) ?? '');
  }
  const text = words.join(' ').replace(/\s+/g, ' ').trim();
  return text.length > 0 ? text : null;
}

/** 构建 OpenAlex works 检索 URL（含 search / per_page / sort / mailto / 可选年份过滤 / 可选 api_key） */
export function buildOpenAlexUrl(params: {
  query: string;
  perPage: number;
  sort: OpenAlexSort;
  yearFrom?: number;
  yearTo?: number;
  mailto: string;
  apiKey?: string;
}): string {
  const url = new URL(OPENALEX_BASE_URL);
  url.searchParams.set('search', params.query);
  url.searchParams.set('per_page', String(params.perPage));
  url.searchParams.set('sort', params.sort);
  if (params.mailto.trim().length > 0) url.searchParams.set('mailto', params.mailto.trim());
  if (params.apiKey && params.apiKey.trim().length > 0) {
    url.searchParams.set('api_key', params.apiKey.trim());
  }
  const filters: string[] = [];
  if (params.yearFrom !== undefined) filters.push(`from_publication_date:${params.yearFrom}-01-01`);
  if (params.yearTo !== undefined) filters.push(`to_publication_date:${params.yearTo}-12-31`);
  if (filters.length > 0) url.searchParams.set('filter', filters.join(','));
  return url.toString();
}

/** DOI 归一：去除 https://doi.org / http://dx.doi.org 前缀，保留 10.xxxx/yyyy 形态 */
export function normalizeDoi(doi: unknown): string | null {
  if (typeof doi !== 'string' || doi.trim().length === 0) return null;
  return doi.trim().replace(/^https?:\/\/(doi\.org|dx\.doi\.org)\//i, '');
}

function firstString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function extractAuthors(authorships: unknown): string[] {
  if (!Array.isArray(authorships)) return [];
  const names: string[] = [];
  for (const item of authorships) {
    if (!item || typeof item !== 'object') continue;
    const author = (item as { author?: unknown }).author;
    if (!author || typeof author !== 'object') continue;
    const name = firstString((author as { display_name?: unknown }).display_name);
    if (name) names.push(name);
  }
  return names;
}

function extractOpenAccessUrl(work: Record<string, unknown>): string | null {
  const openAccess = work.open_access;
  if (openAccess && typeof openAccess === 'object') {
    const oaUrl = firstString((openAccess as { oa_url?: unknown }).oa_url);
    if (oaUrl) return oaUrl;
  }
  const bestOa = work.best_oa_location;
  if (bestOa && typeof bestOa === 'object') {
    const landing = firstString((bestOa as { landing_page_url?: unknown }).landing_page_url);
    if (landing) return landing;
  }
  return null;
}

function extractSource(primaryLocation: unknown): string | null {
  if (!primaryLocation || typeof primaryLocation !== 'object') return null;
  const source = (primaryLocation as { source?: unknown }).source;
  if (!source || typeof source !== 'object') return null;
  return firstString((source as { display_name?: unknown }).display_name);
}

/** 把单条 OpenAlex work JSON 归一为结构化条目（防御非法字段） */
export function normalizeWork(raw: unknown): OpenAlexWorkEntry {
  const w = (raw ?? {}) as Record<string, unknown>;
  const abstractIndex = w.abstract_inverted_index;
  const abstract =
    abstractIndex && typeof abstractIndex === 'object'
      ? reconstructAbstract(abstractIndex as Record<string, number[]>)
      : null;
  return {
    title: firstString(w.title) ?? firstString(w.display_name) ?? '(无标题)',
    abstract,
    doi: normalizeDoi(w.doi),
    publication_year: typeof w.publication_year === 'number' ? w.publication_year : null,
    authors: extractAuthors(w.authorships),
    cited_by_count: typeof w.cited_by_count === 'number' ? w.cited_by_count : 0,
    open_access_url: extractOpenAccessUrl(w),
    source: extractSource(w.primary_location),
  };
}

/** 文本截断：超长内容裁剪至 max 字符并追加省略号 */
export function truncateText(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 3))}...`;
}

/** 生成可用于 LLM 的 text 表示（含来源标注「OpenAlex 实时数据 · 获取时间 fetchedAt」） */
export function formatOpenAlexResult(result: OpenAlexSearchResult): string {
  const header = `[openalex_search] 查询「${result.query}」：命中 ${result.total} 篇论文（OpenAlex 实时数据 · 获取时间 ${result.fetchedAt}${result.fromCache ? ' · 来自缓存' : ''}）`;
  const lines: string[] = [header];
  if (result.works.length === 0) {
    lines.push('（未检索到相关论文）');
    return lines.join('\n');
  }
  for (const [i, work] of result.works.entries()) {
    const entryLines = [
      `${i + 1}. ${work.title}${work.publication_year !== null ? `（${work.publication_year}）` : ''}`,
      `   作者：${work.authors.length > 0 ? work.authors.join(', ') : '未知'}`,
      `   来源：${work.source ?? '未知'}`,
      `   引用：${work.cited_by_count}`,
      work.doi !== null ? `   DOI：${work.doi}` : '',
      work.abstract !== null ? `   摘要：${work.abstract}` : '',
      work.open_access_url !== null ? `   开放获取：${work.open_access_url}` : '',
    ].filter((line) => line.length > 0);
    lines.push(truncateText(entryLines.join('\n'), OPENALEX_ENTRY_TEXT_LIMIT));
  }
  return lines.join('\n');
}

/** 缓存键：tool:openalex:<sha256(规范化参数)> */
export function buildOpenAlexCacheKey(args: OpenAlexSearchArgs): string {
  const canonical = {
    query: args.query.trim(),
    perPage: args.perPage ?? 5,
    sort: args.sort ?? 'relevance_score:desc',
    yearFrom: args.yearFrom ?? null,
    yearTo: args.yearTo ?? null,
  };
  const hash = createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
  return `${OPENALEX_CACHE_PREFIX}${hash}`;
}

// ---------------------------------------------------------------------------
// Mock 数据（确定性假数据：MOCK_TOOLS / MOCK_MODELS / ctx.mockTools）
// ---------------------------------------------------------------------------

/** 确定性 Mock 学术条目（无外网端到端可测） */
export function mockOpenAlexSearchResult(query: string, now: string): OpenAlexSearchResult {
  const q = query.trim() || '学术检索';
  const works: OpenAlexWorkEntry[] = [
    {
      title: `模拟研究：关于「${q}」的系统综述`,
      abstract:
        `这是第一条确定性 Mock 数据摘要（MOCK_TOOLS / 无外网可测）。` +
        `本文系统综述了与「${q}」相关的研究进展、核心方法与开放问题，用于离线验证工具循环与来源标注。`,
      doi: '10.0000/mock.0001',
      publication_year: 2024,
      authors: ['张三', '李四'],
      cited_by_count: 42,
      open_access_url: 'https://example.org/openalex/mock/1',
      source: 'Mock Journal of Computer Science',
    },
    {
      title: `模拟研究：面向「${q}」的实证分析`,
      abstract:
        `这是第二条确定性 Mock 数据摘要。本文针对「${q}」开展实证分析，` +
        `对比不同方法的检索效果并讨论其局限性。`,
      doi: '10.0000/mock.0002',
      publication_year: 2025,
      authors: ['王五'],
      cited_by_count: 17,
      open_access_url: null,
      source: 'Mock Conference on Artificial Intelligence',
    },
    {
      title: `模拟研究：「${q}」的综述与展望`,
      abstract:
        `这是第三条确定性 Mock 数据摘要。本文回顾「${q}」近年来的进展并提出未来研究方向。`,
      doi: null,
      publication_year: 2023,
      authors: ['赵六', '钱七', '孙八'],
      cited_by_count: 8,
      open_access_url: 'https://example.org/openalex/mock/3',
      source: null,
    },
  ];
  return {
    query: query.trim(),
    total: works.length,
    perPage: works.length,
    fetchedAt: now,
    fromCache: false,
    works,
  };
}

// ---------------------------------------------------------------------------
// 短缓存：缺省走 Redis，不可用自动降级（不阻塞实时检索）
// ---------------------------------------------------------------------------

/** 缺省缓存实现：ioredis 单例；连接失败 / 命令异常时降级为「跳过缓存走实时」 */
export function createRedisToolCache(): ToolCache {
  return {
    async get(key) {
      const client = await ensureRedis();
      if (!client) return null;
      try {
        return await client.get(key);
      } catch (err) {
        logger.warn(
          { err: err instanceof Error ? err.message : String(err) },
          '[openalex] Redis 缓存读失败，跳过缓存走实时',
        );
        return null;
      }
    },
    async set(key, value, ttlSeconds) {
      const client = await ensureRedis();
      if (!client) return;
      try {
        await client.set(key, value, 'EX', ttlSeconds);
      } catch (err) {
        logger.warn(
          { err: err instanceof Error ? err.message : String(err) },
          '[openalex] Redis 缓存写失败，忽略（不影响实时返回）',
        );
      }
    },
  };
}

const defaultOpenAlexCache = createRedisToolCache();

/** Mock 判定：ctx.mockTools 显式注入优先；否则读 env.MOCK_TOOLS / env.MOCK_MODELS */
export function isOpenAlexMock(ctx: ToolContext): boolean {
  if (typeof ctx.mockTools === 'boolean') return ctx.mockTools;
  return env.MOCK_TOOLS || env.MOCK_MODELS;
}

// ---------------------------------------------------------------------------
// OpenAlex works 响应形态（仅取需要的字段）
// ---------------------------------------------------------------------------

interface OpenAlexApiResponse {
  meta?: { count?: number; per_page?: number };
  results?: unknown[];
}

// ---------------------------------------------------------------------------
// Tool 实现
// ---------------------------------------------------------------------------

export const openAlexSearchTool: Tool<OpenAlexSearchArgs, OpenAlexSearchResult> = {
  name: 'openalex_search',
  description:
    '实时检索 OpenAlex 学术文献库（全球论文/著作/数据集）：按关键词全文检索，返回标题、摘要、作者、DOI、来源期刊、被引次数与开放获取链接。当用户需要查询学术论文、研究文献、DOI、引用数据等外部学术信息时调用。',
  parameters: openAlexSearchArgsSchema,
  run: async (args, ctx) => {
    // 1) Mock 模式：确定性假数据，不发任何请求
    if (isOpenAlexMock(ctx)) {
      const now = typeof ctx.now === 'string' ? ctx.now : new Date().toISOString();
      const data = mockOpenAlexSearchResult(args.query, now);
      return { text: formatOpenAlexResult(data), data };
    }

    // 2) 凭据与联络邮箱：ctx 注入优先，其次 env
    const apiKey =
      typeof ctx.openAlexApiKey === 'string' && ctx.openAlexApiKey.trim().length > 0
        ? ctx.openAlexApiKey.trim()
        : env.OPENALEX_API_KEY;
    const mailto =
      typeof ctx.openAlexMailto === 'string' && ctx.openAlexMailto.trim().length > 0
        ? ctx.openAlexMailto.trim()
        : (env.OPENALEX_MAILTO?.trim() || DEFAULT_OPENALEX_MAILTO);

    // 3) 短缓存：命中直接返回（fromCache=true，text 标注来源与缓存）
    const cache = (ctx.cache as ToolCache | undefined) ?? defaultOpenAlexCache;
    const cacheKey = buildOpenAlexCacheKey(args);
    try {
      const cached = await cache.get(cacheKey);
      if (cached) {
        const parsed = JSON.parse(cached) as OpenAlexSearchResult;
        if (parsed && Array.isArray(parsed.works)) {
          const data: OpenAlexSearchResult = { ...parsed, fromCache: true };
          return { text: formatOpenAlexResult(data), data };
        }
      }
    } catch {
      // 缓存读失败 / 数据损坏 → 回退实时检索（降级不阻塞）
    }

    // 4) 实时检索
    const url = buildOpenAlexUrl({
      query: args.query,
      perPage: args.perPage ?? 5,
      sort: args.sort ?? 'relevance_score:desc',
      yearFrom: args.yearFrom,
      yearTo: args.yearTo,
      mailto,
      apiKey,
    });
    const fetchImpl =
      (ctx.fetch as typeof fetch | undefined) ??
      (typeof globalThis !== 'undefined' ? globalThis.fetch : undefined);
    if (!fetchImpl) {
      throw new Error('openalex_search: 当前环境不支持 fetch');
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), OPENALEX_TIMEOUT_MS);
    try {
      const response = await fetchImpl(url, {
        method: 'GET',
        headers: { accept: 'application/json' },
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`openalex_search: OpenAlex 返回 HTTP ${response.status}`);
      }
      const payload = (await response.json()) as OpenAlexApiResponse;
      const works = (Array.isArray(payload.results) ? payload.results : []).map((w) => normalizeWork(w));
      const data: OpenAlexSearchResult = {
        query: args.query.trim(),
        total: typeof payload.meta?.count === 'number' ? payload.meta.count : works.length,
        perPage: args.perPage ?? 5,
        fetchedAt: typeof ctx.now === 'string' ? ctx.now : new Date().toISOString(),
        fromCache: false,
        works,
      };
      // 5) 写入缓存（best-effort；失败不影响本次返回）
      try {
        await cache.set(cacheKey, JSON.stringify(data), OPENALEX_CACHE_TTL_SECONDS);
      } catch {
        // 忽略缓存写失败
      }
      return { text: formatOpenAlexResult(data), data };
    } catch (err) {
      if (err instanceof Error) {
        if (err.name === 'AbortError') {
          throw new Error(`openalex_search: 请求超时（>${OPENALEX_TIMEOUT_MS}ms）`);
        }
        if (err.message.startsWith('openalex_search:')) throw err;
        throw new Error(`openalex_search: 请求失败 - ${err.message}`);
      }
      throw new Error(`openalex_search: 请求失败 - ${String(err)}`);
    } finally {
      clearTimeout(timeout);
    }
  },
};

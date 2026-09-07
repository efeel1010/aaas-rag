/**
 * M-C openalex_search 工具单测 —— 反转摘要还原 / URL 与参数构建（含年份过滤/mailto/api_key）/
 * 条目归一 / 结构化与 text 表示（含来源标注与截断）/ Mock 模式 / 缓存命中与未命中 / Redis 降级。
 *
 * 所有真实网络路径均注入 ctx.fetch stub，全程无外网；Mock 模式注入 ctx.mockTools 或依赖
 * setup-env 的 MOCK_MODELS=true（用 fetch spy 断言未发起请求）。
 */
import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_OPENALEX_MAILTO,
  OPENALEX_CACHE_TTL_SECONDS,
  buildOpenAlexCacheKey,
  buildOpenAlexUrl,
  formatOpenAlexResult,
  isOpenAlexMock,
  mockOpenAlexSearchResult,
  normalizeDoi,
  normalizeWork,
  openAlexSearchArgsSchema,
  openAlexSearchTool,
  reconstructAbstract,
  truncateText,
  type OpenAlexSearchResult,
  type ToolCache,
} from '../../src/lib/tools/openalex.js';
import { getTool, registeredToolNames } from '../../src/lib/tools/registry.js';
import type { ToolContext } from '../../src/lib/tools/types.js';

// ---------------------------------------------------------------------------
// 测试夹具
// ---------------------------------------------------------------------------

const NOW = '2026-01-01T00:00:00.000Z';

/** OpenAlex works 响应样例（含反转摘要、OA、DOI 前缀等形态） */
const SAMPLE_PAYLOAD = {
  meta: { count: 123, per_page: 2 },
  results: [
    {
      id: 'https://openalex.org/W111',
      title: 'Retrieval Augmented Generation: A Survey',
      publication_year: 2023,
      doi: 'https://doi.org/10.1000/survey',
      cited_by_count: 120,
      // 位置 3 缺失 → 应被空串占位后压缩
      abstract_inverted_index: {
        Retrieval: [0],
        augmented: [1],
        generation: [2],
        survey: [4],
      },
      authorships: [
        { author: { display_name: 'Alice' } },
        { author: { display_name: 'Bob' } },
      ],
      open_access: { oa_url: 'https://oa.example.org/paper.pdf', is_oa: true },
      best_oa_location: { landing_page_url: 'https://land.example.org' },
      primary_location: { source: { display_name: 'ACM Computing Surveys' } },
    },
    {
      id: 'https://openalex.org/W222',
      title: 'Attention Is All You Need',
      publication_year: 2017,
      doi: '10.48550/arXiv.1706.03762',
      cited_by_count: 99999,
      abstract_inverted_index: null,
      authorships: [],
      open_access: { oa_url: null, is_oa: false },
      primary_location: { source: null },
    },
  ],
};

function okFetch(payload: unknown = SAMPLE_PAYLOAD): ReturnType<typeof vi.fn> {
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => payload,
  }) as unknown as Response);
}

/** 内存版 ToolCache stub：可断言 get/set 调用与 TTL */
function cacheStub(): ToolCache & {
  store: Map<string, string>;
  getCalls: string[];
  setCalls: { key: string; value: string; ttl: number }[];
} {
  const store = new Map<string, string>();
  const getCalls: string[] = [];
  const setCalls: { key: string; value: string; ttl: number }[] = [];
  return {
    store,
    getCalls,
    setCalls,
    async get(key) {
      getCalls.push(key);
      return store.get(key) ?? null;
    },
    async set(key, value, ttl) {
      setCalls.push({ key, value, ttl });
      store.set(key, value);
    },
  };
}

// ---------------------------------------------------------------------------
// 反转摘要还原
// ---------------------------------------------------------------------------

describe('reconstructAbstract（OpenAlex 反转摘要还原）', () => {
  it('按位置拼回完整摘要，缺失位置以空串占位后压缩', () => {
    const text = reconstructAbstract({ Retrieval: [0], augmented: [1], generation: [2], survey: [4] });
    expect(text).toBe('Retrieval augmented generation survey');
  });

  it('同一词多位置（重复词）正确展开', () => {
    const text = reconstructAbstract({ the: [0, 3], cat: [1], sat: [2] });
    expect(text).toBe('the cat sat the');
  });

  it('null / undefined / 空对象 / 非对象 → null', () => {
    expect(reconstructAbstract(null)).toBeNull();
    expect(reconstructAbstract(undefined)).toBeNull();
    expect(reconstructAbstract({})).toBeNull();
    expect(reconstructAbstract('bad' as unknown as Record<string, number[]>)).toBeNull();
  });

  it('非法位置被忽略（负数 / 非整数 / 非法条目）', () => {
    const text = reconstructAbstract({
      good: [0],
      bad: [-1],
      worse: [1.5, 'x' as unknown as number],
    });
    expect(text).toBe('good');
  });
});

// ---------------------------------------------------------------------------
// URL / 参数构建
// ---------------------------------------------------------------------------

describe('buildOpenAlexUrl', () => {
  it('基础参数：search / per_page / sort / mailto', () => {
    const url = new URL(
      buildOpenAlexUrl({ query: 'large language models', perPage: 5, sort: 'relevance_score:desc', mailto: 'me@example.com' }),
    );
    expect(url.searchParams.get('search')).toBe('large language models');
    expect(url.searchParams.get('per_page')).toBe('5');
    expect(url.searchParams.get('sort')).toBe('relevance_score:desc');
    expect(url.searchParams.get('mailto')).toBe('me@example.com');
    expect(url.searchParams.get('filter')).toBeNull();
  });

  it('年份过滤：yearFrom/yearTo → from/to_publication_date filter', () => {
    const url = new URL(
      buildOpenAlexUrl({ query: 'rag', perPage: 10, sort: 'cited_by_count:desc', yearFrom: 2020, yearTo: 2023, mailto: 'a@b.c' }),
    );
    expect(url.searchParams.get('filter')).toBe(
      'from_publication_date:2020-01-01,to_publication_date:2023-12-31',
    );
  });

  it('仅 yearFrom / 仅 yearTo 各自独立成 filter', () => {
    const onlyFrom = new URL(buildOpenAlexUrl({ query: 'q', perPage: 5, sort: 'relevance_score:desc', yearFrom: 2019, mailto: '' }));
    expect(onlyFrom.searchParams.get('filter')).toBe('from_publication_date:2019-01-01');
    const onlyTo = new URL(buildOpenAlexUrl({ query: 'q', perPage: 5, sort: 'relevance_score:desc', yearTo: 2024, mailto: '' }));
    expect(onlyTo.searchParams.get('filter')).toBe('to_publication_date:2024-12-31');
  });

  it('api_key 透传；mailto 为空则不携带', () => {
    const url = new URL(
      buildOpenAlexUrl({ query: 'q', perPage: 5, sort: 'relevance_score:desc', mailto: '', apiKey: 'sk-test' }),
    );
    expect(url.searchParams.get('api_key')).toBe('sk-test');
    expect(url.searchParams.get('mailto')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 参数 manifest 校验
// ---------------------------------------------------------------------------

describe('openAlexSearchArgsSchema 参数校验', () => {
  it('合法参数解析通过；缺省项为 undefined', () => {
    const parsed = openAlexSearchArgsSchema.parse({ query: 'rag' });
    expect(parsed.perPage).toBeUndefined();
    expect(parsed.yearFrom).toBeUndefined();
    expect(parsed.sort).toBeUndefined();
    expect(openAlexSearchArgsSchema.parse({ query: 'x', perPage: 25, yearFrom: 2020, yearTo: 2025, sort: 'publication_date:desc' }).perPage).toBe(25);
  });

  it('query 空白 / 超长拒绝', () => {
    expect(() => openAlexSearchArgsSchema.parse({ query: '   ' })).toThrow();
    expect(() => openAlexSearchArgsSchema.parse({ query: 'x'.repeat(513) })).toThrow();
  });

  it('perPage 越界（0 / 26）拒绝', () => {
    expect(() => openAlexSearchArgsSchema.parse({ query: 'x', perPage: 0 })).toThrow();
    expect(() => openAlexSearchArgsSchema.parse({ query: 'x', perPage: 26 })).toThrow();
  });

  it('year 越界 / 非整数 / sort 非法拒绝', () => {
    expect(() => openAlexSearchArgsSchema.parse({ query: 'x', yearFrom: 1799 })).toThrow();
    expect(() => openAlexSearchArgsSchema.parse({ query: 'x', yearTo: 2101 })).toThrow();
    expect(() => openAlexSearchArgsSchema.parse({ query: 'x', yearFrom: 2020.5 })).toThrow();
    expect(() => openAlexSearchArgsSchema.parse({ query: 'x', sort: 'bogus' })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// 条目归一 / 文本表示
// ---------------------------------------------------------------------------

describe('normalizeWork / formatOpenAlexResult', () => {
  it('归一 OpenAlex work JSON：标题/摘要/DOI 前缀剥离/作者/OA 优先 open_access.oa_url/来源', () => {
    const entry = normalizeWork(SAMPLE_PAYLOAD.results[0]);
    expect(entry).toEqual({
      title: 'Retrieval Augmented Generation: A Survey',
      abstract: 'Retrieval augmented generation survey',
      doi: '10.1000/survey',
      publication_year: 2023,
      authors: ['Alice', 'Bob'],
      cited_by_count: 120,
      open_access_url: 'https://oa.example.org/paper.pdf',
      source: 'ACM Computing Surveys',
    });
  });

  it('缺字段 work 防御：摘要/作者/OA/来源缺省为 null/[]/0', () => {
    const entry = normalizeWork(SAMPLE_PAYLOAD.results[1]);
    expect(entry).toMatchObject({
      title: 'Attention Is All You Need',
      abstract: null,
      doi: '10.48550/arXiv.1706.03762',
      publication_year: 2017,
      authors: [],
      cited_by_count: 99999,
      open_access_url: null,
      source: null,
    });
  });

  it('normalizeDoi：剥离 https://doi.org 与 http://dx.doi.org 前缀，其余原样', () => {
    expect(normalizeDoi('https://doi.org/10.1000/x')).toBe('10.1000/x');
    expect(normalizeDoi('http://dx.doi.org/10.1000/y')).toBe('10.1000/y');
    expect(normalizeDoi('10.1000/z')).toBe('10.1000/z');
    expect(normalizeDoi(null)).toBeNull();
    expect(normalizeDoi(123)).toBeNull();
    expect(normalizeDoi('')).toBeNull();
  });

  it('text 表示含来源标注「OpenAlex 实时数据 · 获取时间」与结构化字段', () => {
    const data: OpenAlexSearchResult = {
      query: 'rag survey',
      total: 123,
      perPage: 2,
      fetchedAt: NOW,
      fromCache: false,
      works: [normalizeWork(SAMPLE_PAYLOAD.results[0])],
    };
    const text = formatOpenAlexResult(data);
    expect(text).toContain('查询「rag survey」：命中 123 篇论文');
    expect(text).toContain('OpenAlex 实时数据 · 获取时间 2026-01-01T00:00:00.000Z');
    expect(text).toContain('Retrieval Augmented Generation: A Survey');
    expect(text).toContain('作者：Alice, Bob');
    expect(text).toContain('ACM Computing Surveys');
    expect(text).toContain('DOI：10.1000/survey');
  });

  it('fromCache=true 时 text 标注「来自缓存」', () => {
    const text = formatOpenAlexResult({
      query: 'q',
      total: 0,
      perPage: 5,
      fetchedAt: NOW,
      fromCache: true,
      works: [],
    });
    expect(text).toContain('来自缓存');
    expect(text).toContain('未检索到相关论文');
  });

  it('truncateText：超长内容裁剪并保留上限字符', () => {
    expect(truncateText('short', 800)).toBe('short');
    expect(truncateText('x'.repeat(805), 800)).toHaveLength(800);
    expect(truncateText('x'.repeat(805), 800)).toMatch(/\.\.\.$/);
  });

  it('超长摘要文本被截断（每篇上限 800 字符）', () => {
    const longAbstract = '长摘要'.repeat(600); // 1800 字符
    const data: OpenAlexSearchResult = {
      query: 'q',
      total: 1,
      perPage: 1,
      fetchedAt: NOW,
      fromCache: false,
      works: [
        {
          title: 'T',
          abstract: longAbstract,
          doi: null,
          publication_year: 2024,
          authors: ['A'],
          cited_by_count: 1,
          open_access_url: null,
          source: 'S',
        },
      ],
    };
    const text = formatOpenAlexResult(data);
    // 单条条目文本段 ≤ 800 字符（截断后）
    const entryBlock = text.split('\n').slice(1).join('\n');
    expect(entryBlock.length).toBeLessThanOrEqual(800);
    expect(entryBlock).toMatch(/\.\.\.$/);
  });
});

// ---------------------------------------------------------------------------
// Mock 模式
// ---------------------------------------------------------------------------

describe('openalex_search Mock 模式', () => {
  it('ctx.mockTools=true → 返回确定性 3 条学术条目，不发起请求', async () => {
    const fetchMock = vi.fn();
    const result = await openAlexSearchTool.run(
      { query: '知识图谱' },
      { mockTools: true, now: NOW, fetch: fetchMock as unknown as typeof fetch },
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.data.works).toHaveLength(3);
    expect(result.data.works[0]).toMatchObject({
      title: '模拟研究：关于「知识图谱」的系统综述',
      doi: '10.0000/mock.0001',
      publication_year: 2024,
      cited_by_count: 42,
    });
    expect(result.text).toContain('OpenAlex 实时数据 · 获取时间 2026-01-01T00:00:00.000Z');
    expect(result.text).toContain('知识图谱');
  });

  it('env.MOCK_MODELS=true（无 ctx 覆盖）→ mock（setup-env 注入）', async () => {
    const fetchMock = vi.fn();
    const result = await openAlexSearchTool.run(
      { query: '大语言模型' },
      { fetch: fetchMock as unknown as typeof fetch },
    );
    expect(result.data.works.length).toBeGreaterThanOrEqual(2);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('isOpenAlexMock：ctx 显式注入优先于 env', () => {
    expect(isOpenAlexMock({ mockTools: false })).toBe(false);
    expect(isOpenAlexMock({ mockTools: true })).toBe(true);
    expect(isOpenAlexMock({})).toBe(process.env.MOCK_MODELS === 'true');
  });

  it('mockOpenAlexSearchResult：确定性数据且 fetchedAt 固定', () => {
    const a = mockOpenAlexSearchResult('测试', NOW);
    const b = mockOpenAlexSearchResult('测试', NOW);
    expect(a).toEqual(b);
    expect(a.total).toBe(3);
    expect(a.fetchedAt).toBe(NOW);
  });
});

// ---------------------------------------------------------------------------
// 实时模式（注入 fetch + 可选 cache）
// ---------------------------------------------------------------------------

describe('openalex_search 实时模式', () => {
  it('调用 OpenAlex 并返回结构化 + text（URL 含 search/per_page/mailto 缺省）', async () => {
    const cache = cacheStub();
    const fetchMock = okFetch();
    const ctx: ToolContext = { mockTools: false, fetch: fetchMock as unknown as typeof fetch, cache, now: NOW };
    const result = await openAlexSearchTool.run({ query: 'survey' }, ctx);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = new URL(fetchMock.mock.calls[0]![0] as string);
    expect(url.searchParams.get('search')).toBe('survey');
    expect(url.searchParams.get('per_page')).toBe('5');
    expect(url.searchParams.get('sort')).toBe('relevance_score:desc');
    expect(url.searchParams.get('mailto')).toBe(DEFAULT_OPENALEX_MAILTO);

    expect(result.data.total).toBe(123);
    expect(result.data.works).toHaveLength(2);
    expect(result.data.works[0]).toMatchObject({
      title: 'Retrieval Augmented Generation: A Survey',
      doi: '10.1000/survey',
    });
    expect(result.data.fetchedAt).toBe(NOW);
    expect(result.data.fromCache).toBe(false);
    expect(result.text).toContain('OpenAlex 实时数据 · 获取时间 2026-01-01T00:00:00.000Z');
  });

  it('ctx.openAlexApiKey / openAlexMailto 注入优先于缺省', async () => {
    const fetchMock = okFetch();
    const ctx: ToolContext = {
      mockTools: false,
      fetch: fetchMock as unknown as typeof fetch,
      openAlexApiKey: 'sk-ctx',
      openAlexMailto: 'ctx@example.com',
    };
    await openAlexSearchTool.run({ query: 'q' }, ctx);
    const url = new URL(fetchMock.mock.calls[0]![0] as string);
    expect(url.searchParams.get('api_key')).toBe('sk-ctx');
    expect(url.searchParams.get('mailto')).toBe('ctx@example.com');
  });

  it('年份过滤与 perPage 透传进 URL', async () => {
    const fetchMock = okFetch();
    const result = await openAlexSearchTool.run(
      { query: 'q', perPage: 10, yearFrom: 2020, yearTo: 2025, sort: 'cited_by_count:desc' },
      { mockTools: false, fetch: fetchMock as unknown as typeof fetch },
    );
    const url = new URL(fetchMock.mock.calls[0]![0] as string);
    expect(url.searchParams.get('per_page')).toBe('10');
    expect(url.searchParams.get('sort')).toBe('cited_by_count:desc');
    expect(url.searchParams.get('filter')).toBe(
      'from_publication_date:2020-01-01,to_publication_date:2025-12-31',
    );
    expect(result.data.perPage).toBe(10);
  });

  it('缓存未命中 → 实时请求 → 写入 Redis 缓存（TTL 300s）', async () => {
    const cache = cacheStub();
    const fetchMock = okFetch();
    await openAlexSearchTool.run(
      { query: 'survey' },
      { mockTools: false, fetch: fetchMock as unknown as typeof fetch, cache },
    );
    expect(cache.getCalls).toHaveLength(1);
    expect(cache.setCalls).toHaveLength(1);
    expect(cache.setCalls[0]!.key).toBe(buildOpenAlexCacheKey({ query: 'survey' }));
    expect(cache.setCalls[0]!.ttl).toBe(OPENALEX_CACHE_TTL_SECONDS);
  });

  it('缓存命中 → 直接返回（fromCache=true），不发起请求', async () => {
    const cache = cacheStub();
    const cached: OpenAlexSearchResult = {
      query: 'survey',
      total: 7,
      perPage: 5,
      fetchedAt: '2026-01-01T00:00:00.000Z',
      fromCache: false,
      works: [normalizeWork(SAMPLE_PAYLOAD.results[1])],
    };
    await cache.set(buildOpenAlexCacheKey({ query: 'survey' }), JSON.stringify(cached), 300);

    const fetchMock = vi.fn();
    const result = await openAlexSearchTool.run(
      { query: 'survey' },
      { mockTools: false, fetch: fetchMock as unknown as typeof fetch, cache },
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.data.fromCache).toBe(true);
    expect(result.data.total).toBe(7);
    expect(result.text).toContain('来自缓存');
    expect(result.data.works[0]).toMatchObject({ title: 'Attention Is All You Need' });
  });

  it('Redis 降级（不注入 cache，测试环境 ensureRedis 返回 null）→ 跳过缓存走实时', async () => {
    const fetchMock = okFetch();
    const result = await openAlexSearchTool.run(
      { query: 'survey' },
      { mockTools: false, fetch: fetchMock as unknown as typeof fetch },
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.data.fromCache).toBe(false);
    expect(result.data.works).toHaveLength(2);
  });

  it('HTTP 非 2xx → 抛错（含状态码）', async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, status: 429 }) as unknown as Response);
    await expect(
      openAlexSearchTool.run({ query: 'q' }, { mockTools: false, fetch: fetchMock as unknown as typeof fetch }),
    ).rejects.toThrow('HTTP 429');
  });

  it('网络错误 → 抛错（含原因）', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('ENOTFOUND openalex.org');
    });
    await expect(
      openAlexSearchTool.run({ query: 'q' }, { mockTools: false, fetch: fetchMock as unknown as typeof fetch }),
    ).rejects.toThrow('openalex_search: 请求失败 - ENOTFOUND openalex.org');
  });

  it('请求中止（AbortError）→ 抛超时错误', async () => {
    const abortError = new Error('The operation was aborted');
    abortError.name = 'AbortError';
    const fetchMock = vi.fn(async () => {
      throw abortError;
    });
    await expect(
      openAlexSearchTool.run({ query: 'q' }, { mockTools: false, fetch: fetchMock as unknown as typeof fetch }),
    ).rejects.toThrow('请求超时');
  });

  it('无 fetch 注入且全局无 fetch → 抛错', async () => {
    const originalFetch = globalThis.fetch;
    // @ts-expect-error 模拟无 fetch 环境
    delete globalThis.fetch;
    try {
      await expect(openAlexSearchTool.run({ query: 'q' }, { mockTools: false })).rejects.toThrow(
        '不支持 fetch',
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ---------------------------------------------------------------------------
// 缓存键与注册
// ---------------------------------------------------------------------------

describe('缓存键 / 注册', () => {
  it('缓存键稳定且随参数变化', () => {
    const a = buildOpenAlexCacheKey({ query: 'rag', perPage: 5 });
    const b = buildOpenAlexCacheKey({ query: 'rag', perPage: 5 });
    const c = buildOpenAlexCacheKey({ query: 'rag', perPage: 10 });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a.startsWith('tool:openalex:')).toBe(true);
  });

  it('import tools/index 后注册表包含 openalex_search', async () => {
    await import('../../src/lib/tools/index.js');
    expect(registeredToolNames()).toContain('openalex_search');
    expect(getTool('openalex_search')?.name).toBe('openalex_search');
  });
});

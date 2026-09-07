/**
 * OpenAI 及 OpenAI compatible provider。
 *
 *  - type=openai：默认 baseURL=https://api.openai.com/v1，可用 config.baseURL 覆盖；
 *  - type=openai_compatible：必须通过 config.baseURL 指向第三方兼容端点。
 *
 * 统一走原生 fetch：
 *   chat -> POST {baseURL}/chat/completions（stream=true 感知 SSE，归一化为 delta/usage/done）；
 *   embedding -> POST {baseURL}/embeddings；
 *   ping   -> 极小化 chat（max_tokens=1）验证密钥/连通性。
 */
import type {
  EmbeddingRequest,
  EmbeddingResult,
  ModelStreamEvent,
  ProviderTypeValue,
  RerankRequest,
  RerankResult,
} from '@pulse/contracts';
import { ProviderAuthError, ProviderError, ProviderUnavailableError } from '../errors.js';
import { parseSseDataLines } from '../sse.js';
import type { ChatInvocation, ModelDescriptor, ModelProvider, PingResult, ProviderDescriptor } from '../types.js';

const DEFAULT_BASEURL = 'https://api.openai.com/v1';

interface UpstreamErrorBody {
  error?: { message?: string; type?: string };
  message?: string;
}

export class OpenAICompatibleProvider implements ModelProvider {
  constructor(readonly type: ProviderTypeValue = 'openai') {}

  private baseURL(provider: ProviderDescriptor): string {
    const cfgBase = provider.config?.baseURL;
    if (typeof cfgBase === 'string' && cfgBase.trim().length > 0) {
      return cfgBase.replace(/\/+$/, '');
    }
    if (this.type === 'openai_compatible') {
      throw new ProviderError('openai_compatible 必须在 config.baseURL 配置第三方端点');
    }
    return DEFAULT_BASEURL;
  }

  private apiKey(provider: ProviderDescriptor): string {
    const key = provider.credentials.apiKey;
    if (typeof key !== 'string' || key.length === 0) {
      throw new ProviderAuthError(`Provider「${provider.name}」未配置 apiKey`);
    }
    return key;
  }

  async *chatStream(
    provider: ProviderDescriptor,
    model: ModelDescriptor,
    request: ChatInvocation,
  ): AsyncIterable<ModelStreamEvent> {
    const base = this.baseURL(provider);
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.apiKey(provider)}`,
      },
      body: JSON.stringify({
        model: model.name,
        messages: request.messages,
        temperature: request.temperature,
        max_tokens: request.maxTokens,
        stream: true,
      }),
    });

    if (!res.ok) throw await errorFromResponse(res, base);

    const body = res.body;
    if (!body) throw new ProviderUnavailableError('上游未返回响应体');

    let full = '';
    for await (const data of parseSseDataLines(body)) {
      let chunk: unknown;
      try {
        chunk = JSON.parse(data) as unknown;
      } catch {
        continue;
      }
      const delta = extractOpenAIDelta(chunk);
      if (delta) {
        full += delta;
        yield { type: 'delta', content: delta };
      }
    }

    yield { type: 'usage', inputTokens: estimateTokens(request.messages), outputTokens: estimateTokens(full), model: model.name };
    yield { type: 'done', id: model.id };
  }

  async embedding(
    provider: ProviderDescriptor,
    model: ModelDescriptor,
    request: EmbeddingRequest,
  ): Promise<EmbeddingResult> {
    const base = this.baseURL(provider);
    // 通过 model.config.dimensions 支持指定向量维度（如 qwen3.7-text-embedding 默认 1024，
    // 但 pgvector 列为 1536 维，需显式传 dimensions 保持一致）。
    const cfgDimensions =
      typeof model.config?.dimensions === 'number' && Number.isFinite(model.config.dimensions)
        ? model.config.dimensions
        : undefined;
    const body: Record<string, unknown> = { model: model.name, input: request.input };
    if (cfgDimensions !== undefined) body.dimensions = cfgDimensions;
    const res = await fetch(`${base}/embeddings`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.apiKey(provider)}`,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw await errorFromResponse(res, base);
    const json = (await res.json()) as {
      data?: Array<{ embedding: number[] }>;
      model?: string;
    };
    const data = json.data ?? [];
    return {
      model: json.model ?? model.name,
      dimensions: data[0]?.embedding.length ?? 0,
      embeddings: data.map((d) => d.embedding),
    };
  }

  async ping(
    provider: ProviderDescriptor,
    model: ModelDescriptor,
  ): Promise<PingResult> {
    const started = Date.now();
    const base = this.baseURL(provider);
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.apiKey(provider)}`,
      },
      body: JSON.stringify({
        model: model.name,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 1,
        stream: false,
      }),
    });
    const latencyMs = Date.now() - started;
    if (!res.ok) throw await errorFromResponse(res, base);
    const json = (await res.json().catch(() => null)) as { model?: string } | null;
    return { latencyMs, model: json?.model ?? model.name };
  }

  /**
   * rerank：POST {baseURL}/reranks。
   *
   * 请求体扁平：{ model, query, documents, top_n?, instruct? }；
   * 响应扁平：{ results: [{ index, relevance_score }], usage: { total_tokens } }。
   * 本实现把上游扁平字段归一化为 RerankResult 契约
   * （relevance_score → relevanceScore、total_tokens → totalTokens）。
   *
   * 说明：qwen3-rerank 走阿里云百炼 DashScope 的 compatible-api 端点
   * `https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/compatible-api/v1/reranks`，
   * 故 provider.config.baseURL 需配置为
   * `https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/compatible-api/v1`，
   * credentials.apiKey 为 DASHSCOPE_API_KEY。
   */
  async rerank(
    provider: ProviderDescriptor,
    model: ModelDescriptor,
    request: RerankRequest,
  ): Promise<RerankResult> {
    const base = this.baseURL(provider);
    const res = await fetch(`${base}/reranks`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.apiKey(provider)}`,
      },
      body: JSON.stringify({
        model: model.name,
        query: request.query,
        documents: request.documents,
        ...(request.topN !== undefined ? { top_n: request.topN } : {}),
        ...(request.instruct !== undefined ? { instruct: request.instruct } : {}),
      }),
    });
    if (!res.ok) throw await errorFromResponse(res, base);
    const json = (await res.json()) as unknown;
    const parsed = parseFlatRerank(json);
    return {
      model: parsed.model ?? model.name,
      results: parsed.results,
      usage: parsed.totalTokens !== undefined ? { totalTokens: parsed.totalTokens } : undefined,
    };
  }
}

/** 从 OpenAI 流式 chunk 中抽取增量文本 */
function extractOpenAIDelta(chunk: unknown): string | undefined {
  if (!isRecord(chunk)) return undefined;
  const choices = chunk.choices;
  if (!Array.isArray(choices) || choices.length === 0) return undefined;
  const first = choices[0];
  if (!isRecord(first)) return undefined;
  const deltaMap = first.delta;
  const content = isRecord(deltaMap) ? deltaMap.content : undefined;
  return typeof content === 'string' ? content : undefined;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/** 简单估算 token（中文按 ~1 token/字，英文按 ~4 字符） */
function estimateTokens(text: string | Array<{ content: string }>): number {
  const content = Array.isArray(text) ? text.map((m) => m.content).join('') : text;
  return Math.max(1, Math.ceil(content.length / 2));
}

async function errorFromResponse(res: Response, base: string): Promise<ProviderError> {
  let body: UpstreamErrorBody = {};
  try {
    body = (await res.json()) as UpstreamErrorBody;
  } catch {
    /* 非 JSON 错误体 */
  }
  const detail = body.error?.message ?? body.message ?? `HTTP ${res.status}`;
  const message = `Provider 请求失败（${base}）: ${detail}`;
  if (res.status === 401 || res.status === 403) {
    return new ProviderAuthError(message);
  }
  return new ProviderError(message, res.status);
}

/** 上游 rerank 响应（qwen3-rerank compatible-api 扁平结构） */
interface FlatRerankResponse {
  results?: Array<{ index?: unknown; relevance_score?: unknown }>;
  usage?: { total_tokens?: unknown };
  model?: unknown;
}

/** 解析扁平 rerank 响应，归一化为 RerankResult 内部态（index/relevanceScore/totalTokens） */
function parseFlatRerank(json: unknown): {
  results: Array<{ index: number; relevanceScore: number }>;
  model?: string;
  totalTokens?: number;
} {
  const body = isRecord(json) ? (json as FlatRerankResponse) : {};
  const results: Array<{ index: number; relevanceScore: number }> = [];
  if (Array.isArray(body.results)) {
    for (const item of body.results) {
      if (!isRecord(item)) continue;
      const index = Number(item.index);
      const relevanceScore = Number(item.relevance_score);
      if (Number.isFinite(index) && Number.isFinite(relevanceScore)) {
        results.push({ index, relevanceScore });
      }
    }
  }
  // 上游可能在缺省 top_n 时只返回部分高分文档；缺失的 index 由调用方以 null 处理
  const totalTokens =
    isRecord(body.usage) && typeof body.usage.total_tokens === 'number'
      ? body.usage.total_tokens
      : undefined;
  const model = typeof body.model === 'string' ? body.model : undefined;
  return { results, totalTokens, model };
}
/**
 * Anthropic Claude provider。
 *   chat -> POST {base}/v1/messages（stream=true，解析 Anthropic SSE 事件）；
 *   embedding —— Anthropic 官方无 embedding，抛出 ProviderError（由路由转 422/502）；
 *   ping -> 极小化 chat 验证密钥/连通性。
 */
import type { ChatInvocation, ModelDescriptor, ModelProvider, PingResult, ProviderDescriptor } from '../types.js';
import type { EmbeddingResult, ModelStreamEvent, RerankRequest, RerankResult } from '@pulse/contracts';
import { ProviderAuthError, ProviderError } from '../errors.js';
import { parseSseDataLines } from '../sse.js';

const DEFAULT_BASEURL = 'https://api.anthropic.com';
const ANTHROPIC_VERSION = '2023-06-01';

export class AnthropicProvider implements ModelProvider {
  readonly type = 'anthropic' as const;

  private baseURL(provider: ProviderDescriptor): string {
    const cfgBase = provider.config?.baseURL;
    if (typeof cfgBase === 'string' && cfgBase.trim().length > 0) {
      return cfgBase.replace(/\/+$/, '');
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
    const res = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.apiKey(provider),
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model: model.name,
        messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
        temperature: request.temperature ?? 1,
        max_tokens: request.maxTokens ?? 1024,
        stream: true,
      }),
    });

    if (!res.ok) throw await errorFromResponse(res, base);
    const body = res.body;
    if (!body) throw new ProviderError('上游未返回响应体');

    let full = '';
    let inputTokens = 0;
    let outputTokens = 0;
    for await (const data of parseSseDataLines(body)) {
      let evt: unknown;
      try {
        evt = JSON.parse(data) as unknown;
      } catch {
        continue;
      }
      if (!isRecord(evt)) continue;
      if (evt.type === 'message_start' && isRecord(evt.message)) {
        inputTokens = num(evt.message.usage, 'input_tokens');
      } else if (evt.type === 'content_block_delta' && isRecord(evt.delta)) {
        const text = evt.delta.text;
        if (typeof text === 'string' && text.length > 0) {
          full += text;
          yield { type: 'delta', content: text };
        }
      } else if (evt.type === 'message_delta' && isRecord(evt.usage)) {
        outputTokens = num(evt.usage, 'output_tokens');
      }
    }

    yield {
      type: 'usage',
      inputTokens: inputTokens || estimateTokens(request.messages),
      outputTokens: outputTokens || estimateTokens(full),
      model: model.name,
    };
    yield { type: 'done', id: model.id };
  }

  async embedding(): Promise<EmbeddingResult> {
    throw new ProviderError('Anthropic Claude 不提供 embedding 能力，请选用 openai / openai_compatible');
  }

  async rerank(
    _provider: ProviderDescriptor,
    model: ModelDescriptor,
    _request: RerankRequest,
  ): Promise<RerankResult> {
    throw new ProviderError(
      `Anthropic「${model.name}」不提供 rerank 能力，请选用 openai_compatible（如阿里云百炼 qwen3-rerank）`,
    );
  }

  async ping(
    provider: ProviderDescriptor,
    model: ModelDescriptor,
  ): Promise<PingResult> {
    const started = Date.now();
    const base = this.baseURL(provider);
    const res = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.apiKey(provider),
        'anthropic-version': ANTHROPIC_VERSION,
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
    return { latencyMs, model: model.name };
  }
}

function num(obj: unknown, key: string): number {
  return typeof obj === 'object' && obj !== null && typeof (obj as Record<string, unknown>)[key] === 'number'
    ? ((obj as Record<string, unknown>)[key] as number)
    : 0;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function estimateTokens(text: string | Array<{ content: string }>): number {
  const content = Array.isArray(text) ? text.map((m) => m.content).join('') : text;
  return Math.max(1, Math.ceil(content.length / 2));
}

async function errorFromResponse(res: Response, base: string): Promise<ProviderError> {
  let detail = `HTTP ${res.status}`;
  try {
    const body = (await res.json()) as { error?: { message?: string } | string };
    if (typeof body.error === 'string') detail = body.error;
    else if (body.error?.message) detail = body.error.message;
  } catch {
    /* ignore */
  }
  const message = `Provider 请求失败（${base}）: ${detail}`;
  if (res.status === 401 || res.status === 403) {
    return new ProviderAuthError(message);
  }
  return new ProviderError(message, res.status);
}
/**
 * API 客户端 —— 统一响应信封 { success, data } / { success, error } 解析。
 * 所有请求走 vite dev 代理 /api → 后端（默认 http://localhost:3011）。
 */
import type { ApiFailure } from '@pulse/contracts';

export class ApiError extends Error {
  readonly code: string;
  readonly details?: unknown;
  readonly status?: number;

  constructor(code: string, message: string, details?: unknown, status?: number) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.details = details;
    this.status = status;
  }
}

export interface SseEvent {
  /** SSE event 字段（如 delta / usage / done / error / meta / node_end） */
  event: string;
  /** 解析后的 JSON 数据 */
  data: Record<string, unknown>;
  /** 原始 data 文本 */
  raw: string;
}

const JSON_HEADERS = { 'Content-Type': 'application/json' };

async function parseEnvelope<T>(res: Response): Promise<T> {
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new ApiError('BAD_RESPONSE', `响应不是合法 JSON（HTTP ${res.status}）`, undefined, res.status);
  }
  if (!body || typeof body !== 'object') {
    throw new ApiError('BAD_RESPONSE', '响应格式错误', undefined, res.status);
  }
  const envelope = body as { success: boolean; data?: T; error?: ApiFailure['error'] };
  if (envelope.success === true) {
    return envelope.data as T;
  }
  throw new ApiError(
    envelope.error?.code ?? 'UNKNOWN_ERROR',
    envelope.error?.message ?? '请求失败',
    envelope.error?.details,
    res.status,
  );
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api/v1${path}`, init);
  return parseEnvelope<T>(res);
}

export function get<T>(path: string): Promise<T> {
  return request<T>(path, { method: 'GET' });
}

export function post<T>(path: string, body?: unknown): Promise<T> {
  return request<T>(path, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export function patch<T>(path: string, body?: unknown): Promise<T> {
  return request<T>(path, {
    method: 'PATCH',
    headers: JSON_HEADERS,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export function del<T>(path: string): Promise<T> {
  return request<T>(path, { method: 'DELETE' });
}

/** multipart 文件上传（不手动设置 Content-Type，由浏览器带 boundary） */
export function upload<T>(path: string, file: File): Promise<T> {
  const form = new FormData();
  form.append('file', file);
  return request<T>(path, { method: 'POST', body: form });
}

function parseSseBlock(block: string): SseEvent | null {
  const lines = block.split('\n');
  let event = 'message';
  const dataLines: string[] = [];
  for (const line of lines) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
  }
  if (dataLines.length === 0) return null;
  const raw = dataLines.join('\n');
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return { event, data: { __raw: raw }, raw };
  }
  return { event, data, raw };
}

/**
 * POST 发起 SSE 流式请求（Agent 对话测试 / 工作流运行测试）。
 * 返回逐块解析出的 SSE 事件迭代器。流前错误（如 404 / 校验失败）以 ApiError 抛出。
 */
export async function* sseStream(path: string, body: unknown): AsyncGenerator<SseEvent> {
  const res = await fetch(`/api/v1${path}`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  });
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '');
    let message = `SSE 请求失败（HTTP ${res.status}）`;
    let code = 'SSE_ERROR';
    try {
      const parsed = JSON.parse(text) as ApiFailure;
      if (!parsed.success && parsed.error) {
        code = parsed.error.code;
        message = parsed.error.message;
      }
    } catch {
      // 非 JSON 失败体，保留默认消息
    }
    throw new ApiError(code, message, undefined, res.status);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.split('\n\n');
      buffer = blocks.pop() ?? '';
      for (const block of blocks) {
        const evt = parseSseBlock(block);
        if (evt) yield evt;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

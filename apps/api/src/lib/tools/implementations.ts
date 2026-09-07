/**
 * M-A 内置工具实现。
 *
 *  - local_retrieval：封装混合检索（query + datasetIds + topK），返回本地知识库命中；
 *    复用 Agent 绑定 rerank 模型的可选项（ctx.agent.rerankModelId）。
 *  - http_request：通用第三方 GET（校验 http/https、超时），返回 {status, data}。
 *
 * 两个实现仅依赖注入的 ctx（retrieve / fetch），保证在无 DB、无外网的单测中可注入 stub 验证。
 */
import { z } from 'zod';
import type { RetrievalHitView, RetrievalResult } from '@pulse/contracts';
import type { Tool } from './types.js';

// ---------------------------------------------------------------------------
// local_retrieval：本地知识库检索
// ---------------------------------------------------------------------------

export const localRetrievalArgsSchema = z.object({
  /** 检索问题（缺省取用户原问） */
  query: z.string().trim().min(1).max(2048).optional(),
  /** 限定检索的知识库 id 子集（缺省用 Agent 绑定的全部知识库） */
  datasetIds: z.array(z.string().uuid()).max(100).optional(),
  /** 召回条数（1-20，缺省 6） */
  topK: z.number().int().min(1).max(20).optional(),
});
export type LocalRetrievalArgs = z.infer<typeof localRetrievalArgsSchema>;

export interface LocalRetrievalResult {
  query: string;
  datasetIds: string[];
  total: number;
  hits: RetrievalHitView[];
}

function formatHits(hits: RetrievalHitView[]): string {
  if (hits.length === 0) return '（未命中任何资料）';
  return hits
    .map((h, i) => {
      const doc =
        typeof h.metadata?.documentName === 'string' ? h.metadata.documentName : '未知文档';
      return `${i + 1}. [${doc}] ${h.content}`;
    })
    .join('\n');
}

export const localRetrievalTool: Tool<LocalRetrievalArgs, LocalRetrievalResult> = {
  name: 'local_retrieval',
  description:
    '检索 Agent 绑定的本地知识库，返回与问题相关的资料片段（含来源文档名）。当用户问题需要基于本地知识库资料回答时调用。',
  parameters: localRetrievalArgsSchema,
  run: async (args, ctx) => {
    const retrieve = ctx.retrieve as
      | ((query: string, datasetIds: string[], topK: number, rerankModelId?: string | null) => Promise<RetrievalResult>)
      | undefined;
    if (!retrieve) {
      throw new Error('local_retrieval: 未注入检索实现（ctx.retrieve）');
    }
    const datasetIds = args.datasetIds ?? ctx.agent?.datasets?.map((d) => d.datasetId) ?? [];
    if (datasetIds.length === 0) {
      throw new Error('local_retrieval: Agent 未绑定知识库，无法检索');
    }
    const topK = args.topK ?? 6;
    // 复用 Agent 绑定 rerank 模型的可选项（M-B 已加）
    const rerankModelId = ctx.agent?.rerankModelId ?? null;
    const result = await retrieve(args.query ?? '', datasetIds, topK, rerankModelId);
    const data: LocalRetrievalResult = {
      query: result.query,
      datasetIds: result.datasetIds,
      total: result.total,
      hits: result.hits,
    };
    return {
      text: `[local_retrieval 命中 ${data.total} 条] 问题：${data.query}\n${formatHits(data.hits)}`,
      data,
    };
  },
};

// ---------------------------------------------------------------------------
// http_request：通用第三方 GET（M-C OpenAlex/web 实时工具的地基形态）
// ---------------------------------------------------------------------------

export const httpRequestArgsSchema = z.object({
  /** 目标 URL（仅允许 http/https） */
  url: z.string().url().max(2048),
  /** 超时（毫秒，缺省 8000） */
  timeoutMs: z.number().int().min(100).max(60_000).optional(),
  /** 请求头（可选，如 Accept） */
  headers: z.record(z.string(), z.string()).optional(),
});
export type HttpRequestArgs = z.infer<typeof httpRequestArgsSchema>;

export interface HttpRequestResult {
  status: number;
  data: unknown;
}

/** 通过 URL 协议白名单校验（http/https only） */
export function assertHttpUrl(url: string): void {
  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`http_request: 仅允许 http/https 协议，收到 ${parsed.protocol}`);
  }
}

export const httpRequestTool: Tool<HttpRequestArgs, HttpRequestResult> = {
  name: 'http_request',
  description:
    '向第三方服务发起 GET 请求（仅 http/https，内置超时），返回 {status, data}。适用于查询外部实时数据。',
  parameters: httpRequestArgsSchema,
  isEnabled: (ctx) => ctx.httpRequest !== false,
  run: async (args, ctx) => {
    assertHttpUrl(args.url);
    const fetchImpl =
      (ctx.fetch as typeof fetch | undefined) ??
      (typeof globalThis !== 'undefined' ? globalThis.fetch : undefined);
    if (!fetchImpl) {
      throw new Error('http_request: 当前环境不支持 fetch');
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), args.timeoutMs ?? 8000);
    try {
      const response = await fetchImpl(args.url, {
        method: 'GET',
        headers: args.headers,
        signal: controller.signal,
      });
      const text = await response.text();
      let data: unknown = text;
      try {
        data = JSON.parse(text);
      } catch {
        // 非 JSON 响应保留原文
      }
      return { text: `[http_request ${response.status}] ${response.url}\n${String(text).slice(0, 4000)}`, data: { status: response.status, data } };
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error(`http_request: 请求超时（>${args.timeoutMs ?? 8000}ms）`);
      }
      throw new Error(`http_request: 请求失败 - ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      clearTimeout(timeout);
    }
  },
};

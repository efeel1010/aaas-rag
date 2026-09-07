/**
 * M-A 工具集（Tool Registry）—— 工具接口与结果结构。
 *
 * 约定：第三方实时工具（OpenAlex / web 等，M-C 起）与本地数据工具（local_retrieval）
 * 统一实现 Tool 接口后注册进 ToolRegistry，供 ReAct 工具循环（tool-call-loop）调用。
 *
 * 设计要点：
 *  - parameters 用 Zod schema 描述参数（作为 JSON Schema 化清单交给 LLM 决策）；
 *  - run(args, ctx) 返回 ToolResult：text 用于拼回 LLM 上下文，data 用于结构化展示；
 *  - isEnabled? 允许运行环境按配置开关（如 http_request 可在受控环境禁用）。
 */
import type { z } from 'zod';

/** 工具执行上下文（由装配方注入；含 Agent 运行时上下文与可选检索实现） */
export interface ToolContext {
  /** Agent 运行时上下文（模型/知识库/意图/rerank 等） */
  agent?: {
    agentId: string;
    rerankModelId: string | null;
    datasets: { datasetId: string; datasetName: string | null; weight: number }[];
    [key: string]: unknown;
  };
  /** local_retrieval 的检索实现；由装配方注入（便于测试注入 stub / 复用 hybridRetrieve） */
  retrieve?: (query: string, datasetIds: string[], topK: number, rerankModelId?: string | null) => Promise<unknown>;
  [key: string]: unknown;
}

/** 工具参数类型（Zod manifest 推导出的运行时类型） */
export type ToolParameters<TArgs> = z.ZodType<TArgs>;

/** 工具执行结果：text 用于拼回 LLM prompt 上下文；data 用于结构化透出 */
export interface ToolResult<TData = unknown> {
  /** 人类可读文本表示（回填 LLM 上下文时使用） */
  text: string;
  /** 结构化数据（SSE/JSON 透出用，可序列化为 JSON） */
  data: TData;
}

/** 工具调用记录（透出给调用方 / 契约层） */
export interface ToolRunOutcome {
  name: string;
  args: Record<string, unknown>;
  status: 'success' | 'error' | 'skipped';
  latencyMs: number;
  /** 工具结果 text 表示（仅成功时） */
  text?: string;
  /** 工具结果结构化数据（仅成功时） */
  data?: unknown;
  /** 失败原因（仅 error 时） */
  error?: string;
}

/**
 * 工具接口。实现方需提供：
 *  - name/description/parameters：供 LLM 决策的工具清单（manifest）；
 *  - run(args, ctx)：执行并返回 ToolResult；
 *  - isEnabled?(ctx)：可选，返回 false 时工具被过滤（视为不可用）。
 */
export interface Tool<TArgs = unknown, TResult = unknown> {
  readonly name: string;
  readonly description: string;
  /** 参数声明（Zod schema），供 LLM 决策时生成工具清单 JSON Schema */
  readonly parameters: ToolParameters<TArgs>;
  /** 是否启用（缺省恒启用）；返回 false 时从可用清单剔除 */
  isEnabled?(ctx: ToolContext): boolean;
  run(args: TArgs, ctx: ToolContext): Promise<ToolResult<TResult>>;
}

/** 运行期参数合法性校验辅助：按工具 parameters 解析 args（失败抛错） */
export function validateArgs<T>(tool: Tool<T>, args: unknown): T {
  return tool.parameters.parse(args) as T;
}

/** 把 ToolResult 文本表示接入 LLM 上下文（保留结构化 data 供透出） */
export function outcomeToText(outcome: ToolRunOutcome): string {
  if (outcome.status === 'error') return `（工具 ${outcome.name} 调用失败：${outcome.error ?? '未知错误'}）`;
  if (outcome.status === 'skipped') return `（工具 ${outcome.name} 未执行）`;
  return outcome.text ?? `（工具 ${outcome.name} 无文本输出）`;
}

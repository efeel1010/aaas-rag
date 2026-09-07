/**
 * ToolRegistry —— 工具注册 / 按名取 / 列出，并从 Agent 启用的工具配置装配运行时工具集。
 *
 *  - register：把工具实现注册进全局注册表（内置工具在模块加载时注册）；
 *  - get/list：按名取 / 列出全部已注册工具；
 *  - assemble(names, ctx)：把「Agent 启用的工具名」解析为「可用工具数组」——
 *    过滤未注册名与 isEnabled() 为 false 的工具（未注册工具被静默过滤，不阻塞编排）。
 */
import type { Tool, ToolContext } from './types.js';

type AnyTool = Tool;

const registry = new Map<string, AnyTool>();

export function registerTool(tool: AnyTool): void {
  registry.set(tool.name, tool);
}

export function getTool(name: string): AnyTool | undefined {
  return registry.get(name);
}

export function listTools(): AnyTool[] {
  return [...registry.values()];
}

export function hasTool(name: string): boolean {
  return registry.has(name);
}

/**
 * 从持久化配置（Agent 启用的工具名列表）装配运行时可用工具集。
 * 按声明顺序保持；重复名去重；未注册 / 未启用（isEnabled=false）的工具被过滤。
 */
export function assembleTools(
  names: string[],
  ctx: ToolContext = {},
): Tool[] {
  const seen = new Set<string>();
  const tools: Tool[] = [];
  for (const name of names) {
    if (seen.has(name)) continue;
    seen.add(name);
    const tool = registry.get(name);
    if (!tool) continue;
    if (tool.isEnabled && !tool.isEnabled(ctx)) continue;
    tools.push(tool);
  }
  return tools;
}

/** 全局注册表清理（仅测试用：避免跨用例污染） */
export function clearToolRegistry(): void {
  registry.clear();
}

/** 注册表当前工具名清单（测试/调试用） */
export function registeredToolNames(): string[] {
  return [...registry.keys()];
}

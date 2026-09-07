/**
 * M-A ToolRegistry 单测 —— 注册 / 按名取 / 列出 / 从 Agent 配置装配运行时工具集。
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { z } from 'zod';
import {
  assembleTools,
  clearToolRegistry,
  getTool,
  hasTool,
  listTools,
  registerTool,
  registeredToolNames,
} from '../../src/lib/tools/registry.js';
import type { Tool } from '../../src/lib/tools/types.js';

const echoTool: Tool<{ text: string }, { text: string }> = {
  name: 'echo',
  description: '回显输入',
  parameters: z.object({ text: z.string() }),
  run: async (args) => ({ text: `echo:${args.text}`, data: { text: args.text } }),
};

const disabledTool: Tool = {
  name: 'secret_tool',
  description: '环境禁用工具',
  parameters: z.object({}),
  isEnabled: (ctx) => ctx.allowSecret === true,
  run: async () => ({ text: 'secret', data: null }),
};

beforeEach(() => clearToolRegistry());

describe('ToolRegistry 注册与查询', () => {
  it('register/get/has/list 全链路', () => {
    expect(hasTool('echo')).toBe(false);
    registerTool(echoTool);
    expect(hasTool('echo')).toBe(true);
    expect(getTool('echo')?.name).toBe('echo');
    expect(listTools().map((t) => t.name)).toEqual(['echo']);
    expect(registeredToolNames()).toEqual(['echo']);
  });

  it('重复注册同名工具以后注册者覆盖', () => {
    registerTool(echoTool);
    registerTool({ ...echoTool, description: '覆盖版' });
    expect(getTool('echo')?.description).toBe('覆盖版');
  });

  it('clearToolRegistry 清空注册表', () => {
    registerTool(echoTool);
    clearToolRegistry();
    expect(hasTool('echo')).toBe(false);
    expect(listTools()).toEqual([]);
  });
});

describe('assembleTools（从 Agent 配置装配运行时工具集）', () => {
  it('按声明顺序装配已注册工具，重复名去重', () => {
    registerTool(echoTool);
    const tools = assembleTools(['echo', 'echo', 'unknown_tool'], {});
    expect(tools.map((t) => t.name)).toEqual(['echo']);
  });

  it('未注册工具被静默过滤（不阻塞编排）', () => {
    registerTool(echoTool);
    const tools = assembleTools(['echo', 'not_registered'], {});
    expect(tools.map((t) => t.name)).toEqual(['echo']);
  });

  it('isEnabled 返回 false 的工具被过滤（按上下文开关）', () => {
    registerTool(disabledTool);
    expect(assembleTools(['secret_tool'], {}).map((t) => t.name)).toEqual([]);
    expect(assembleTools(['secret_tool'], { allowSecret: true }).map((t) => t.name)).toEqual([
      'secret_tool',
    ]);
  });

  it('空配置返回空数组', () => {
    registerTool(echoTool);
    expect(assembleTools([], {})).toEqual([]);
  });
});

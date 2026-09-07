/**
 * M5 节点执行器单测 —— 各节点类型从变量空间读、写增量的语义。
 */
import { describe, expect, it, vi } from 'vitest';
import type { WorkflowNodeType, RetrievalResult } from '@pulse/contracts';
import { executeNode, parseWorkflowNode } from '../../src/services/workflow-engine/executors.js';
import type { ExecutorDeps, WorkflowEdgeDefinition, WorkflowNodeDefinition, WorkflowState } from '../../src/services/workflow-engine/types.js';

const UUID = '00000000-0000-0000-0000-000000000000';
const MODEL_ID = '22222222-2222-2222-2222-222222222222';
const DS_ID = '33333333-3333-3333-3333-333333333333';

function node(type: WorkflowNodeType, data: Record<string, unknown>, name: string | null = null): ReturnType<typeof parseWorkflowNode> {
  const def: WorkflowNodeDefinition = { id: `n-${type}`, type, name, data };
  return parseWorkflowNode(def);
}

function edge(overrides: Partial<WorkflowEdgeDefinition> = {}): WorkflowEdgeDefinition {
  return {
    id: 'e1',
    sourceNodeId: 'src',
    targetNodeId: 'dst',
    condition: null,
    ...overrides,
  };
}

function state(variables: Record<string, unknown> = {}, inputs: Record<string, unknown> = {}): WorkflowState {
  return { inputs, variables, outputs: {} };
}

function deps(overrides: Partial<ExecutorDeps> = {}): ExecutorDeps {
  return {
    isMock: () => true,
    completeChat: vi.fn(async (input: { prompt: string }) => `echo:${input.prompt}`),
    retrieve: vi.fn(
      async (
        query: string,
        datasetIds: string[],
        topK: number,
        _rerankModelId?: string | null,
      ): Promise<RetrievalResult> => ({
        query,
        datasetIds,
        topK,
        total: 1,
        hits: [
          {
            chunkId: 'c1',
            documentId: 'd1',
            datasetId: datasetIds[0] ?? DS_ID,
            content: '本店支持7天无理由退货',
            tokens: 4,
            metadata: { documentName: '售后.md' },
            score: 0.8,
            vectorScore: 0.8,
            keywordScore: null,
            source: 'vector',
          },
        ],
      }),
    ),
    http: vi.fn(async () => ({ status: 200, data: { ok: true }, headers: { 'x-src': 'test' } })),
    ...overrides,
  };
}

describe('start / end', () => {
  it('start：把 inputs 全部注入变量空间', async () => {
    const d = deps();
    const result = await executeNode(node('start', {}), state({}, { query: 'hi', uid: 'u1' }), [], d);
    expect(result.variables).toEqual({ query: 'hi', uid: 'u1' });
  });

  it('end：按 outputs 字段映射变量；缺省输出全部变量', async () => {
    const d = deps();
    const mapped = await executeNode(
      node('end', { outputs: [{ name: 'out', from: 'answer' }] }),
      state({ answer: '你好', extra: 1 }),
      [],
      d,
    );
    expect(mapped.outputs).toEqual({ out: '你好' });

    const all = await executeNode(node('end', {}), state({ a: 1, b: 'x' }), [], d);
    expect(all.outputs).toEqual({ a: 1, b: 'x' });
  });
});

describe('llm', () => {
  it('渲染 prompt 模板并调用 completeChat，结果写入 output 变量', async () => {
    const d = deps();
    const result = await executeNode(
      node('llm', { modelId: MODEL_ID, prompt: '你好 {{name}}', output: 'answer' }),
      state({ name: '世界' }),
      [],
      d,
    );
    expect(d.completeChat).toHaveBeenCalledWith({
      modelId: MODEL_ID,
      system: undefined,
      prompt: '你好 世界',
      temperature: undefined,
      maxTokens: undefined,
      engine: 'gateway',
    });
    expect(result.variables).toEqual({ answer: 'echo:你好 世界' });
  });
});

describe('knowledge_retrieval', () => {
  it('渲染 query、调用混合检索，写入 RetrievalResult + 可选上下文文本', async () => {
    const d = deps();
    const result = await executeNode(
      node('knowledge_retrieval', {
        query: '{{query}}',
        datasetIds: [DS_ID],
        topK: 3,
        output: 'retrieval',
        contextOutput: 'context',
      }),
      state({ query: '怎么退货' }),
      [],
      d,
    );
    expect(d.retrieve).toHaveBeenCalledWith('怎么退货', [DS_ID], 3, undefined);
    expect(result.variables?.retrieval).toMatchObject({ query: '怎么退货', total: 1 });
    expect(result.variables?.context).toContain('[知识库检索结果]');
    expect(result.variables?.context).toContain('7天无理由退货');
  });

  it('datasetIdsVariable 从变量读取知识库列表（优先于固定列表）', async () => {
    const d = deps();
    await executeNode(
      node('knowledge_retrieval', { query: 'q', datasetIds: [DS_ID], datasetIdsVariable: 'ds.list' }),
      state({ ds: { list: [UUID] } }),
      [],
      d,
    );
    expect(d.retrieve).toHaveBeenCalledWith('q', [UUID], 6, undefined);
  });

  it('rerankModelId 节点配置 → 检索第 4 参透传', async () => {
    const d = deps();
    await executeNode(
      node('knowledge_retrieval', { query: 'q', datasetIds: [DS_ID], rerankModelId: MODEL_ID }),
      state({}),
      [],
      d,
    );
    expect(d.retrieve).toHaveBeenCalledWith('q', [DS_ID], 6, MODEL_ID);
  });

  it('未解析到任何知识库 → 抛 WorkflowExecutionError', async () => {
    const d = deps();
    await expect(
      executeNode(node('knowledge_retrieval', { query: 'q' }), state({}), [], d),
    ).rejects.toThrow(/未解析到任何知识库/);
    expect(d.retrieve).not.toHaveBeenCalled();
  });
});

describe('intent', () => {
  it('按出边分支的 branch/examples 做确定性分类，写入 output 分支名', async () => {
    const d = deps();
    const outgoing = [
      edge({ targetNodeId: 'a', condition: { branch: '退货', examples: ['我要退货', '怎么退'] } }),
      edge({ targetNodeId: 'b', condition: { branch: '报修', examples: ['怎么报修'] } }),
    ];
    const hit = await executeNode(node('intent', { queryVariable: 'query', output: 'intent' }), state({ query: '我要退货' }), outgoing, d);
    expect(hit.variables?.intent).toBe('退货');
    const miss = await executeNode(node('intent', { queryVariable: 'query', output: 'intent' }), state({ query: '随便聊聊' }), outgoing, d);
    expect(miss.variables?.intent).toBeNull();
  });
});

describe('condition', () => {
  it('按出边条件求值，命中分支标签写入 output（可选）', async () => {
    const d = deps();
    const outgoing = [
      edge({ targetNodeId: 'a', condition: { variable: 'score', operator: 'gte', value: 80 } }),
      edge({ targetNodeId: 'b' }),
    ];
    const high = await executeNode(node('condition', { output: 'branch' }), state({ score: 90 }), outgoing, d);
    expect(high.variables?.branch).toBe('a');
    const low = await executeNode(node('condition', { output: 'branch' }), state({ score: 10 }), outgoing, d);
    expect(low.variables?.branch).toBe('b');
  });
});

describe('code', () => {
  it('node:vm 受控执行 (ctx) => Partial<variables>', async () => {
    const d = deps();
    const result = await executeNode(
      node('code', { code: '(ctx) => ({ doubled: ctx.variables.x * 2, query: ctx.inputs.query })' }),
      state({ x: 21 }, { query: 'q1' }),
      [],
      d,
    );
    expect(result.variables).toEqual({ doubled: 42, query: 'q1' });
  });

  it('非对象返回值 / 语法错误 → 抛错', async () => {
    const d = deps();
    await expect(executeNode(node('code', { code: '(ctx) => 42' }), state({}), [], d)).rejects.toThrow(/必须返回一个对象/);
    await expect(executeNode(node('code', { code: '(ctx) => {' }), state({}), [], d)).rejects.toThrow(/执行失败/);
  });
});

describe('http_request', () => {
  it('渲染 URL/Headers/Body，调用 deps.http，写入 { status, data, headers }', async () => {
    const d = deps();
    const result = await executeNode(
      node('http_request', {
        method: 'POST',
        url: 'https://api.example.com/users/{{id}}',
        headers: { Authorization: 'Bearer {{token}}' },
        body: '{"q":"{{query}}"}',
        output: 'http',
      }),
      state({ id: 7, token: 't0k3n', query: 'hi' }),
      [],
      d,
    );
    expect(d.http).toHaveBeenCalledWith({
      method: 'POST',
      url: 'https://api.example.com/users/7',
      headers: { Authorization: 'Bearer t0k3n' },
      body: '{"q":"hi"}',
      timeoutMs: 10_000,
    });
    expect(result.variables?.http).toEqual({ status: 200, data: { ok: true }, headers: { 'x-src': 'test' } });
  });

  it('非 http/https URL → 抛错', async () => {
    const d = deps();
    await expect(
      executeNode(node('http_request', { url: 'file:///etc/passwd' }), state({}), [], d),
    ).rejects.toThrow(/仅允许 http\/https/);
  });
});

describe('template', () => {
  it('渲染模板并写入 output 变量', async () => {
    const d = deps();
    const result = await executeNode(
      node('template', { template: '结果：{{answer}}（{{user.name}}）', output: 'text' }),
      state({ answer: 'OK', user: { name: 'evan' } }),
      [],
      d,
    );
    expect(result.variables?.text).toBe('结果：OK（evan）');
  });
});

describe('iteration', () => {
  it('遍历字符串数组，逐项渲染并聚合', async () => {
    const d = deps();
    const result = await executeNode(
      node('iteration', {
        arrayVariable: 'keywords',
        itemVariable: 'item',
        bodyTemplate: '[{{index}}] {{item}}',
        output: 'rendered',
      }),
      state({ keywords: ['铝', '镁', '钛'] }),
      [],
      d,
    );
    expect(result.variables?.rendered).toEqual(['[0] 铝', '[1] 镁', '[2] 钛']);
  });

  it('支持 {{item.field}} 访问对象数组的字段', async () => {
    const d = deps();
    const result = await executeNode(
      node('iteration', {
        arrayVariable: 'papers',
        itemVariable: 'item',
        bodyTemplate: '{{item.title}} ({{item.year}})',
        output: 'titles',
      }),
      state({
        papers: [
          { title: 'MXene 综述', year: 2023 },
          { title: '镁合金成形', year: 2021 },
        ],
      }),
      [],
      d,
    );
    expect(result.variables?.titles).toEqual(['MXene 综述 (2023)', '镁合金成形 (2021)']);
  });

  it('空数组 → 聚合为空数组', async () => {
    const d = deps();
    const result = await executeNode(
      node('iteration', {
        arrayVariable: 'list',
        itemVariable: 'item',
        bodyTemplate: '{{item}}',
        output: 'out',
      }),
      state({ list: [] }),
      [],
      d,
    );
    expect(result.variables?.out).toEqual([]);
  });

  it('数组变量缺失或非数组 → 抛错', async () => {
    const d = deps();
    await expect(
      executeNode(
        node('iteration', {
          arrayVariable: 'nope',
          itemVariable: 'item',
          bodyTemplate: '{{item}}',
          output: 'out',
        }),
        state({}),
        [],
        d,
      ),
    ).rejects.toThrow(/不是数组/);
    await expect(
      executeNode(
        node('iteration', {
          arrayVariable: 'str',
          itemVariable: 'item',
          bodyTemplate: '{{item}}',
          output: 'out',
        }),
        state({ str: 'not-an-array' }),
        [],
        d,
      ),
    ).rejects.toThrow(/不是数组/);
  });
});

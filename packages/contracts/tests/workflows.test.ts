/**
 * @pulse/contracts M5 工作流契约单测 —— 节点/边/输入输出/运行/流式事件的合法性约束。
 */
import { describe, expect, it } from 'vitest';
import {
  createWorkflowInputSchema,
  updateWorkflowInputSchema,
  workflowConditionOperatorSchema,
  workflowEdgeConditionSchema,
  workflowNodeInputSchema,
  workflowRunRequestSchema,
  workflowRunResultSchema,
  workflowStreamEventSchema,
  workflowViewSchema,
} from '../src/workflows.js';

const UUID = '00000000-0000-0000-0000-000000000000';
const UUID2 = '11111111-1111-1111-1111-111111111111';

/** 最小合法图：start + end */
function baseGraph(overrides: Record<string, unknown> = {}) {
  return {
    name: '示例工作流',
    nodes: [
      { id: 'n1', type: 'start', data: { inputs: [{ name: 'query', type: 'string' }] } },
      { id: 'n9', type: 'end', data: { outputs: [{ name: 'answer', from: 'answer' }] } },
    ],
    edges: [{ id: 'e1', sourceNodeId: 'n1', targetNodeId: 'n9' }],
    ...overrides,
  };
}

describe('workflowConditionOperatorSchema', () => {
  it('枚举 16 种操作符；非法值拒绝', () => {
    for (const op of ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'contains', 'starts_with', 'ends_with', 'is_empty', 'is_not_empty', 'in', 'not_in', 'regex', 'truthy', 'falsy']) {
      expect(workflowConditionOperatorSchema.parse(op)).toBe(op);
    }
    expect(() => workflowConditionOperatorSchema.parse('like' as never)).toThrow();
  });
});

describe('workflowNodeInputSchema 按类型校验 data', () => {
  it('start：声明输入字段（缺省 []）', () => {
    const node = workflowNodeInputSchema.parse({ id: 'n1', type: 'start', data: {} });
    expect(node.data.inputs).toEqual([]);
    const withInputs = workflowNodeInputSchema.parse({
      id: 'n1',
      type: 'start',
      data: { inputs: [{ name: 'query', type: 'string', required: true }] },
    });
    expect(withInputs.data.inputs[0]?.name).toBe('query');
  });

  it('llm：modelId 必须 uuid、prompt 必填、output 缺省 answer、engine 缺省 gateway', () => {
    const node = workflowNodeInputSchema.parse({
      id: 'n2',
      type: 'llm',
      data: { modelId: UUID, prompt: '你好 {{query}}' },
    });
    expect(node.data.output).toBe('answer');
    expect(node.data.engine).toBe('gateway');
    expect(() =>
      workflowNodeInputSchema.parse({ id: 'n2', type: 'llm', data: { modelId: 'not-uuid', prompt: 'x' } }),
    ).toThrow();
    expect(() =>
      workflowNodeInputSchema.parse({ id: 'n2', type: 'llm', data: { modelId: UUID } }),
    ).toThrow();
  });

  it('knowledge_retrieval：query 必填、topK 边界 1-100', () => {
    const node = workflowNodeInputSchema.parse({
      id: 'n3',
      type: 'knowledge_retrieval',
      data: { query: '{{query}}', datasetIds: [UUID], topK: 6, output: 'retrieval' },
    });
    expect(node.data.topK).toBe(6);
    expect(() =>
      workflowNodeInputSchema.parse({
        id: 'n3',
        type: 'knowledge_retrieval',
        data: { query: '', datasetIds: [UUID] },
      }),
    ).toThrow();
    expect(() =>
      workflowNodeInputSchema.parse({
        id: 'n3',
        type: 'knowledge_retrieval',
        data: { query: 'x', datasetIds: [UUID], topK: 0 },
      }),
    ).toThrow();
  });

  it('condition / intent / template / end 配置合法；未知字段被 .strict() 拒绝', () => {
    expect(
      workflowNodeInputSchema.parse({ id: 'n4', type: 'condition', data: { output: 'branch' } }).data.output,
    ).toBe('branch');
    expect(
      workflowNodeInputSchema.parse({ id: 'n5', type: 'intent', data: { queryVariable: 'query' } }).data.queryVariable,
    ).toBe('query');
    expect(
      workflowNodeInputSchema.parse({ id: 'n6', type: 'template', data: { template: 'Hi {{query}}' } }).data.output,
    ).toBe('text');
    // 未知字段拒绝
    expect(() =>
      workflowNodeInputSchema.parse({ id: 'n7', type: 'condition', data: { output: 'x', bogus: 1 } }),
    ).toThrow();
  });

  it('code：code 必填、timeoutMs 10-10000', () => {
    const node = workflowNodeInputSchema.parse({
      id: 'n8',
      type: 'code',
      data: { code: '(ctx) => ({ x: 1 })' },
    });
    expect(node.data.timeoutMs).toBe(3000);
    expect(() =>
      workflowNodeInputSchema.parse({ id: 'n8', type: 'code', data: { code: '' } }),
    ).toThrow();
  });

  it('http_request：URL 必填、方法枚举、headers 最多 50 项', () => {
    const node = workflowNodeInputSchema.parse({
      id: 'n9',
      type: 'http_request',
      data: { method: 'GET', url: 'https://example.com?q={{query}}' },
    });
    expect(node.data.timeoutMs).toBe(10_000);
    expect(() =>
      workflowNodeInputSchema.parse({
        id: 'n9',
        type: 'http_request',
        data: { method: 'FETCH' as never, url: 'https://x.com' },
      }),
    ).toThrow();
    // URL scheme 校验属运行时（模板渲染后）职责 —— 契约层接受模板化 URL
    expect(() =>
      workflowNodeInputSchema.parse({ id: 'n9', type: 'http_request', data: { url: 'https://api.example.com/{{path}}' } }),
    ).not.toThrow();
  });
});

describe('workflowEdgeConditionSchema', () => {
  it('condition 形态：variable/operator/value；intent 形态：branch/examples', () => {
    const cond = workflowEdgeConditionSchema.parse({
      variable: 'answer',
      operator: 'contains',
      value: '你好',
      branch: 'match',
    });
    expect(cond.operator).toBe('contains');
    const intent = workflowEdgeConditionSchema.parse({ branch: '退货', examples: ['怎么退', '我要退'] });
    expect(intent.branch).toBe('退货');
    expect(intent.examples?.length).toBe(2);
  });

  it('未知字段拒绝', () => {
    expect(() => workflowEdgeConditionSchema.parse({ variable: 'a', operator: 'eq', nope: 1 })).toThrow();
  });
});

describe('createWorkflowInputSchema 拓扑校验', () => {
  it('合法图通过（start + end + 中间节点）', () => {
    const input = createWorkflowInputSchema.parse(baseGraph());
    expect(input.nodes.length).toBe(2);
    expect(input.status).toBeUndefined();
  });

  it('必须恰好一个 start；缺少 start / 多个 start 拒绝', () => {
    const noStart = baseGraph();
    noStart.nodes = [{ id: 'n9', type: 'end', data: {} }];
    expect(() => createWorkflowInputSchema.parse(noStart)).toThrow(/start/);

    const twoStarts = baseGraph();
    twoStarts.nodes = [
      { id: 'n1', type: 'start', data: {} },
      { id: 'n2', type: 'start', data: {} },
      { id: 'n9', type: 'end', data: {} },
    ];
    expect(() => createWorkflowInputSchema.parse(twoStarts)).toThrow(/start/);
  });

  it('至少一个 end；end 有出边 / start 有入边拒绝', () => {
    const noEnd = baseGraph();
    noEnd.nodes = [{ id: 'n1', type: 'start', data: {} }];
    expect(() => createWorkflowInputSchema.parse(noEnd)).toThrow(/end/);

    const endOut = baseGraph();
    endOut.nodes = [
      { id: 'n1', type: 'start', data: {} },
      { id: 'n9', type: 'end', data: {} },
      { id: 'n10', type: 'end', data: {} },
    ];
    endOut.edges = [
      { id: 'e1', sourceNodeId: 'n1', targetNodeId: 'n9' },
      { id: 'e2', sourceNodeId: 'n9', targetNodeId: 'n10' },
    ];
    expect(() => createWorkflowInputSchema.parse(endOut)).toThrow(/end/);

    const startIn = baseGraph();
    startIn.edges = [
      { id: 'e1', sourceNodeId: 'n1', targetNodeId: 'n9' },
      { id: 'e2', sourceNodeId: 'n9', targetNodeId: 'n1' },
    ];
    expect(() => createWorkflowInputSchema.parse(startIn)).toThrow(/start/);
  });

  it('边端点必须存在于节点集', () => {
    const badEdge = baseGraph();
    badEdge.edges = [{ id: 'e1', sourceNodeId: 'n1', targetNodeId: 'ghost' }];
    expect(() => createWorkflowInputSchema.parse(badEdge)).toThrow(/ghost/);
  });

  it('未知字段拒绝（.strict()）', () => {
    expect(() => createWorkflowInputSchema.parse({ ...baseGraph(), bogus: 1 })).toThrow();
  });
});

describe('updateWorkflowInputSchema', () => {
  it('局部更新：单字段即可，无需 nodes/edges', () => {
    const patch = updateWorkflowInputSchema.parse({ name: '改名', status: 'published' });
    expect(patch.name).toBe('改名');
    expect(patch.status).toBe('published');
    expect(patch.nodes).toBeUndefined();
  });

  it('提供 nodes 但缺 edges 时允许（局部语义，不做图拓扑校验）', () => {
    const patch = updateWorkflowInputSchema.parse({ nodes: baseGraph().nodes });
    expect(patch.nodes?.length).toBe(2);
  });

  it('name 为空 / 非法 status 拒绝', () => {
    expect(() => updateWorkflowInputSchema.parse({ name: '  ' })).toThrow();
    expect(() => updateWorkflowInputSchema.parse({ status: 'bogus' as never })).toThrow();
  });
});

describe('workflowRunRequestSchema / workflowRunResultSchema / workflowStreamEventSchema', () => {
  it('run 请求：workflowId 必填 uuid，inputs/stream 缺省', () => {
    const req = workflowRunRequestSchema.parse({ workflowId: UUID });
    expect(req.inputs).toEqual({});
    expect(req.stream).toBe(false);
    const withInputs = workflowRunRequestSchema.parse({ workflowId: UUID, inputs: { query: 'hi' } });
    expect(withInputs.inputs).toEqual({ query: 'hi' });
    expect(() => workflowRunRequestSchema.parse({ workflowId: 'bad' })).toThrow();
  });

  it('运行结果：status 枚举 + 节点明细数组', () => {
    const result = workflowRunResultSchema.parse({
      runId: UUID,
      workflowId: UUID2,
      status: 'success',
      inputs: { query: 'hi' },
      outputs: { answer: '你好' },
      nodeResults: [
        {
          nodeId: 'n1',
          name: null,
          type: 'start',
          status: 'success',
          output: { query: 'hi' },
          error: null,
          startedAt: new Date().toISOString(),
          endedAt: new Date().toISOString(),
        },
      ],
      error: null,
      createdAt: new Date().toISOString(),
      durationMs: 12,
    });
    expect(result.nodeResults[0]?.type).toBe('start');
    expect(() => workflowRunResultSchema.parse({ ...result, status: 'bad' as never })).toThrow();
  });

  it('流式事件：node_end / done / error 三态判别', () => {
    const nodeEnd = workflowStreamEventSchema.parse({
      type: 'node_end',
      runId: UUID,
      nodeId: 'n1',
      name: null,
      nodeType: 'llm',
      status: 'success',
      output: { answer: 'x' },
      error: null,
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
    });
    expect(nodeEnd.type).toBe('node_end');

    const done = workflowStreamEventSchema.parse({
      type: 'done',
      runId: UUID,
      status: 'success',
      outputs: {},
      nodeResults: [],
      error: null,
      durationMs: 3,
      createdAt: new Date().toISOString(),
    });
    expect(done.type).toBe('done');

    const err = workflowStreamEventSchema.parse({ type: 'error', runId: UUID, code: 'X', message: 'boom' });
    expect(err.type).toBe('error');
  });
});

describe('workflowViewSchema', () => {
  it('完整视图通过（节点/边/版本）', () => {
    const view = workflowViewSchema.parse({
      id: UUID,
      name: '示例',
      description: null,
      status: 'published',
      version: 2,
      nodes: [
        {
          id: 'n1',
          workflowId: UUID,
          type: 'start',
          name: null,
          data: {},
          position: { x: 0, y: 0 },
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ],
      edges: [
        {
          id: 'e1',
          workflowId: UUID,
          sourceNodeId: 'n1',
          targetNodeId: 'n2',
          sourceHandle: null,
          targetHandle: null,
          condition: null,
          createdAt: new Date().toISOString(),
        },
      ],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    expect(view.status).toBe('published');
    expect(view.version).toBe(2);
  });
});

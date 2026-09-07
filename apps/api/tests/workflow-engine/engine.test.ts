/**
 * M5 LangGraph 引擎单测 —— DB 图定义 → StateGraph 构建、整图执行（节点级观测）、
 * 条件分支路由、流式事件序列、失败降级。
 */
import { describe, expect, it, vi } from 'vitest';
import type { RetrievalResult, WorkflowNodeType } from '@pulse/contracts';
import { executeGraph, streamGraph } from '../../src/services/workflow-engine/index.js';
import { buildStateGraph, toLangGraphNodeName } from '../../src/services/workflow-engine/langgraph.js';
import { WorkflowExecutionError } from '../../src/services/workflow-engine/types.js';
import type { ExecutorDeps, WorkflowGraphDefinition } from '../../src/services/workflow-engine/types.js';

const UUID = '00000000-0000-0000-0000-000000000000';
const MODEL_ID = '22222222-2222-2222-2222-222222222222';
const DS_ID = '33333333-3333-3333-3333-333333333333';

/**
 * 示例 DAG：start → knowledge_retrieval → llm → condition ──(answer contains 你好)──▶ template_yes → end
 *                                                    └───────────(兜底)─────────────▶ template_no  → end
 */
function sampleGraph(): WorkflowGraphDefinition {
  return {
    id: UUID,
    name: 'RAG 示例',
    status: 'published',
    nodes: [
      { id: 'n1', type: 'start', name: '入口', data: { inputs: [{ name: 'query', type: 'string' }] } },
      {
        id: 'n2',
        type: 'knowledge_retrieval',
        name: '检索',
        data: { query: '{{query}}', datasetIds: [DS_ID], topK: 3, output: 'retrieval', contextOutput: 'context' },
      },
      { id: 'n3', type: 'llm', name: '生成', data: { modelId: MODEL_ID, prompt: '知识：{{context}}\n问题：{{query}}', output: 'answer' } },
      { id: 'n4', type: 'condition', name: '判断', data: { output: 'branch' } },
      { id: 'n5', type: 'template', name: '命中模板', data: { template: '命中: {{answer}}', output: 'text' } },
      { id: 'n6', type: 'template', name: '兜底模板', data: { template: '兜底: {{answer}}', output: 'text' } },
      { id: 'n9', type: 'end', name: '出口', data: { outputs: [{ name: 'answer', from: 'answer' }, { name: 'text', from: 'text' }] } },
    ],
    edges: [
      { id: 'e1', sourceNodeId: 'n1', targetNodeId: 'n2', condition: null },
      { id: 'e2', sourceNodeId: 'n2', targetNodeId: 'n3', condition: null },
      { id: 'e3', sourceNodeId: 'n3', targetNodeId: 'n4', condition: null },
      { id: 'e4', sourceNodeId: 'n4', targetNodeId: 'n5', condition: { variable: 'answer', operator: 'contains', value: '你好' } },
      { id: 'e5', sourceNodeId: 'n4', targetNodeId: 'n6', condition: null },
      { id: 'e6', sourceNodeId: 'n5', targetNodeId: 'n9', condition: null },
      { id: 'e7', sourceNodeId: 'n6', targetNodeId: 'n9', condition: null },
    ],
  };
}

function testDeps(overrides: Partial<ExecutorDeps> = {}): ExecutorDeps {
  return {
    isMock: () => true,
    completeChat: async () => `回答你好`,
    retrieve: vi.fn(
      async (query: string, datasetIds: string[], topK: number): Promise<RetrievalResult> => ({
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
    http: vi.fn(async () => ({ status: 200, data: {}, headers: {} })),
    ...overrides,
  };
}

describe('toLangGraphNodeName / buildStateGraph', () => {
  it('节点名加 wf_ 前缀，避免与 START/END 冲突', () => {
    expect(toLangGraphNodeName('abc')).toBe('wf_abc');
  });

  it('缺少 start 节点 → WorkflowExecutionError', () => {
    const graph = sampleGraph();
    graph.nodes = graph.nodes.filter((n) => n.type !== 'start');
    expect(() => buildStateGraph(graph, testDeps())).toThrow(WorkflowExecutionError);
  });

  it('节点 data 非法（未知字段）→ 构建即抛错', () => {
    const graph = sampleGraph();
    graph.nodes[1] = { ...graph.nodes[1]!, data: { ...graph.nodes[1]!.data, bogus: 1 } };
    expect(() => buildStateGraph(graph, testDeps())).toThrow();
  });

  it('边指向不存在的节点 → WorkflowExecutionError', () => {
    const graph = sampleGraph();
    graph.edges = [...graph.edges, { id: 'eX', sourceNodeId: 'n3', targetNodeId: 'ghost', condition: null }];
    expect(() => buildStateGraph(graph, testDeps())).toThrow(/不存在的节点/);
  });
});

describe('executeGraph 整图执行', () => {
  it('start→检索→llm→condition(命中)→template→end：输出映射与节点明细', async () => {
    const deps = testDeps();
    const result = await executeGraph(sampleGraph(), { query: '怎么退货' }, deps);

    expect(result.status).toBe('success');
    expect(result.error).toBeNull();
    // end 输出：answer + text（命中分支模板渲染）
    expect(result.outputs.answer).toBe('回答你好');
    expect(result.outputs.text).toBe('命中: 回答你好');
    // 检索节点调用正确（rerankModelId 缺省 → 第 4 参 undefined）
    expect(deps.retrieve).toHaveBeenCalledWith('怎么退货', [DS_ID], 3, undefined);
    // 节点级明细：只含实际执行路径（命中分支不执行 template_no）
    const nodeTypes = result.nodeResults.map((r) => r.type as WorkflowNodeType);
    expect(nodeTypes).toContain('start');
    expect(nodeTypes).toContain('knowledge_retrieval');
    expect(nodeTypes).toContain('llm');
    expect(nodeTypes).toContain('condition');
    expect(nodeTypes).toContain('template');
    expect(nodeTypes).toContain('end');
    expect(result.nodeResults.every((r) => r.status === 'success')).toBe(true);
  });

  it('condition 兜底分支：answer 不含「你好」→ template_no', async () => {
    const deps = testDeps({ completeChat: async () => '其他回答' });
    const result = await executeGraph(sampleGraph(), { query: 'q' }, deps);
    expect(result.status).toBe('success');
    expect(result.outputs.text).toBe('兜底: 其他回答');
  });

  it('节点执行抛错 → run 标记 failed 并携带错误信息', async () => {
    // 检索节点抛错 → 运行失败
    const deps = testDeps({
      retrieve: async () => {
        throw new Error('检索服务不可用');
      },
    });
    const result = await executeGraph(sampleGraph(), { query: 'q' }, deps);
    expect(result.status).toBe('failed');
    expect(result.error).toContain('检索服务不可用');
    expect(result.outputs).toEqual({});
    // 错误节点被标记为 error
    const retrievalNode = result.nodeResults.find((r) => r.type === 'knowledge_retrieval');
    expect(retrievalNode?.status).toBe('error');
    expect(retrievalNode?.error).toContain('检索服务不可用');
  });

  it('llm 节点输出写入变量空间，供下游模板引用', async () => {
    const deps = testDeps({ completeChat: async () => '引用测试' });
    const graph = sampleGraph();
    graph.nodes[3] = { id: 'n4', type: 'condition', name: '判断', data: { output: 'branch' } };
    graph.edges = graph.edges.map((e) =>
      e.sourceNodeId === 'n4' && e.condition?.variable === 'answer'
        ? { ...e, condition: { ...e.condition, operator: 'eq', value: '引用测试' } }
        : e,
    );
    const result = await executeGraph(graph, { query: 'q' }, deps);
    expect(result.outputs.text).toBe('命中: 引用测试');
  });
});

describe('streamGraph 流式执行', () => {
  it('依次产出 node_end 事件 + 末尾 done（含节点明细与运行结果）', async () => {
    const deps = testDeps();
    const events: Array<{ type: string }> = [];
    for await (const evt of streamGraph(sampleGraph(), { query: '怎么退货' }, deps)) {
      events.push(evt);
    }

    const nodeEnds = events.filter((e) => e.type === 'node_end');
    const dones = events.filter((e) => e.type === 'done');
    // 至少 start/检索/llm/condition/template/end 各一个 node_end
    expect(nodeEnds.length).toBeGreaterThanOrEqual(6);
    expect(nodeEnds[0]).toMatchObject({ type: 'node_end', nodeType: 'start', status: 'success' });
    expect(dones).toHaveLength(1);
    expect(dones[0]).toMatchObject({ type: 'done', status: 'success' });
    expect((dones[0] as { outputs: Record<string, unknown> }).outputs.answer).toBe('回答你好');
    // node_end 事件携带该节点写入的变量增量
    const llmEnd = nodeEnds.find((e) => e.nodeType === 'llm');
    expect((llmEnd as { output: Record<string, unknown> }).output?.answer).toBe('回答你好');
  });

  it('流式执行失败：done 事件 status=failed 且携带错误', async () => {
    const deps = testDeps({
      retrieve: async () => {
        throw new Error('检索服务不可用');
      },
    });
    const events: Array<{ type: string }> = [];
    for await (const evt of streamGraph(sampleGraph(), { query: 'q' }, deps)) {
      events.push(evt);
    }
    const done = events.find((e) => e.type === 'done') as { status: string; error: string | null };
    expect(done.status).toBe('failed');
    expect(done.error).toContain('检索服务不可用');
  });
});

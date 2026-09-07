/**
 * LangGraph v1 冒烟验证：确认 StateGraph / Annotation.Root / 条件边 /
 * stream(updates) / 不可达节点行为，作为 M5 引擎映射方案的事实依据。
 */
import { Annotation, END, START, StateGraph } from '@langchain/langgraph';

const WorkflowState = Annotation.Root({
  inputs: Annotation<Record<string, unknown>>(),
  variables: Annotation<Record<string, unknown>>(),
  outputs: Annotation<Record<string, unknown>>(),
});

async function main(): Promise<void> {
  // start 节点：把输入写入 variables
  const start = async (state: typeof WorkflowState.State) => {
    const variables = { ...state.variables, ...state.inputs };
    return { variables };
  };
  // 条件节点：根据 variables.score 路由
  const condition = async () => ({});
  const branchA = async (state: typeof WorkflowState.State) => {
    return { variables: { ...state.variables, answer: 'high' } };
  };
  const branchB = async (state: typeof WorkflowState.State) => {
    return { variables: { ...state.variables, answer: 'low' } };
  };

  const graph = new StateGraph(WorkflowState)
    .addNode('start', start)
    .addNode('condition', condition)
    .addNode('branchA', branchA)
    .addNode('branchB', branchB)
    .addNode('unreachable', async () => ({}))
    .addEdge(START, 'start')
    .addEdge('start', 'condition')
    .addConditionalEdges('condition', (state) => {
      const score = Number(state.variables?.score ?? 0);
      return score >= 10 ? 'branchA' : 'branchB';
    })
    .addEdge('branchA', END)
    .addEdge('branchB', END)
    .compile();

  // 一次执行
  const result = await graph.invoke({ inputs: { score: 12 }, variables: {}, outputs: {} });
  console.log('invoke result:', JSON.stringify(result));

  // 流式 updates（v1：stream() 返回 Promise<IterableReadableStream>）
  const events: unknown[] = [];
  const stream = await graph.stream({ inputs: { score: 3 }, variables: {}, outputs: {} }, { streamMode: 'updates' });
  for await (const chunk of stream) {
    events.push(chunk);
  }
  console.log('stream events:', JSON.stringify(events));

  // 条件边返回不存在的节点 → 运行期行为
  const bad = new StateGraph(WorkflowState)
    .addNode('start', start)
    .addNode('condition', condition)
    .addEdge(START, 'start')
    .addEdge('start', 'condition')
    .addConditionalEdges('condition', () => 'missing')
    .compile();
  try {
    await bad.invoke({ inputs: {}, variables: {}, outputs: {} });
    console.log('bad routing: no error');
  } catch (err) {
    console.log('bad routing error:', err instanceof Error ? err.message : String(err));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

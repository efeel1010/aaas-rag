/**
 * M-A ReAct 工具循环 —— 端到端 mock 验证脚本（无外网）。
 *
 * 验证链路（真实 DB + mock 模型/向量，全部本地）：
 *   创建 Provider/Model(Dataset embedding + LLM) → 建 Dataset 并插入 1 条 chunk
 *   → 创建 Agent（tools: ['local_retrieval']，绑定 Dataset + LLM）
 *   → chatOnce 提问「请检索知识库中的退货政策」
 *   → 断言：触发 local_retrieval、toolCalls 透出、答语含来源标注。
 *
 * 运行：cd apps/api && tsx scripts/tool-loop-e2e.ts
 * 运行前需：docker-compose 已起（PG/Redis），且已执行过 pnpm db:migrate。
 */
// 强制本地 mock：必须在动态 import 任何服务模块前设置
process.env.MOCK_MODELS = 'true';
process.env.MOCK_INGEST = 'true';

const PREFIX = 'e2e-tool-loop';

async function main(): Promise<void> {
  const [{ getDb }, { agentStore }, { datasetStore }, { providerStore }, { modelStore }, { createAgentRuntime }, { fakeEmbedding }] =
    await Promise.all([
      import('../src/lib/db.js'),
      import('../src/services/agent-store.js'),
      import('../src/services/dataset-store.js'),
      import('../src/services/provider-store.js'),
      import('../src/services/model-store.js'),
      import('../src/services/agent-runtime.js'),
      import('../src/lib/ingest/embedding.js'),
    ]);
  // 副作用：注册内置工具（local_retrieval / http_request）
  await import('../src/lib/tools/index.js');
  // 表对象（用于插入 chunk / document）
  const { documents, datasetChunks } = await import('@pulse/db');
  const { sql } = await import('drizzle-orm');

  const db = getDb();

  // ---- 清理历史 e2e 数据（按名称前缀，级联子表） ----
  const like = `${PREFIX}%`;
  await db.execute(sql`DELETE FROM agents WHERE name LIKE ${like}`);
  await db.execute(sql`DELETE FROM agent_datasets ad USING agents a WHERE ad.agent_id = a.id AND a.name LIKE ${like}`);
  await db.execute(sql`DELETE FROM agent_intents ai USING agents a WHERE ai.agent_id = a.id AND a.name LIKE ${like}`);
  await db.execute(sql`DELETE FROM dataset_chunks dc USING datasets d WHERE dc.dataset_id = d.id AND d.name LIKE ${like}`);
  await db.execute(sql`DELETE FROM documents doc USING datasets d WHERE doc.dataset_id = d.id AND d.name LIKE ${like}`);
  await db.execute(sql`DELETE FROM datasets WHERE name LIKE ${like}`);
  await db.execute(sql`DELETE FROM models WHERE name LIKE ${like}`);
  await db.execute(sql`DELETE FROM providers WHERE name LIKE ${like}`);

  // ---- 1. Provider + 模型 ----
  const provider = await providerStore.create({
    type: 'openai',
    name: `${PREFIX}-provider`,
    credentials: { apiKey: 'sk-mock' },
    status: 'active',
  });
  const embeddingModel = await modelStore.create({
    providerId: provider.id,
    name: `${PREFIX}-embedding`,
    modelType: 'embedding',
    status: 'active',
  });
  const llmModel = await modelStore.create({
    providerId: provider.id,
    name: `${PREFIX}-llm`,
    modelType: 'llm',
    status: 'active',
  });

  // ---- 2. Dataset + 1 条 chunk ----
  const ds = await datasetStore.create({
    name: `${PREFIX}-ds`,
    embeddingModelId: embeddingModel.id,
    status: 'active',
  });
  const chunkContent = '本店商品支持7天无理由退货，请保留购物凭证。';
  const [doc] = await db
    .insert(documents)
    .values({
      datasetId: ds.id,
      name: '售后政策.md',
      status: 'success',
      content: chunkContent,
      tokens: 10,
      metadata: { documentName: '售后政策.md' },
    })
    .returning();
  await db.insert(datasetChunks).values({
    datasetId: ds.id,
    documentId: doc!.id,
    content: chunkContent,
    tokens: 10,
    contentHash: 'hash-e2e',
    embedding: fakeEmbedding(chunkContent),
    metadata: { documentName: '售后政策.md' },
  });
  await db.execute(sql`UPDATE datasets SET doc_count = 1 WHERE id = ${ds.id}::uuid`);

  // ---- 3. Agent：绑定 tools: ['local_retrieval'] ----
  const agent = await agentStore.create({
    name: `${PREFIX}-agent`,
    description: '工具循环端到端验证',
    systemPrompt: '你是售后助手，请基于本地知识库资料回答。',
    modelId: llmModel.id,
    datasets: [{ datasetId: ds.id, weight: 100 }],
    tools: ['local_retrieval'],
    status: 'active',
  });
  console.log('[e2e] agent created:', agent.id, 'tools=', agent.tools);

  // ---- 4. 运行时：绑定工具提问 → 触发 local_retrieval ----
  const runtime = createAgentRuntime();
  const result = await runtime.chatOnce({
    agentId: agent.id,
    sessionId: 'e2e-session',
    query: '请检索知识库中的退货政策',
  });

  console.log('\n[e2e] === 绑定工具 Agent 提问（触发 local_retrieval） ===');
  console.log('[e2e] intent:', JSON.stringify(result.intent));
  console.log('[e2e] retrievedDatasets:', result.retrievedDatasets);
  console.log('[e2e] toolCalls:', JSON.stringify(result.toolCalls ?? null, null, 2));
  console.log('[e2e] content:', result.content);

  // ---- 断言 ----
  const toolCalls = result.toolCalls ?? [];
  if (toolCalls.length < 1) {
    throw new Error('断言失败：期望至少触发一次工具调用');
  }
  if (toolCalls[0]!.name !== 'local_retrieval') {
    throw new Error(`断言失败：期望 local_retrieval，实际 ${toolCalls[0]!.name}`);
  }
  if (toolCalls[0]!.status !== 'success') {
    throw new Error(`断言失败：工具应成功执行，实际 ${toolCalls[0]!.status}`);
  }
  if (!result.content.includes('来源：本地知识库')) {
    throw new Error('断言失败：答语应包含来源标注');
  }
  if (!result.content.includes('7天无理由退货')) {
    throw new Error('断言失败：答语应包含检索到的资料内容');
  }
  console.log('\n[e2e] ✅ 工具循环端到端验证通过：触发 local_retrieval → toolCalls 透出 → 答语含来源标注');

  // ---- 5. 流式事件序列（SSE 数据源）：meta → tool_call → delta → usage → done ----
  const events: { type: string }[] = [];
  for await (const evt of runtime.streamTurn({ agentId: agent.id, query: '请检索知识库中的退货政策' })) {
    events.push(evt);
  }
  const eventTypes = events.map((e) => e.type);
  console.log('[e2e] streamTurn 事件序列:', eventTypes.join(' → '));
  if (!eventTypes.includes('tool_call')) {
    throw new Error(`断言失败：SSE 事件序列应包含 tool_call，实际 ${eventTypes.join(',')}`);
  }
  const toolEvent = events.find((e) => e.type === 'tool_call') as { name?: string; status?: string };
  if (toolEvent.name !== 'local_retrieval' || toolEvent.status !== 'success') {
    throw new Error('断言失败：tool_call 事件内容不正确');
  }
  if (eventTypes[eventTypes.length - 1] !== 'done') {
    throw new Error('断言失败：事件应以 done 收尾');
  }
  console.log('[e2e] ✅ 流式事件序列验证通过（meta → tool_call → delta → usage → done）');

  // ---- 6. 未绑定工具对照：纯直线编排（无 toolCalls） ----
  const plainAgent = await agentStore.create({
    name: `${PREFIX}-plain-agent`,
    modelId: llmModel.id,
    datasets: [{ datasetId: ds.id, weight: 100 }],
    tools: [],
    status: 'active',
  });
  const plainResult = await runtime.chatOnce({
    agentId: plainAgent.id,
    query: '请检索知识库中的退货政策',
  });
  console.log('\n[e2e] === 未绑定工具 Agent 提问（直线编排对照） ===');
  console.log('[e2e] toolCalls:', JSON.stringify(plainResult.toolCalls ?? null));
  if ((plainResult.toolCalls ?? []).length !== 0) {
    throw new Error('断言失败：未绑定工具的 Agent 不应产生 toolCalls');
  }
  if (plainResult.retrievedDatasets.length !== 1) {
    throw new Error('断言失败：未绑定工具的 Agent 应走固定检索');
  }
  console.log('[e2e] ✅ 未绑定工具 Agent 维持直线编排（固定检索 + 无 toolCalls）');

  // ---- 清理 ----
  await agentStore.remove(agent.id).catch(() => {});
  await agentStore.remove(plainAgent.id).catch(() => {});
  await db.execute(sql`DELETE FROM datasets WHERE id = ${ds.id}::uuid`);
  await db.execute(sql`DELETE FROM models WHERE id = ${embeddingModel.id}::uuid`);
  await db.execute(sql`DELETE FROM models WHERE id = ${llmModel.id}::uuid`);
  await db.execute(sql`DELETE FROM providers WHERE id = ${provider.id}::uuid`);
  console.log('\n[e2e] 清理完成，退出 0');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('\n[e2e] 失败:', err);
    process.exit(1);
  });

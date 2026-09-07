/**
 * M-C openalex_search —— 端到端 mock 验证脚本（无外网）。
 *
 * 验证链路（真实 DB + mock 模型/向量 + MOCK_TOOLS 确定性假数据，全部本地）：
 *   创建 Provider/Model(LLM) → 创建 Agent（tools: ['openalex_search']，绑定 LLM）
 *   → chatOnce 提问「帮我查一下大语言模型相关的学术论文」
 *   → 断言：触发 openalex_search、toolCalls 透出、答语含「来源：OpenAlex 实时数据」与论文条目。
 *
 * 运行：cd apps/api && tsx scripts/tool-loop-openalex-e2e.ts
 * 运行前需：docker-compose 已起（PG/Redis 可选），且已执行过 pnpm db:migrate。
 */
// 强制本地 mock：必须在动态 import 任何服务模块前设置
process.env.MOCK_MODELS = 'true';
process.env.MOCK_INGEST = 'true';
process.env.MOCK_TOOLS = 'true';

const PREFIX = 'e2e-openalex';

async function main(): Promise<void> {
  const [{ getDb }, { agentStore }, { providerStore }, { modelStore }, { createAgentRuntime }] =
    await Promise.all([
      import('../src/lib/db.js'),
      import('../src/services/agent-store.js'),
      import('../src/services/provider-store.js'),
      import('../src/services/model-store.js'),
      import('../src/services/agent-runtime.js'),
    ]);
  // 副作用：注册内置工具（local_retrieval / http_request / openalex_search）
  await import('../src/lib/tools/index.js');
  const { sql } = await import('drizzle-orm');

  const db = getDb();

  // ---- 清理历史 e2e 数据（按名称前缀，级联子表） ----
  const like = `${PREFIX}%`;
  await db.execute(sql`DELETE FROM agents WHERE name LIKE ${like}`);
  await db.execute(sql`DELETE FROM agent_datasets ad USING agents a WHERE ad.agent_id = a.id AND a.name LIKE ${like}`);
  await db.execute(sql`DELETE FROM agent_intents ai USING agents a WHERE ai.agent_id = a.id AND a.name LIKE ${like}`);
  await db.execute(sql`DELETE FROM models WHERE name LIKE ${like}`);
  await db.execute(sql`DELETE FROM providers WHERE name LIKE ${like}`);

  // ---- 1. Provider + LLM 模型 ----
  const provider = await providerStore.create({
    type: 'openai',
    name: `${PREFIX}-provider`,
    credentials: { apiKey: 'sk-mock' },
    status: 'active',
  });
  const llmModel = await modelStore.create({
    providerId: provider.id,
    name: `${PREFIX}-llm`,
    modelType: 'llm',
    status: 'active',
  });

  // ---- 2. Agent：绑定 tools: ['openalex_search']（无需知识库） ----
  const agent = await agentStore.create({
    name: `${PREFIX}-agent`,
    description: 'openalex_search 端到端验证',
    systemPrompt: '你是学术研究助手，请基于工具返回的论文信息回答。',
    modelId: llmModel.id,
    tools: ['openalex_search'],
    status: 'active',
  });
  console.log('[e2e] agent created:', agent.id, 'tools=', agent.tools);

  // ---- 3. 运行时：提问命中学术关键词 → 触发 openalex_search（MOCK_TOOLS 返回确定性假数据） ----
  const runtime = createAgentRuntime();
  const query = '帮我查一下大语言模型相关的学术论文';
  const result = await runtime.chatOnce({ agentId: agent.id, sessionId: 'e2e-session', query });

  console.log('\n[e2e] === 绑定 openalex_search Agent 提问（触发 openalex_search） ===');
  console.log('[e2e] toolCalls:', JSON.stringify(result.toolCalls ?? null, null, 2));
  console.log('[e2e] content:\n', result.content);

  // ---- 断言 ----
  const toolCalls = result.toolCalls ?? [];
  if (toolCalls.length < 1) {
    throw new Error('断言失败：期望至少触发一次工具调用');
  }
  if (toolCalls[0]!.name !== 'openalex_search') {
    throw new Error(`断言失败：期望 openalex_search，实际 ${toolCalls[0]!.name}`);
  }
  if (toolCalls[0]!.status !== 'success') {
    throw new Error(`断言失败：工具应成功执行，实际 ${toolCalls[0]!.status}`);
  }
  if (!result.content.includes('来源：OpenAlex 实时数据')) {
    throw new Error('断言失败：答语应包含「来源：OpenAlex 实时数据」来源标注');
  }
  if (!result.content.includes('模拟研究')) {
    throw new Error('断言失败：答语应包含 mock 论文条目（MOCK_TOOLS 确定性假数据）');
  }
  if (!result.content.includes('获取时间')) {
    throw new Error('断言失败：答语应包含获取时间');
  }
  console.log('\n[e2e] ✅ openalex_search 端到端 mock 验证通过：触发工具 → toolCalls 透出 → 答语带来源标注');

  // ---- 4. 流式事件序列（SSE 数据源）：meta → tool_call → delta → usage → done ----
  const events: { type: string }[] = [];
  for await (const evt of runtime.streamTurn({ agentId: agent.id, query })) {
    events.push(evt);
  }
  const eventTypes = events.map((e) => e.type);
  console.log('[e2e] streamTurn 事件序列:', eventTypes.join(' → '));
  if (!eventTypes.includes('tool_call')) {
    throw new Error(`断言失败：SSE 事件序列应包含 tool_call，实际 ${eventTypes.join(',')}`);
  }
  const toolEvent = events.find((e) => e.type === 'tool_call') as { name?: string; status?: string };
  if (toolEvent.name !== 'openalex_search' || toolEvent.status !== 'success') {
    throw new Error('断言失败：tool_call 事件内容不正确');
  }
  if (eventTypes[eventTypes.length - 1] !== 'done') {
    throw new Error('断言失败：事件应以 done 收尾');
  }
  console.log('[e2e] ✅ 流式事件序列验证通过（meta → tool_call → delta → usage → done）');

  // ---- 清理 ----
  await agentStore.remove(agent.id).catch(() => {});
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

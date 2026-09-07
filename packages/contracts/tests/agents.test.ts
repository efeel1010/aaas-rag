/**
 * @pulse/contracts M4 Agent 契约单测 —— create/update/view schema 的合法性约束。
 */
import { describe, expect, it } from 'vitest';
import {
  agentDatasetBindingSchema,
  agentDatasetViewSchema,
  agentIntentInputSchema,
  agentIntentViewSchema,
  agentStatusSchema,
  agentToolNameSchema,
  agentViewSchema,
  createAgentInputSchema,
  intentStrategySchema,
  updateAgentInputSchema,
} from '../src/agents.js';

const UUID = '00000000-0000-0000-0000-000000000000';

describe('agentStatusSchema / intentStrategySchema / agentDatasetBindingSchema', () => {
  it('枚举合法取值，非法值拒绝', () => {
    expect(agentStatusSchema.parse('active')).toBe('active');
    expect(agentStatusSchema.parse('disabled')).toBe('disabled');
    expect(() => agentStatusSchema.parse('paused')).toThrow();

    expect(intentStrategySchema.parse('retrieval')).toBe('retrieval');
    expect(intentStrategySchema.parse('direct')).toBe('direct');
    expect(intentStrategySchema.parse('workflow')).toBe('workflow');
    expect(intentStrategySchema.parse('fallback')).toBe('fallback');
    expect(() => intentStrategySchema.parse('chat')).toThrow();
  });

  it('知识库绑定 weight 边界 1-1000，缺省 undefined', () => {
    const b = agentDatasetBindingSchema.parse({ datasetId: UUID });
    expect(b.weight).toBeUndefined();
    expect(agentDatasetBindingSchema.parse({ datasetId: UUID, weight: 300 }).weight).toBe(300);
    expect(() => agentDatasetBindingSchema.parse({ datasetId: UUID, weight: 0 })).toThrow();
    expect(() => agentDatasetBindingSchema.parse({ datasetId: UUID, weight: 1001 })).toThrow();
  });
});

describe('createAgentInputSchema', () => {
  it('合法输入通过并透传 modelId/系统提示词', () => {
    const input = createAgentInputSchema.parse({
      name: '客服助手',
      systemPrompt: '你是客服。',
      modelId: UUID,
      datasets: [{ datasetId: UUID, weight: 200 }],
      intents: [
        {
          name: '退换货',
          examples: ['怎么退货', '我要退'],
          strategy: 'retrieval',
          datasetId: UUID,
        },
      ],
    });
    expect(input.modelId).toBe(UUID);
    expect(input.datasets?.[0]?.weight).toBe(200);
    expect(input.intents?.[0]?.name).toBe('退换货');
    // tools 不传时为 undefined（不进入工具循环，保持既有编排）
    expect(input.tools).toBeUndefined();
  });

  it('tools 字段：绑定工具名通过并透传，非法项拒绝', () => {
    const input = createAgentInputSchema.parse({
      name: '知识助手',
      modelId: UUID,
      tools: ['local_retrieval', 'http_request'],
    });
    expect(input.tools).toEqual(['local_retrieval', 'http_request']);
    expect(() =>
      createAgentInputSchema.parse({ name: 'x', modelId: UUID, tools: ['  '] }),
    ).toThrow();
    expect(() =>
      createAgentInputSchema.parse({
        name: 'x',
        modelId: UUID,
        tools: Array.from({ length: 21 }, (_, i) => `t${i}`),
      }),
    ).toThrow();
    expect(agentToolNameSchema.parse('local_retrieval')).toBe('local_retrieval');
    expect(() => agentToolNameSchema.parse('')).toThrow();
  });

  it('缺 name / 缺 modelId / 非 uuid modelId 拒绝', () => {
    expect(() => createAgentInputSchema.parse({ modelId: UUID })).toThrow();
    expect(() => createAgentInputSchema.parse({ name: 'x' })).toThrow();
    expect(() => createAgentInputSchema.parse({ name: 'x', modelId: 'abc' })).toThrow();
  });

  it('status 非法拒绝；type 缺省不出现（由服务层落默认）', () => {
    expect(() =>
      createAgentInputSchema.parse({ name: 'x', modelId: UUID, status: 'on' }),
    ).toThrow();
    const ok = createAgentInputSchema.parse({ name: 'x', modelId: UUID });
    expect(ok.type).toBeUndefined();
  });

  it('intent 项：intentId 复用与新建两种形态均可', () => {
    const reuse = agentIntentInputSchema.parse({ intentId: UUID, name: '已存在意图' });
    expect(reuse.intentId).toBe(UUID);
    const create = agentIntentInputSchema.parse({ name: '新意图', examples: ['示例'] });
    expect(create.intentId).toBeUndefined();
    expect(() => agentIntentInputSchema.parse({ name: '  ' })).toThrow();
    expect(() => agentIntentInputSchema.parse({ name: 'x', examples: [] })).not.toThrow();
  });

  it('intent 项：workflowInputs（固定值 / $extract 提取）通过并透传；缺省为 undefined', () => {
    const fixed = agentIntentInputSchema.parse({
      name: '深入',
      strategy: 'workflow',
      workflowId: UUID,
      workflowInputs: { step: 5 },
    });
    expect(fixed.workflowInputs).toEqual({ step: 5 });

    const extract = agentIntentInputSchema.parse({
      name: '深入',
      workflowInputs: { step: { $extract: 'number' } },
    });
    expect(extract.workflowInputs).toEqual({ step: { $extract: 'number' } });

    const none = agentIntentInputSchema.parse({ name: 'x' });
    expect(none.workflowInputs).toBeUndefined();
  });
});

describe('updateAgentInputSchema', () => {
  it('局部更新：单字段即可；datasets/intents 传 [] 表示清空', () => {
    const patch = updateAgentInputSchema.parse({ name: '改名' });
    expect(patch.name).toBe('改名');
    expect(patch.modelId).toBeUndefined();

    const clear = updateAgentInputSchema.parse({ datasets: [], intents: [] });
    expect(clear.datasets).toEqual([]);
    expect(clear.intents).toEqual([]);
  });
});

describe('agentViewSchema', () => {
  const base = {
    id: UUID,
    name: '客服助手',
    description: null,
    systemPrompt: null,
    type: 'chat',
    modelId: UUID,
    modelName: 'gpt-4o',
    rerankModelId: null,
    rerankModelName: null,
    status: 'active',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  it('完整视图通过（含知识库与意图绑定）', () => {
    const view = agentViewSchema.parse({
      ...base,
      datasets: [{ datasetId: UUID, datasetName: '商品库', weight: 100 }],
      intents: [
        {
          agentIntentId: UUID,
          intentId: UUID,
          name: '退货',
          description: null,
          examples: ['怎么退'],
          strategy: 'retrieval',
          responseTemplate: null,
          workflowId: null,
          datasetId: UUID,
          priority: 0,
        },
      ],
    });
    expect(view.datasets[0]?.datasetName).toBe('商品库');
    expect(view.intents[0]?.strategy).toBe('retrieval');
  });

  it('tools 字段：视图透出工具清单，缺省默认为空数组', () => {
    const withTools = agentViewSchema.parse({
      ...base,
      datasets: [],
      intents: [],
      tools: ['local_retrieval', 'http_request'],
    });
    expect(withTools.tools).toEqual(['local_retrieval', 'http_request']);

    const withoutTools = agentViewSchema.parse({ ...base, datasets: [], intents: [] });
    expect(withoutTools.tools).toEqual([]);
  });

  it('非法 strategy / 缺失必填字段拒绝', () => {
    expect(() =>
      agentViewSchema.parse({
        ...base,
        intents: [
          {
            agentIntentId: UUID,
            intentId: UUID,
            name: 'x',
            description: null,
            examples: [],
            strategy: 'bad' as never,
            responseTemplate: null,
            workflowId: null,
            datasetId: null,
            priority: 0,
          },
        ],
      }),
    ).toThrow();
    expect(() => agentViewSchema.parse({ ...base, name: undefined })).toThrow();
  });

  it('agentIntentViewSchema / agentDatasetViewSchema 字段齐全', () => {
    const intent = agentIntentViewSchema.parse({
      agentIntentId: UUID,
      intentId: UUID,
      name: '售后',
      description: '售后意图',
      examples: ['坏了'],
      strategy: 'direct',
      responseTemplate: '已为您登记售后',
      workflowId: null,
      datasetId: null,
      priority: 1,
    });
    expect(intent.responseTemplate).toBe('已为您登记售后');
    // workflowInputs 缺省为 undefined（nullish 兼容未配置场景）
    expect(intent.workflowInputs).toBeUndefined();
    expect(
      agentDatasetViewSchema.parse({ datasetId: UUID, datasetName: null, weight: 50 }).weight,
    ).toBe(50);
  });

  it('agentIntentViewSchema：workflowInputs 透出（固定值 / null / $extract 均可消费）', () => {
    const fixed = agentIntentViewSchema.parse({
      agentIntentId: UUID,
      intentId: UUID,
      name: '深入',
      description: null,
      examples: [],
      strategy: 'workflow',
      responseTemplate: null,
      workflowId: UUID,
      workflowInputs: { step: 5 },
      datasetId: null,
      priority: 0,
    });
    expect(fixed.workflowInputs).toEqual({ step: 5 });

    // null 显式传入也通过（视图可能返回 null）
    const withNull = agentIntentViewSchema.parse({
      agentIntentId: UUID,
      intentId: UUID,
      name: '深入',
      description: null,
      examples: [],
      strategy: 'workflow',
      responseTemplate: null,
      workflowId: UUID,
      workflowInputs: null,
      datasetId: null,
      priority: 0,
    });
    expect(withNull.workflowInputs).toBeNull();
  });
});

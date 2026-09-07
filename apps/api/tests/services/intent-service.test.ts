/**
 * M4 意图识别引擎单测 —— mock 确定性路由 / LLM 分类 / fallback / prompt 与 JSON 解析。
 *
 * 覆盖：
 *  - classifyMock 关键词/示例路由、阈值、并列优先级与字典序确定性；
 *  - buildIntentPrompt 候选意图序列化；
 *  - parseIntentJson 容忍 markdown 与前后缀；
 *  - createIntentService.classify 三态：无候选 / mock / llm / 缺失分类器抛错。
 */
import { describe, expect, it } from 'vitest';
import type { IntentCandidate } from '../../src/services/intent-service.js';
import {
  buildIntentPrompt,
  classifyMock,
  createIntentService,
  parseIntentJson,
} from '../../src/services/intent-service.js';

const UUID = '00000000-0000-0000-0000-000000000000';

function cand(overrides: Partial<IntentCandidate> = {}): IntentCandidate {
  return {
    intentId: UUID,
    name: '退货',
    description: null,
    examples: ['怎么退货', '我要退'],
    strategy: 'retrieval',
    responseTemplate: null,
    workflowId: null,
    datasetId: null,
    priority: 0,
    ...overrides,
  };
}

describe('classifyMock 确定性路由', () => {
  it('示例命中：query 包含示例子串 → 命中并标记 matchedBy=mock', () => {
    const hit = classifyMock('你好，怎么退货？', [cand()]);
    expect(hit).not.toBeNull();
    expect(hit?.intentId).toBe(UUID);
    expect(hit?.matchedBy).toBe('mock');
    expect(hit?.score).toBeGreaterThanOrEqual(2);
  });

  it('名称命中 +3；示例命中 +2；名称权重大于单条示例', () => {
    const bare = cand({ examples: ['完全无关的示例文本'] });
    // 仅名称命中（query=意图名）→ +3
    expect(classifyMock('退货', [bare])?.score).toBe(3);
    // 仅示例命中（示例与 query 互含，名称不匹配）→ +2
    const exOnly = cand({ name: '退货运费险', examples: ['我要退'] });
    expect(classifyMock('我要退', [exOnly])?.score).toBe(2);
  });

  it('双向子串：意图名包含整段 query（长度≥2）也能命中', () => {
    const hit = classifyMock('退货', [cand({ name: '退货运费险', examples: [] })]);
    expect(hit?.score).toBe(3);
  });

  it('低于阈值不命中 → null（噪声短词/无关联）', () => {
    expect(classifyMock('嗯', [cand()])).toBeNull();
    expect(classifyMock('你好啊', [cand()])).toBeNull();
  });

  it('minScore 可调：传 5 时普通命中（≤4 分）被过滤', () => {
    // 仅名称命中 +3 < 5 → 过滤
    expect(classifyMock('退货', [cand({ examples: [] })], 5)).toBeNull();
    // minScore=3 时名称命中通过
    expect(classifyMock('退货', [cand({ examples: [] })], 3)?.score).toBe(3);
  });

  it('空候选 / 空白 query → null', () => {
    expect(classifyMock('任意', [])).toBeNull();
    expect(classifyMock('   ', [cand()])).toBeNull();
    expect(classifyMock('', [cand()])).toBeNull();
  });

  it('多意图命中同分 → 取 priority 高者；再同分 → 名称字典序小者（确定性）', () => {
    const a = cand({ intentId: '11111111-1111-1111-1111-111111111111', name: 'B意图', priority: 0 });
    const b = cand({ intentId: '22222222-2222-2222-2222-222222222222', name: 'A意图', priority: 1 });
    const hit = classifyMock('怎么退货', [a, b]);
    expect(hit?.intentId).toBe('22222222-2222-2222-2222-222222222222');

    const a2 = cand({ intentId: '11111111-1111-1111-1111-111111111111', name: 'B意图', priority: 1 });
    const b2 = cand({ intentId: '22222222-2222-2222-2222-222222222222', name: 'A意图', priority: 1 });
    const hit2 = classifyMock('怎么退货', [a2, b2]);
    expect(hit2?.intentId).toBe('22222222-2222-2222-2222-222222222222');
  });

  it('返回匹配携带策略/话术/知识库子集供编排层消费', () => {
    const hit = classifyMock('怎么退货', [cand({ strategy: 'direct', responseTemplate: '已登记', datasetId: UUID })]);
    expect(hit?.strategy).toBe('direct');
    expect(hit?.responseTemplate).toBe('已登记');
    expect(hit?.datasetId).toBe(UUID);
  });
});

describe('buildIntentPrompt', () => {
  it('序列化候选意图（id/名称/描述/示例），并含用户输入', () => {
    const prompt = buildIntentPrompt('怎么退货', [
      cand({ name: '退货', description: '售后退货', examples: ['怎么退货', '我要退'] }),
    ]);
    expect(prompt).toContain('00000000-0000-0000-0000-000000000000');
    expect(prompt).toContain('退货');
    expect(prompt).toContain('售后退货');
    expect(prompt).toContain('怎么退货');
    expect(prompt).toContain('用户输入：怎么退货');
  });

  it('无示例/无描述的意图不输出多余段', () => {
    const prompt = buildIntentPrompt('x', [cand({ description: null, examples: [] })]);
    expect(prompt).not.toContain('示例：');
    expect(prompt).not.toContain('描述：');
  });
});

describe('parseIntentJson', () => {
  it('纯 JSON 与 markdown 代码块均能解析', () => {
    expect(parseIntentJson('{"intentId": "abc"}')?.intentId).toBe('abc');
    expect(parseIntentJson('```json\n{"intentId": "abc"}\n```')?.intentId).toBe('abc');
  });

  it('前后缀噪声容忍：提取首个 JSON 对象', () => {
    expect(parseIntentJson('好的，结果如下 {"intentId": "abc"} 完毕')?.intentId).toBe('abc');
  });

  it('intentId=null / 缺失 / 空串 → { intentId: null }；非法 JSON → null', () => {
    expect(parseIntentJson('{"intentId": null}')?.intentId).toBeNull();
    expect(parseIntentJson('{"other": 1}')?.intentId).toBeNull();
    expect(parseIntentJson('{"intentId": ""}')).toBeNull();
    expect(parseIntentJson('not json at all')).toBeNull();
  });
});

describe('createIntentService.classify 三态', () => {
  const candidates = [cand({ name: '退货', examples: ['怎么退货'] })];

  it('候选为空 → 直接 null（无意图配置走全库检索）', async () => {
    const service = createIntentService({ isMock: () => false, classify: async () => '{"intentId": "x"}' });
    expect(await service.classify('怎么退货', [])).toBeNull();
  });

  it('mock 模式：确定性命中，不触网', async () => {
    const service = createIntentService({ isMock: () => true, classify: async () => '{"intentId": "nope"}' });
    const hit = await service.classify('怎么退货', candidates);
    expect(hit?.matchedBy).toBe('mock');
    expect(hit?.intentId).toBe(UUID);
  });

  it('LLM 模式：分类器返回匹配 id → 命中对应候选', async () => {
    const service = createIntentService({
      isMock: () => false,
      classify: async () => `{"intentId": "${UUID}"}`,
    });
    const hit = await service.classify('怎么退货', candidates);
    expect(hit?.matchedBy).toBe('llm');
    expect(hit?.intentId).toBe(UUID);
  });

  it('LLM 模式：分类器返回 null / 未知 id → fallback null', async () => {
    const service = createIntentService({
      isMock: () => false,
      classify: async () => '{"intentId": null}',
    });
    expect(await service.classify('怎么退货', candidates)).toBeNull();

    const unknown = createIntentService({
      isMock: () => false,
      classify: async () => '{"intentId": "99999999-9999-9999-9999-999999999999"}',
    });
    expect(await unknown.classify('怎么退货', candidates)).toBeNull();
  });

  it('非 mock 模式且未注入分类器 → 抛错（不静默误判）', async () => {
    const service = createIntentService({ isMock: () => false });
    await expect(service.classify('怎么退货', candidates)).rejects.toThrow(
      'LLM 分类实现未注入',
    );
  });
});

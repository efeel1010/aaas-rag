/**
 * 主备降级网关单测 —— chatStreamWithFallback / completeWithFallback / isTransientProviderError。
 *
 * 通过注入 streamImpl 打桩验证降级切换：
 *  主模型抛瞬时错误（且未产出 delta）→ 自动切备用；
 *  非瞬时错误 / 已产出 delta / 无备用时不降级。
 */
import { describe, expect, it } from 'vitest';
import {
  chatStreamWithFallback,
  completeWithFallback,
  isTransientProviderError,
} from '../../src/lib/models/index.js';
import { ProviderError, ProviderUnavailableError, ProviderAuthError } from '../../src/lib/models/errors.js';
import type { ModelStreamEvent } from '@pulse/contracts';
import type { ChatInvocation, ModelDescriptor, ProviderDescriptor } from '../../src/lib/models/types.js';

const UUID = '00000000-0000-0000-0000-000000000000';

function entry(name: string) {
  return {
    provider: { id: UUID, type: 'openai' as const, name: `p-${name}`, config: null, credentials: {} },
    model: { id: UUID, name, modelType: 'llm' as const, config: null },
  };
}

type StreamImpl = (
  provider: ProviderDescriptor,
  model: ModelDescriptor,
  request: ChatInvocation,
) => AsyncIterable<ModelStreamEvent>;

/** 生成器桩：按 model.name 返回「首事件前抛错」或「产出若干 delta」 */
function stubStream(behavior: Record<string, { failBefore?: unknown; lines?: string[] }>): StreamImpl {
  return async function* (provider, model) {
    const b = behavior[model.name];
    if (!b) throw new ProviderUnavailableError(`无 ${model.name}`);
    if (b.failBefore !== undefined) throw b.failBefore;
    for (const line of b.lines ?? []) {
      yield { type: 'delta', content: line };
    }
    yield { type: 'done' };
  };
}

async function collect(gen: AsyncIterable<ModelStreamEvent>): Promise<string[]> {
  const out: string[] = [];
  for await (const evt of gen) out.push(`${evt.type}:${'content' in evt ? (evt.content as string) : ''}`);
  return out;
}

const REQ: ChatInvocation = { messages: [{ role: 'user', content: 'hi' }] };

describe('isTransientProviderError', () => {
  it('瞬时错误返回 true', () => {
    expect(isTransientProviderError(new ProviderUnavailableError())).toBe(true);
    expect(isTransientProviderError(new ProviderError('5xx', 503))).toBe(true);
    expect(isTransientProviderError(new ProviderError('5xx', 500))).toBe(true);
    expect(isTransientProviderError(new TypeError('fetch failed'))).toBe(true);
  });
  it('非瞬时错误返回 false', () => {
    expect(isTransientProviderError(new ProviderAuthError())).toBe(false);
    expect(isTransientProviderError(new ProviderError('4xx', 400))).toBe(false);
    expect(isTransientProviderError(new Error('unknown'))).toBe(false);
  });
});

describe('chatStreamWithFallback / completeWithFallback', () => {
  it('主模型首次调用即瞬时失败（无 delta）→ 自动切备用', async () => {
    const stream = stubStream({
      'm-main': { failBefore: new ProviderUnavailableError('upstream down') },
      'm-backup': { lines: ['备用完整回复'] },
    });
    const out = await collect(
      chatStreamWithFallback([entry('m-main'), entry('m-backup')], REQ, stream),
    );
    expect(out.join('|')).toContain('delta:备用完整回复');
  });

  it('主模型已产出 delta 后失败 → 不降级（避免重复输出），错误上抛', async () => {
    let calls = 0;
    const stream: StreamImpl = async function* () {
      calls += 1;
      yield { type: 'delta', content: '半截回答' };
      throw new ProviderUnavailableError('mid-stream');
    };
    await expect(
      collect(chatStreamWithFallback([entry('m-main'), entry('m-backup')], REQ, stream)),
    ).rejects.toThrow(/mid-stream/);
    expect(calls).toBe(1);
  });

  it('鉴权错误不可降级，直接抛出', async () => {
    const stream = stubStream({
      'm-main': { failBefore: new ProviderAuthError('bad key') },
      'm-backup': { lines: ['备用'] },
    });
    await expect(
      collect(chatStreamWithFallback([entry('m-main'), entry('m-backup')], REQ, stream)),
    ).rejects.toThrow(/bad key/);
  });

  it('无备用且瞬时失败 → 抛出', async () => {
    const stream = stubStream({
      'm-main': { failBefore: new ProviderUnavailableError('down') },
    });
    await expect(
      collect(chatStreamWithFallback([entry('m-main')], REQ, stream)),
    ).rejects.toThrow(/down/);
  });

  it('completeWithFallback 聚合备用内容', async () => {
    const stream = stubStream({
      'm-main': { failBefore: new ProviderUnavailableError('down') },
      'm-backup': { lines: ['备用完整回复'] },
    });
    const result = await completeWithFallback([entry('m-main'), entry('m-backup')], REQ, stream);
    expect(result.content).toBe('备用完整回复');
  });
});
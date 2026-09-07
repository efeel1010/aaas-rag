/**
 * M7 API 网关 —— 密钥工具（哈希/校验/生成/范围）单测。
 */
import { describe, expect, it } from 'vitest';
import {
  checkScope,
  generateApiKey,
  hashApiKey,
  verifyApiKey,
} from '../src/lib/api-key.js';

const AGENT_A = '11111111-1111-4111-8111-111111111111';
const AGENT_B = '22222222-2222-4222-8222-222222222222';

describe('hashApiKey / verifyApiKey', () => {
  it('哈希为 64 位十六进制且稳定', () => {
    const h = hashApiKey('rk_secret');
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(hashApiKey('rk_secret')).toBe(h);
  });

  it('verify 命中/未命中', () => {
    const h = hashApiKey('rk_good');
    expect(verifyApiKey('rk_good', h)).toBe(true);
    expect(verifyApiKey('rk_bad', h)).toBe(false);
    // 长度不同也不抛错
    expect(verifyApiKey('x', h)).toBe(false);
  });
});

describe('generateApiKey', () => {
  it('生成格式正确：前缀 + 下划线 + 足够长度明文；hashed 能通过校验', () => {
    const gen = generateApiKey();
    expect(gen.raw.startsWith('rk_')).toBe(true);
    expect(gen.raw.length).toBeGreaterThan(20);
    expect(gen.prefix.includes('…')).toBe(true);
    // 服务端只存哈希：用户明文应能通过哈希比对，但服务端无法反推出明文
    expect(verifyApiKey(gen.raw, gen.hashed)).toBe(true);
    expect(gen.hashed).not.toContain(gen.raw.slice(3, 8));
  });

  it('两次生成明文不同', () => {
    expect(generateApiKey().raw).not.toBe(generateApiKey().raw);
  });
});

describe('checkScope', () => {
  const scope = { agents: [AGENT_A] };
  it('scope 为空 / 目标为空时放行', () => {
    expect(() => checkScope(null, {})).not.toThrow();
    expect(() => checkScope(undefined, { agentId: AGENT_A })).not.toThrow();
    expect(() => checkScope(scope, {})).not.toThrow();
  });

  it('目标不在白名单抛出 Forbidden', () => {
    expect(() => checkScope(scope, { agentId: AGENT_B })).toThrow();
    expect(() => checkScope(scope, { agentId: AGENT_B })).toThrow(/无权/);
  });

  it('目标在白名单放行；\'*\' 全放行', () => {
    expect(() => checkScope(scope, { agentId: AGENT_A })).not.toThrow();
    expect(() => checkScope({ agents: '*' }, { agentId: AGENT_B })).not.toThrow();
  });

  it('datasets 白名单任一越界即拒绝', () => {
    const ds = '33333333-3333-4333-8333-333333333333';
    expect(() =>
      checkScope({ datasets: ['44444444-4444-4444-8444-444444444444'] }, { datasetIds: [ds, AGENT_A] }),
    ).toThrow(/知识库/);
    expect(() =>
      checkScope({ datasets: ['44444444-4444-4444-8444-444444444444'] }, { datasetIds: [ds] }),
    ).toThrow();
  });
});
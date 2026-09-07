/**
 * @pulse/contracts M7 API 网关契约单测 —— 校验 api-key 相关 schema 的约束。
 */
import { describe, expect, it } from 'vitest';
import {
  apiKeyCreatedSchema,
  apiKeyScopeSchema,
  apiKeyUsageSummarySchema,
  apiKeyViewSchema,
  createApiKeyInputSchema,
  setApiKeyStatusInputSchema,
} from '../src/api.js';

const UUID = '00000000-0000-0000-0000-000000000000';

describe('apiKeyScopeSchema', () => {
  it('接受空对象 / '*' / uuid 数组', () => {
    expect(apiKeyScopeSchema.parse({})).toEqual({});
    expect(apiKeyScopeSchema.parse({ agents: '*' })).toEqual({ agents: '*' });
    expect(apiKeyScopeSchema.parse({ datasets: [UUID] })).toEqual({ datasets: [UUID] });
  });
  it('拒绝非 uuid 的白名单项 / 非法通配', () => {
    expect(() => apiKeyScopeSchema.parse({ agents: ['not-a-uuid'] })).toThrow();
    expect(() => apiKeyScopeSchema.parse({ agents: 42 })).toThrow();
  });
});

describe('createApiKeyInputSchema', () => {
  it('最小合法输入通过；scope 可选', () => {
    const input = createApiKeyInputSchema.parse({ name: '生产密钥' });
    expect(input.name).toBe('生产密钥');
    expect(input.rpm).toBeUndefined();
  });
  it('完整输入通过', () => {
    const input = createApiKeyInputSchema.parse({
      name: '网关',
      quota: 100000,
      rpm: 60,
      expiresAt: '2030-01-01T00:00:00.000Z',
      scope: { agents: '*' },
    });
    expect(input.rpm).toBe(60);
    expect(input.scope?.agents).toBe('*');
  });
  it('rpm/quota 非法（0 / 负数）与未知字段被拒绝', () => {
    expect(() => createApiKeyInputSchema.parse({ name: 'x', rpm: 0 })).toThrow();
    expect(() => createApiKeyInputSchema.parse({ name: 'x', quota: -1 })).toThrow();
    expect(() =>
      createApiKeyInputSchema.parse({ name: 'x', extra: true }),
    ).toThrow();
  });
});

describe('setApiKeyStatusInputSchema', () => {
  it('接受 active/disabled，拒绝其它状态', () => {
    expect(setApiKeyStatusInputSchema.parse({ status: 'active' }).status).toBe('active');
    expect(() => setApiKeyStatusInputSchema.parse({ status: 'paused' })).toThrow();
    // strict：多余字段拒绝
    expect(() =>
      setApiKeyStatusInputSchema.parse({ status: 'active', foo: 1 }),
    ).toThrow();
  });
});

describe('apiKeyView / apiKeyCreated', () => {
  const base = {
    id: UUID,
    name: 'k',
    prefix: 'rk_abcd…1234',
    status: 'active' as const,
    quota: null,
    rpm: 10,
    scope: null,
    lastUsedAt: null,
    expiresAt: null,
    createdAt: '2020-01-01T00:00:00.000Z',
  };
  it('view 不含密钥字段（无 key 键）', () => {
    const parsed = apiKeyViewSchema.parse(base);
    expect(parsed).not.toHaveProperty('key');
  });
  it('created 在 view 基础上携带一次明文 key', () => {
    const created = apiKeyCreatedSchema.parse({ ...base, key: 'rk_secret' });
    expect(created.key).toBe('rk_secret');
    // key 缺失则失败
    expect(() => apiKeyCreatedSchema.parse(base)).toThrow();
  });
});

describe('apiKeyUsageSummarySchema', () => {
  it('聚合按日/按端点结构合法', () => {
    const summary = apiKeyUsageSummarySchema.parse({
      apiKeyId: UUID,
      byDay: [{ date: '2026-08-26', requests: 12, tokens: 1200 }],
      byEndpoint: [
        { route: '/chat', requests: 12, tokens: 1200, avgLatencyMs: 320.5 },
      ],
    });
    expect(summary.byDay[0]?.requests).toBe(12);
    expect(summary.byEndpoint[0]?.avgLatencyMs).toBe(320.5);
  });
});
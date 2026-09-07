/**
 * M7 API 网关 —— 对外鉴权中间件单测。
 * 通过注入 fake 依赖（resolveKey / recordUsage / countUsage / rateLimiter）在无需
 * 真实 DB / Redis 的前提下，端到端验证 401/403/429、scope、配额、限流头与用量采样。
 */
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { ok } from '../src/lib/http.js';
import { onError } from '../src/middleware/error-handler.js';
import {
  requireExternalApi,
  type ExternalAuthDeps,
} from '../src/middleware/api-gateway.js';
import type { RateLimiter } from '../src/lib/ratelimit.js';
import type { ResolvedApiKey } from '../src/services/api-key-store.js';
import type { AppEnv } from '../src/types.js';

const AGENT_A = '11111111-1111-4111-8111-111111111111';
const AGENT_B = '22222222-2222-4222-8222-222222222222';
const WF_A = '33333333-3333-4333-8333-333333333333';
const WF_B = '44444444-4444-4444-8444-444444444444';

const VALID_RAW = 'rk_valid-secret';

function activeKey(overrides: Partial<ResolvedApiKey> = {}): ResolvedApiKey {
  return {
    id: '00000000-0000-0000-0000-000000000001',
    name: 'test',
    prefix: 'rk_xxxx…',
    status: 'active',
    quota: null,
    rpm: null,
    scope: null,
    resourceType: null,
    resourceId: null,
    expiresAt: null,
    ...overrides,
  };
}

class CountingLimiter implements RateLimiter {
  private n = 0;
  constructor(private readonly max: number) {}
  async check() {
    this.n += 1;
    const allowed = this.n <= this.max;
    return {
      allowed,
      limit: this.max,
      remaining: Math.max(0, this.max - this.n),
      reset: Date.now() + 60_000,
    };
  }
}

interface Harness {
  recordUsage: ReturnType<typeof vi.fn>;
  countUsage: ReturnType<typeof vi.fn>;
  app: ReturnType<typeof buildApp>;
}

function buildApp(deps: {
  resolveKey: ExternalAuthDeps['resolveKey'];
  recordUsage: ExternalAuthDeps['recordUsage'];
  countUsage: ExternalAuthDeps['countUsage'];
  rateLimiter?: RateLimiter;
  redisDegraded?: boolean;
}) {
  const fullDeps: ExternalAuthDeps = {
    resolveKey: deps.resolveKey,
    recordUsage: deps.recordUsage,
    countUsage: deps.countUsage,
    rateLimiter: deps.rateLimiter,
    redisDegraded: deps.redisDegraded ?? false,
  };
  const app = new Hono<AppEnv>();
  app.onError(onError);
  app.post(
    '/v1/chat',
    requireExternalApi({
      route: '/chat',
      agentFrom: { type: 'body', field: 'agentId' },
      deps: fullDeps,
    }),
    async (c) => c.json(ok({ echo: true })),
  );
  app.post(
    '/v1/run',
    requireExternalApi({
      route: '/run',
      workflowFrom: { type: 'body', field: 'workflowId' },
      deps: fullDeps,
    }),
    async (c) => c.json(ok({ echo: true })),
  );
  return app;
}

function harness(key: ResolvedApiKey, cfg: { rateLimiter?: RateLimiter; count?: number } = {}): Harness {
  const recordUsage = vi.fn(async () => undefined);
  const countUsage = vi.fn(async () => cfg.count ?? 0);
  const app = buildApp({
    resolveKey: async (raw) => (raw === VALID_RAW ? key : null),
    recordUsage,
    countUsage,
    rateLimiter: cfg.rateLimiter,
  });
  return { recordUsage, countUsage, app };
}

function call(app: ReturnType<typeof buildApp>, opts: { raw?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.raw !== undefined) headers.authorization = `Bearer ${opts.raw}`;
  return app.request('/v1/chat', {
    method: 'POST',
    headers,
    body: JSON.stringify(opts.body ?? {}),
  });
}

function callRun(app: ReturnType<typeof buildApp>, opts: { raw?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.raw !== undefined) headers.authorization = `Bearer ${opts.raw}`;
  return app.request('/v1/run', {
    method: 'POST',
    headers,
    body: JSON.stringify(opts.body ?? {}),
  });
}

describe('requireExternalApi —— 鉴权', () => {
  it('缺少 Authorization 头 → 站内放行（不校验/不限流/不计量）', async () => {
    const { app, recordUsage, countUsage } = harness(activeKey());
    const res = await call(app);
    expect(res.status).toBe(200);
    // 站内通道不应走任何外部校验 / 用量采样
    expect(recordUsage).not.toHaveBeenCalled();
    expect(countUsage).not.toHaveBeenCalled();
  });

  it('无效密钥 → 401', async () => {
    const { app } = harness(activeKey());
    const res = await call(app, { raw: 'rk_wrong' });
    expect(res.status).toBe(401);
  });

  it('已停用 / 已过期 → 401', async () => {
    const disabled = harness(activeKey({ status: 'disabled' }));
    expect((await call(disabled.app, { raw: VALID_RAW })).status).toBe(401);
    const expired = harness(activeKey({ expiresAt: new Date(Date.now() - 1000) }));
    expect((await call(expired.app, { raw: VALID_RAW })).status).toBe(401);
  });

  it('合法密钥放行，且用量采样被调用（route/status/apikeyId）', async () => {
    const { app, recordUsage } = harness(activeKey());
    const res = await call(app, { raw: VALID_RAW, body: { agentId: AGENT_A } });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { success: boolean; data: { echo: boolean } };
    expect(json).toEqual({ success: true, data: { echo: true } });

    expect(recordUsage).toHaveBeenCalledTimes(1);
    const rec = recordUsage.mock.calls[0]?.[0];
    expect(rec.apikeyId).toBe('00000000-0000-0000-0000-000000000001');
    expect(rec.route).toBe('/chat');
    expect(rec.status).toBe(200);
    expect(typeof rec.latencyMs).toBe('number');
    expect(rec.agentId).toBe(AGENT_A);
  });

  it('scope 白名单外目标 → 403', async () => {
    const key = activeKey({ scope: { agents: [AGENT_A] } });
    const { app } = harness(key);
    // body.agentId 不在白名单
    const bad = await call(app, { raw: VALID_RAW, body: { agentId: AGENT_B } });
    expect(bad.status).toBe(403);
    // 在白名单放行
    const good = await call(app, { raw: VALID_RAW, body: { agentId: AGENT_A } });
    expect(good.status).toBe(200);
  });

  it('配额用尽 → 429 QUOTA_EXCEEDED', async () => {
    const key = activeKey({ quota: 10 });
    const { app } = harness(key, { count: 10 });
    const res = await call(app, { raw: VALID_RAW });
    expect(res.status).toBe(429);
    const json = (await res.json()) as { success: false; error: { code: string } };
    expect(json.error.code).toBe('QUOTA_EXCEEDED');
  });

  it('rpm 超限 → 429 RATE_LIMITED 且带 x-ratelimit 头', async () => {
    const key = activeKey({ rpm: 1 });
    const { app, recordUsage } = harness(key, { rateLimiter: new CountingLimiter(1) });
    const first = await call(app, { raw: VALID_RAW });
    expect(first.status).toBe(200);
    expect(first.headers.get('x-ratelimit-limit')).toBe('1');

    const second = await call(app, { raw: VALID_RAW });
    expect(second.status).toBe(429);
    const json = (await second.json()) as { success: false; error: { code: string } };
    expect(json.error.code).toBe('RATE_LIMITED');
    // 被限流的请求不记用量
    expect(recordUsage).toHaveBeenCalledTimes(1);
  });

  it('Redis 降级（redisDegraded=true）时 rpm 不拦截并降级标注头', async () => {
    const key = activeKey({ rpm: 1 });
    const recordUsage = vi.fn(async () => undefined);
    const alreadyDegraded = buildApp({
      resolveKey: async (raw) => (raw === VALID_RAW ? key : null),
      recordUsage,
      countUsage: async () => 0,
      redisDegraded: true,
    });
    // 即便超过 rpm，降级也放行
    await call(alreadyDegraded, { raw: VALID_RAW });
    const second = await call(alreadyDegraded, { raw: VALID_RAW });
    expect(second.status).toBe(200);
  });
});

describe('requireExternalApi —— 资源级 token 绑定校验', () => {
  it('agent 专属 key 调用自己的 agent → 放行', async () => {
    const key = activeKey({ resourceType: 'agent', resourceId: AGENT_A });
    const { app } = harness(key);
    const res = await call(app, { raw: VALID_RAW, body: { agentId: AGENT_A } });
    expect(res.status).toBe(200);
  });

  it('agent 专属 key 调用其他 agent → 403', async () => {
    const key = activeKey({ resourceType: 'agent', resourceId: AGENT_A });
    const { app } = harness(key);
    const res = await call(app, { raw: VALID_RAW, body: { agentId: AGENT_B } });
    expect(res.status).toBe(403);
  });

  it('agent 专属 key 调用 workflow 端点 → 403（禁止跨类型）', async () => {
    const key = activeKey({ resourceType: 'agent', resourceId: AGENT_A });
    const { app } = harness(key);
    const res = await callRun(app, { raw: VALID_RAW, body: { workflowId: WF_A } });
    expect(res.status).toBe(403);
  });

  it('workflow 专属 key 调用自己的 workflow → 放行', async () => {
    const key = activeKey({ resourceType: 'workflow', resourceId: WF_A });
    const { app } = harness(key);
    const res = await callRun(app, { raw: VALID_RAW, body: { workflowId: WF_A } });
    expect(res.status).toBe(200);
  });

  it('workflow 专属 key 调用其他 workflow → 403', async () => {
    const key = activeKey({ resourceType: 'workflow', resourceId: WF_A });
    const { app } = harness(key);
    const res = await callRun(app, { raw: VALID_RAW, body: { workflowId: WF_B } });
    expect(res.status).toBe(403);
  });

  it('workflow 专属 key 调用 agent 端点 → 403（禁止跨类型）', async () => {
    const key = activeKey({ resourceType: 'workflow', resourceId: WF_A });
    const { app } = harness(key);
    const res = await call(app, { raw: VALID_RAW, body: { agentId: AGENT_A } });
    expect(res.status).toBe(403);
  });
});
/**
 * M7 开放 API 网关中间件 —— 对外鉴权 / 限流 / 用量采样。
 *
 * 职责划分：
 *  - 全局 auth()：仅解析 Authorization 注入 kind，不做 DB 校验；
 *  - requireExternalApi(opts)：挂在「对外调用类」端点，完成
 *        密钥哈希比对 → 状态/过期 → scope 白名单 → quota → rpm 滑动窗口限流
 *    → 注入 AuthContext(apiKeyId) → 响应后统一用量采样落库；
 *  - requireManagementApiKey()：可选（ENABLE_API_KEY_FOR_MANAGEMENT=true）
 *    对「管理类」路由做轻量 key 保护（不涉及限流 / 用量）。
 *
 * 降级：Redis 不可用时 rpm 限流 fail-open（放行 + 头降级标注），鉴权 / 配额 / 用量走 DB。
 */
import type { Context, MiddlewareHandler } from 'hono';
import { createMiddleware } from 'hono/factory';
import type { UsageRecord } from './auth.js';
import type { AppEnv } from '../types.js';
import { checkScope } from '../lib/api-key.js';
import {
  DEFAULT_WINDOW_MS,
  getRateLimiter,
  type RateLimitResult,
  type RateLimiter,
} from '../lib/ratelimit.js';
import { isRedisDegraded } from '../lib/redis.js';
import { apiKeyStore, type ResolvedApiKey } from '../services/api-key-store.js';
import {
  AppError,
  ForbiddenError,
  QuotaExceededError,
  TooManyRequestsError,
  UnauthorizedError,
} from '../lib/errors.js';
import { logger } from '../lib/logger.js';

/** 依赖注入（生产走默认实现；单测可替换以避开 DB / Redis） */
export interface ExternalAuthDeps {
  resolveKey(raw: string): Promise<ResolvedApiKey | null>;
  recordUsage(rec: UsageRecord): Promise<void>;
  countUsage(apikeyId: string): Promise<number>;
  rateLimiter?: RateLimiter;
  /** 覆盖降级判定（默认 isRedisDegraded()） */
  redisDegraded?: boolean;
}

/** 端点声明：路由规范化名 + scope 目标解析来源 */
export interface ExternalRouteOptions {
  /** 用量 / 限流 bucket 使用的规范化路由（相对 /api/v1，如 /agents/:id/chat） */
  route: string;
  /** 目标 Agent 来源（scope 校验）：从 URL 参数或请求体字段解析 */
  agentFrom?: { type: 'path'; param: string } | { type: 'body'; field: string };
  /** 目标知识库来源（scope 校验）：从 URL 参数解析；并可选并入 body.datasetIds */
  datasetFrom?: { type: 'path'; param: string };
  /** 目标工作流来源（资源绑定校验）：从请求体字段解析（如 /workflows/run 的 workflowId） */
  workflowFrom?: { type: 'body'; field: string };
  mergeBodyDatasetIds?: boolean;
  deps?: Partial<ExternalAuthDeps>;
}

const defaultDeps: ExternalAuthDeps = {
  resolveKey: (raw) => apiKeyStore.resolveByRaw(raw),
  recordUsage: (rec) => apiKeyStore.recordUsage(rec),
  countUsage: (id) => apiKeyStore.usageCount(id),
};

/** 将请求体安全序列化为字符串（用于调用内容采样），失败时返回 null */
function safeStringify(body: unknown): string | null {
  try {
    return JSON.stringify(body);
  } catch {
    return null;
  }
}

function bearerToken(c: Context<AppEnv>): string | null {
  const h = c.req.header('authorization');
  if (h?.startsWith('Bearer ')) {
    const t = h.slice('Bearer '.length).trim();
    if (t) return t;
  }
  return null;
}

async function resolveScopeTarget(
  c: Context<AppEnv>,
  opts: ExternalRouteOptions,
): Promise<{
  agentId?: string;
  workflowId?: string;
  datasetIds?: string[];
  requestContent?: string | null;
}> {
  let agentId: string | undefined;
  let workflowId: string | undefined;
  let datasetIds: string[] | undefined;

  if (opts.agentFrom?.type === 'path') agentId = c.req.param(opts.agentFrom.param);
  if (opts.datasetFrom?.type === 'path') {
    const p = c.req.param(opts.datasetFrom.param);
    if (p) datasetIds = [p];
  }

  const wantBody =
    opts.agentFrom?.type === 'body' ||
    opts.workflowFrom?.type === 'body' ||
    Boolean(opts.mergeBodyDatasetIds);

  // 统一读取 JSON 请求体（该中间件只挂载于 POST 端点），用于字段解析与调用内容采样。
  const body = (await c.req.json<Record<string, unknown>>().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  const requestContent = body != null ? safeStringify(body) : null;

  if (wantBody && body != null) {
    if (opts.agentFrom?.type === 'body' && typeof body[opts.agentFrom.field] === 'string') {
      agentId = body[opts.agentFrom.field] as string;
    }
    if (opts.workflowFrom?.type === 'body' && typeof body[opts.workflowFrom.field] === 'string') {
      workflowId = body[opts.workflowFrom.field] as string;
    }
    if (opts.mergeBodyDatasetIds && Array.isArray(body.datasetIds)) {
      const ids = body.datasetIds.filter((x): x is string => typeof x === 'string');
      if (ids.length) datasetIds = [...(datasetIds ?? []), ...ids];
    }
  }
  return { agentId, workflowId, datasetIds: datasetIds && datasetIds.length ? datasetIds : undefined, requestContent };
}

function rateLimitBucket(apikeyId: string, route: string): string {
  return `rl:${apikeyId}:${route}:${DEFAULT_WINDOW_MS}`;
}

function writeRateHeaders(c: Context<AppEnv>, r: Pick<RateLimitResult, 'limit' | 'remaining' | 'reset'>): void {
  c.header('x-ratelimit-limit', String(r.limit));
  c.header('x-ratelimit-remaining', String(r.remaining));
  c.header('x-ratelimit-reset', String(r.reset));
}

async function flushUsage(
  start: number,
  status: number,
  usage: UsageRecord,
  deps: ExternalAuthDeps,
): Promise<void> {
  usage.latencyMs = Date.now() - start;
  usage.status = status;
  try {
    await deps.recordUsage(usage);
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, '写 API 用量采样失败');
  }
}

/**
 * 对外调用类端点守卫：鉴权 + scope + quota + rpm 限流 + 用量采样。
 * 需在 handler 之前挂载：`.post('/chat', requireExternalApi({...}), handler)`。
 *
 * 双通道语义（站内管理面板与外部第三方调用共用同一端点）：
 *  - 携带有效 Bearer API Key → 走完整外部校验（密钥校验/scope/quota/rpm/用量采样）；
 *  - 未携带凭据            → 视为站内（console）请求直接放行：不作 Key 校验、不限流、不计量。
 *    这使管理面板的「运行测试/对话测试/检索测试」等站内功能可正常使用，
 *    同时保留第三方调用所需的完整鉴权与限流（不降低对外开放接口的安全性）。
 */
export function requireExternalApi(opts: ExternalRouteOptions): MiddlewareHandler<AppEnv> {
  const deps: ExternalAuthDeps = {
    resolveKey: opts.deps?.resolveKey ?? defaultDeps.resolveKey,
    recordUsage: opts.deps?.recordUsage ?? defaultDeps.recordUsage,
    countUsage: opts.deps?.countUsage ?? defaultDeps.countUsage,
    rateLimiter: opts.deps?.rateLimiter,
    redisDegraded: opts.deps?.redisDegraded ?? isRedisDegraded(),
  };

  return createMiddleware<AppEnv>(async (c, next) => {
    const raw = bearerToken(c);
    if (!raw) {
      // 站内通道：无凭据即视为管理面板/顶层调用，直接放行。
      c.set('auth', { authenticated: false, kind: 'console' });
      return next();
    }

    const key = await deps.resolveKey(raw);
    if (!key) throw new UnauthorizedError('API Key 无效');
    if (key.status !== 'active') throw new UnauthorizedError('API Key 已停用');
    if (key.expiresAt && key.expiresAt.getTime() <= Date.now()) {
      throw new UnauthorizedError('API Key 已过期');
    }

    const { agentId, workflowId, datasetIds, requestContent } = await resolveScopeTarget(c, opts);
    checkScope(key.scope, { agentId, datasetIds });

    // 资源绑定校验：绑定单一资源（agent/workflow）的 key 只能调用「同类型且同 id」的资源，
    // 防止 agent 专属 key 越权调用 workflow（或反之），也防止调用同类型下的其他资源。
    if (key.resourceType && key.resourceId) {
      if (key.resourceType === 'agent') {
        if (!agentId) throw new ForbiddenError('Agent 专属 Key 仅能调用 Agent 对话接口');
        if (agentId !== key.resourceId) throw new ForbiddenError('API Key 无权访问该 Agent');
      } else if (key.resourceType === 'workflow') {
        if (!workflowId) throw new ForbiddenError('工作流专属 Key 仅能调用工作流运行接口');
        if (workflowId !== key.resourceId) throw new ForbiddenError('API Key 无权访问该工作流');
      }
    }

    // 累计配额（DB 计数，与用量采样本同源，Redis 故障仍准确）
    if (key.quota != null) {
      const used = await deps.countUsage(key.id);
      if (used >= key.quota) throw new QuotaExceededError();
    }

    // rpm 滑动窗口限流（Redis；降级时 fail-open）
    if (key.rpm != null && key.rpm > 0) {
      if (deps.redisDegraded) {
        const reset = Date.now() + DEFAULT_WINDOW_MS;
        writeRateHeaders(c, { limit: key.rpm, remaining: key.rpm, reset });
      } else {
        const limiter = deps.rateLimiter ?? (await getRateLimiter());
        const result = await limiter.check(rateLimitBucket(key.id, opts.route), key.rpm, DEFAULT_WINDOW_MS);
        writeRateHeaders(c, result);
        if (!result.allowed) throw new TooManyRequestsError();
      }
    }

    c.set('auth', { authenticated: true, kind: 'api', apiKeyId: key.id });
    const usage: UsageRecord = {
      apikeyId: key.id,
      route: opts.route,
      agentId: agentId ?? null,
      workflowId: workflowId ?? null,
      requestContent: requestContent ?? null,
    };
    c.set('usage', usage);

    const start = Date.now();
    let status: number;
    try {
      await next();
      status = c.res?.status ?? 200;
    } catch (err) {
      status = err instanceof AppError ? err.statusCode : 500;
      await flushUsage(start, status, usage, deps);
      throw err;
    }
    await flushUsage(start, status, usage, deps);
  });
}

/**
 * 可选的管理类路由保护（ENABLE_API_KEY_FOR_MANAGEMENT=true 时在 /api/v1 顶层挂载）。
 * 仅做轻量 key 校验（有效性 + 状态 + 过期），不施加 scope / 限流 / 用量。
 */
export function requireManagementApiKey(
  deps?: Pick<ExternalAuthDeps, 'resolveKey'>,
): MiddlewareHandler<AppEnv> {
  const resolveKey = deps?.resolveKey ?? defaultDeps.resolveKey;
  return createMiddleware<AppEnv>(async (c, next) => {
    const raw = bearerToken(c);
    if (!raw) throw new UnauthorizedError('缺少 API Key');
    const key = await resolveKey(raw);
    if (!key || key.status !== 'active') throw new UnauthorizedError('API Key 无效或已停用');
    if (key.expiresAt && key.expiresAt.getTime() <= Date.now()) {
      throw new UnauthorizedError('API Key 已过期');
    }
    c.set('auth', { authenticated: true, kind: 'api', apiKeyId: key.id });
    await next();
  });
}

/** 供对外 handler 补充用量信息（如一次性调用的 token 数） */
export function reportUsage(c: Context<AppEnv>, patch: Partial<UsageRecord>): void {
  const usage = c.get('usage');
  if (usage) Object.assign(usage, patch);
}
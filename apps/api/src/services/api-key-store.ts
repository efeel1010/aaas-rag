/**
 * API Key 存储服务 —— api_keys CRUD / 对外鉴权解析 / api_usage 用量采样与聚合。
 *
 * 安全边界：
 *  - create 时生成明文并仅返回一次（key），落库仅存 SHA-256 哈希 + 混淆 prefix；
 *  - resolveByRaw 仅用于对外鉴权中间件（内存中比对，不落明文）；
 *  - recordUsage / usageSummary 服务于配额统计与用量聚合查询。
 */
import { and, count, desc, eq, sql } from 'drizzle-orm';
import { apiKeys, apiUsage } from '@pulse/db';
import type {
  ApiCallLog,
  ApiKeyResourceType,
  ApiKeyScope,
  ApiKeyStatus,
  ApiKeyUsageSummary,
  ApiKeyView,
  CreateApiKeyInput,
} from '@pulse/contracts';
import { getDb } from '../lib/db.js';
import { generateApiKey, hashApiKey } from '../lib/api-key.js';
import { NotFoundError } from '../lib/errors.js';
import type { UsageRecord } from '../middleware/auth.js';

type ApiKeyRow = typeof apiKeys.$inferSelect;

/** 对外鉴权所需的密钥运行时信息 */
export interface ResolvedApiKey {
  id: string;
  name: string;
  prefix: string | null;
  status: ApiKeyStatus;
  quota: number | null;
  rpm: number | null;
  scope: ApiKeyScope | null;
  /** 资源绑定类型（agent / workflow）；null = 应用级 key */
  resourceType: 'agent' | 'workflow' | null;
  resourceId: string | null;
  expiresAt: Date | null;
}

function toView(row: ApiKeyRow): ApiKeyView {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    status: row.status as ApiKeyStatus,
    quota: row.quota,
    rpm: row.rpm,
    scope: row.scope,
    resourceType: (row.resourceType as 'agent' | 'workflow' | null) ?? null,
    resourceId: row.resourceId,
    lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
    expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}

function toResolved(row: ApiKeyRow): ResolvedApiKey {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    status: row.status as ApiKeyStatus,
    quota: row.quota,
    rpm: row.rpm,
    scope: row.scope,
    resourceType: (row.resourceType as 'agent' | 'workflow' | null) ?? null,
    resourceId: row.resourceId,
    expiresAt: row.expiresAt,
  };
}

export const apiKeyStore = {
  async list(): Promise<ApiKeyView[]> {
    const rows = await getDb().select().from(apiKeys).orderBy(sql`${apiKeys.createdAt} desc`);
    return rows.map(toView);
  },

  async get(id: string): Promise<ApiKeyView> {
    return toView(await this.findRow(id));
  },

  async create(input: CreateApiKeyInput): Promise<ApiKeyView & { key: string }> {
    const gen = generateApiKey();
    const inserted = await getDb()
      .insert(apiKeys)
      .values({
        name: input.name,
        key: gen.hashed,
        prefix: gen.prefix,
        status: 'active',
        quota: input.quota ?? null,
        rpm: input.rpm ?? null,
        scope: input.scope ?? null,
        expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
      })
      .returning();
    const row = inserted[0];
    if (!row) throw new Error('创建 API Key 失败');
    return { ...toView(row), key: gen.raw };
  },

  async setStatus(id: string, status: ApiKeyStatus): Promise<ApiKeyView> {
    await this.findRow(id);
    const updated = await getDb()
      .update(apiKeys)
      .set({ status })
      .where(eq(apiKeys.id, id))
      .returning();
    const row = updated[0];
    if (!row) throw new Error('更新 API Key 状态失败');
    return toView(row);
  },

  async remove(id: string): Promise<{ id: string }> {
    await this.findRow(id);
    await getDb().delete(apiKeys).where(eq(apiKeys.id, id));
    return { id };
  },

  // ---------------------------------------------------------------------
  // 资源级 token（每个智能体 / 工作流一个独立 token）
  // ---------------------------------------------------------------------

  /** 查询某资源已绑定的 token（仅混淆位，绝不返回明文） */
  async findByResource(
    resourceType: ApiKeyResourceType,
    resourceId: string,
  ): Promise<{ id: string; prefix: string | null; createdAt: Date } | null> {
    const rows = await getDb()
      .select()
      .from(apiKeys)
      .where(and(eq(apiKeys.resourceType, resourceType), eq(apiKeys.resourceId, resourceId)))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return { id: row.id, prefix: row.prefix, createdAt: row.createdAt };
  },

  /**
   * 幂等新建：若该资源已存在 token 则直接返回既有信息（key=null）；
   * 否则新建并仅此一次返回明文 key。
   */
  async ensureForResource(
    resourceType: ApiKeyResourceType,
    resourceId: string,
    name: string,
  ): Promise<{ key: string | null; prefix: string | null; createdAt: Date }> {
    const existing = await this.findByResource(resourceType, resourceId);
    if (existing) {
      return { key: null, prefix: existing.prefix, createdAt: existing.createdAt };
    }
    const gen = generateApiKey();
    const inserted = await getDb()
      .insert(apiKeys)
      .values({
        name,
        key: gen.hashed,
        prefix: gen.prefix,
        status: 'active',
        resourceType,
        resourceId,
      })
      .returning();
    const row = inserted[0];
    if (!row) throw new Error('创建资源 API Token 失败');
    return { key: gen.raw, prefix: gen.prefix, createdAt: row.createdAt };
  },

  /** 轮换 token：生成新密钥替换旧值（不存在则新建），返回新明文；旧 key 立即失效 */
  async rotateForResource(
    resourceType: ApiKeyResourceType,
    resourceId: string,
    name: string,
  ): Promise<{ key: string; prefix: string; createdAt: Date }> {
    const gen = generateApiKey();
    const existing = await this.findByResource(resourceType, resourceId);
    if (existing) {
      const updated = await getDb()
        .update(apiKeys)
        .set({ key: gen.hashed, prefix: gen.prefix, lastUsedAt: null, expiresAt: null })
        .where(eq(apiKeys.id, existing.id))
        .returning();
      const row = updated[0];
      if (!row) throw new Error('轮换资源 API Token 失败');
      return { key: gen.raw, prefix: gen.prefix, createdAt: row.createdAt };
    }
    const inserted = await getDb()
      .insert(apiKeys)
      .values({
        name,
        key: gen.hashed,
        prefix: gen.prefix,
        status: 'active',
        resourceType,
        resourceId,
      })
      .returning();
    const row = inserted[0];
    if (!row) throw new Error('创建资源 API Token 失败');
    return { key: gen.raw, prefix: gen.prefix, createdAt: row.createdAt };
  },

  /**
   * 对外鉴权解析：以传入明文的 SHA-256 哈希精确匹配；未命中返回 null（用于失败信封 401）。
   * 仅返回运行时信息，绝不返回明文。
   */
  async resolveByRaw(raw: string): Promise<ResolvedApiKey | null> {
    const hashed = hashApiKey(raw);
    const rows = await getDb()
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.key, hashed))
      .limit(1);
    const row = rows[0];
    return row ? toResolved(row) : null;
  },

  /** 花费用量采样落库（对外调用每次一条；缺失字段置 null） */
  async recordUsage(rec: UsageRecord): Promise<void> {
    if (!rec.apikeyId) return;
    await getDb().insert(apiUsage).values({
      apikeyId: rec.apikeyId,
      route: rec.route,
      agentId: rec.agentId ?? null,
      workflowId: rec.workflowId ?? null,
      requestContent: rec.requestContent ?? null,
      responseContent: rec.responseContent ?? null,
      tokens: rec.tokens ?? null,
      latencyMs: rec.latencyMs ?? null,
      status: rec.status ?? 200,
    });
  },

  /** 累计已用请求数（用于 quota 校验） */
  async usageCount(apikeyId: string): Promise<number> {
    const rows = await getDb()
      .select({ c: count() })
      .from(apiUsage)
      .where(eq(apiUsage.apikeyId, apikeyId));
    return rows[0]?.c ?? 0;
  },

  /** 用量聚合：按日 + 按 endpoint 两组 */
  async usageSummary(apikeyId: string): Promise<ApiKeyUsageSummary> {
    const db = getDb();
    const dayExpr = sql<string>`to_char(${apiUsage.createdAt}, 'YYYY-MM-DD')`;
    const byDayRows = await db
      .select({
        date: dayExpr.as('date'),
        requests: count(),
        tokens: sql<number | null>`sum(${apiUsage.tokens})`,
      })
      .from(apiUsage)
      .where(eq(apiUsage.apikeyId, apikeyId))
      .groupBy(dayExpr)
      .orderBy(sql`${dayExpr} desc`)
      .limit(90);

    const byEndpointRows = await db
      .select({
        route: apiUsage.route,
        requests: count(),
        tokens: sql<number | null>`sum(${apiUsage.tokens})`,
        avgLatencyMs: sql<number | null>`avg(${apiUsage.latencyMs})`,
      })
      .from(apiUsage)
      .where(eq(apiUsage.apikeyId, apikeyId))
      .groupBy(apiUsage.route)
      .orderBy(sql`count(*) desc`);

    return {
      apiKeyId: apikeyId,
      byDay: byDayRows.map((r) => ({
        date: r.date,
        requests: Number(r.requests),
        tokens: r.tokens == null ? null : Number(r.tokens),
      })),
      byEndpoint: byEndpointRows.map((r) => ({
        route: r.route,
        requests: Number(r.requests),
        tokens: r.tokens == null ? null : Number(r.tokens),
        avgLatencyMs: r.avgLatencyMs == null ? null : Number(r.avgLatencyMs),
      })),
    };
  },

  /**
   * 资源级调用日志分页查询：
   *  - agent → 按 agentId 聚合；workflow → 按 workflowId 聚合；
   *  - 调用方取密钥名称（api_keys.name）+ 混淆前缀（prefix）。
   */
  async listResourceLogs(
    resourceType: ApiKeyResourceType,
    resourceId: string,
    opts: { page: number; pageSize: number },
  ): Promise<{ items: ApiCallLog[]; total: number; page: number; pageSize: number }> {
    const db = getDb();
    const where =
      resourceType === 'agent'
        ? eq(apiUsage.agentId, resourceId)
        : eq(apiUsage.workflowId, resourceId);

    const rows = await db
      .select({
        id: apiUsage.id,
        caller: apiKeys.name,
        callerPrefix: apiKeys.prefix,
        route: apiUsage.route,
        requestContent: apiUsage.requestContent,
        responseContent: apiUsage.responseContent,
        status: apiUsage.status,
        latencyMs: apiUsage.latencyMs,
        tokens: apiUsage.tokens,
        createdAt: apiUsage.createdAt,
      })
      .from(apiUsage)
      .innerJoin(apiKeys, eq(apiUsage.apikeyId, apiKeys.id))
      .where(where)
      .orderBy(desc(apiUsage.createdAt))
      .limit(opts.pageSize)
      .offset((opts.page - 1) * opts.pageSize);

    const totalRows = await db
      .select({ c: count() })
      .from(apiUsage)
      .where(where);
    const total = totalRows[0]?.c ?? 0;

    return {
      items: rows.map((r) => ({
        id: r.id,
        caller: r.caller,
        callerPrefix: r.callerPrefix,
        route: r.route,
        requestContent: r.requestContent,
        responseContent: r.responseContent,
        status: r.status,
        latencyMs: r.latencyMs,
        tokens: r.tokens,
        createdAt: r.createdAt.toISOString(),
      })),
      total: Number(total),
      page: opts.page,
      pageSize: opts.pageSize,
    };
  },

  async findRow(id: string): Promise<ApiKeyRow> {
    const rows = await getDb().select().from(apiKeys).where(eq(apiKeys.id, id)).limit(1);
    const row = rows[0];
    if (!row) throw new NotFoundError('API Key', id);
    return row;
  },
};
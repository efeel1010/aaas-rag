/**
 * 分享链接服务 —— share_links CRUD + 公开 token 解析。
 *
 * 与 API Key 安全约定一致：明文 token 仅创建时返回一次，落库只存 SHA-256 哈希；
 * resolveByRaw 仅用于公开分享端点（内存中比对，不落明文）。
 */
import { createHash, randomBytes } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import { shareLinks } from '@pulse/db';
import type { ApiKeyResourceType, ShareLinkView } from '@pulse/contracts';
import { getDb } from '../lib/db.js';
import { ForbiddenError, NotFoundError } from '../lib/errors.js';

type ShareLinkRow = typeof shareLinks.$inferSelect;

function hashShareToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

function generateShareToken(): { raw: string; hashed: string; prefix: string } {
  const raw = `sh_${randomBytes(24).toString('base64url')}`;
  const hashed = hashShareToken(raw);
  const prefix = `${raw.slice(0, 6)}…${hashed.slice(-4)}`;
  return { raw, hashed, prefix };
}

function toView(row: ShareLinkRow): ShareLinkView {
  return {
    id: row.id,
    resourceType: row.resourceType as ApiKeyResourceType,
    resourceId: row.resourceId,
    prefix: row.prefix,
    token: null,
    status: row.status as ShareLinkView['status'],
    expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
    lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}

export const shareLinkStore = {
  /** 创建分享链接（明文 token 仅本次返回） */
  async create(
    resourceType: ApiKeyResourceType,
    resourceId: string,
    opts: { name?: string; expiresAt?: string | null; rpm?: number | null } = {},
  ): Promise<ShareLinkView & { token: string }> {
    const gen = generateShareToken();
    const inserted = await getDb()
      .insert(shareLinks)
      .values({
        resourceType,
        resourceId,
        tokenHash: gen.hashed,
        prefix: gen.prefix,
        name: opts.name ?? null,
        expiresAt: opts.expiresAt ? new Date(opts.expiresAt) : null,
        rpm: opts.rpm ?? null,
      })
      .returning();
    const row = inserted[0];
    if (!row) throw new Error('创建分享链接失败');
    return { ...toView(row), token: gen.raw };
  },

  /** 列分享链接（按资源） */
  async listByResource(resourceType: ApiKeyResourceType, resourceId: string): Promise<ShareLinkView[]> {
    const rows = await getDb()
      .select()
      .from(shareLinks)
      .where(and(eq(shareLinks.resourceType, resourceType), eq(shareLinks.resourceId, resourceId)))
      .orderBy(desc(shareLinks.createdAt));
    return rows.map(toView);
  },

  /** 撤销（revoke） */
  async revoke(id: string): Promise<ShareLinkView> {
    const updated = await getDb()
      .update(shareLinks)
      .set({ status: 'revoked' })
      .where(eq(shareLinks.id, id))
      .returning();
    const row = updated[0];
    if (!row) throw new NotFoundError('分享链接', id);
    return toView(row);
  },

  /** 删除 */
  async remove(id: string): Promise<{ id: string }> {
    const rows = await getDb().delete(shareLinks).where(eq(shareLinks.id, id)).returning();
    if (!rows[0]) throw new NotFoundError('分享链接', id);
    return { id };
  },

  /**
   * 公开端点 token 解析（内存比对）：
   *  哈希命中且 active → 返回资源定位信息；
   *  过期/失效/不存在 → 抛错（403/404）。
   */
  async resolveByRaw(raw: string): Promise<{ id: string; resourceType: ApiKeyResourceType; resourceId: string }> {
    const hashed = hashShareToken(raw);
    const rows = await getDb()
      .select()
      .from(shareLinks)
      .where(eq(shareLinks.tokenHash, hashed))
      .limit(1);
    const row = rows[0];
    if (!row) throw new NotFoundError('分享链接', '(无效)');
    if (row.status !== 'active') throw new ForbiddenError('分享链接已停用');
    if (row.expiresAt && row.expiresAt.getTime() < Date.now()) throw new ForbiddenError('分享链接已过期');
    // 记录最近使用时间（不阻塞主流程）
    void getDb().update(shareLinks).set({ lastUsedAt: new Date() }).where(eq(shareLinks.id, row.id));
    return { id: row.id, resourceType: row.resourceType as ApiKeyResourceType, resourceId: row.resourceId };
  },
};
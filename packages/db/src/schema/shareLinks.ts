/**
 * share_links —— 智能体/工作流的「分享链接」（多渠道发布）。
 *
 * 与 api_keys（Bearer 凭据，机密）不同，分享链接 token 是公开可分享的：
 *  - 仅通过分享链接路径（/share/:token/...）访问对应资源的对话/运行；
 *  - token 明文在创建时返回一次，落库只存 SHA-256 哈希 + 混淆前缀；
 *  - 供「嵌入第三方网站 / 分享给终端用户」的无需登录调用场景使用。
 */
import { index, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

export const shareLinks = pgTable(
  'share_links',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** 资源类型：agent | workflow */
    resourceType: text('resource_type').notNull(),
    /** 资源 id */
    resourceId: uuid('resource_id').notNull(),
    /** token 的 SHA-256 哈希（不落明文） */
    tokenHash: text('token_hash').notNull(),
    /** 混淆展示前缀（如 sh_ab12...，仅前几位 + 尾段） */
    prefix: text('prefix'),
    name: text('name'),
    /** 状态：active | revoked */
    status: text('status').notNull().default('active'),
    /** 过期时间（null = 不过期） */
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    /** 每分钟请求上限（简单限流；null = 不限） */
    rpm: integer('rpm'),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('share_links_token_uq').on(table.tokenHash),
    index('share_links_resource_idx').on(table.resourceType, table.resourceId),
  ],
);
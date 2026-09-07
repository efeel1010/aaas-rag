/**
 * api_keys —— 应用级 API 密钥（M7 开放 API 网关）。
 *
 * 存储安全约定：
 *  - 密钥绝不明文落库，只存「前缀 + SHA-256 哈希」；
 *  - 明文密钥仅在创建时返回一次，服务端不可逆找回；
 *  - prefix 用于混淆展示（如 rk_ab12...，仅前 6 位 + 哈希尾 4 位）。
 */
import { index, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * 密钥可用范围（scope）：
 *  - '*' 表示全部；undefined / 缺省表示不限制；
 *  - 数组为白名单（agentId / datasetId）。
 */
export interface ApiKeyScope {
  /** 可访问的 Agent 白名单，'*' = 全部 */
  agents?: string[] | '*';
  /** 可访问的知识库白名单，'*' = 全部 */
  datasets?: string[] | '*';
}

export const apiKeys = pgTable(
  'api_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** console | workspace | app */
    type: text('type').notNull().default('app'),
    name: text('name').notNull(),
    /** 明文密钥的 SHA-256 十六进制哈希（sha256({prefix}:{secret})），绝不明文落库 */
    key: text('key').notNull(),
    /** 混淆展示位（含前缀与哈希尾段），便于 UI 展示，永不泄露密钥 */
    prefix: text('prefix'),
    status: text('status').notNull().default('active'),
    /** 累计请求配额（null=不限），达到后对外调用返回 429 QUOTA_EXCEEDED */
    quota: integer('quota'),
    /** 每分钟请求上限 rpm（null=不限），基于 Redis 滑动窗口计数 */
    rpm: integer('rpm'),
    /** 可用范围：agents / datasets 白名单，'*'=全部，null=不限制 */
    scope: jsonb('scope').$type<ApiKeyScope>(),
    /**
     * 资源绑定（M7 起每个智能体/工作流可生成独立 token）：
     *  - resourceType = 'agent' | 'workflow' 时，该 key 仅能调用对应 resourceId 这一资源；
     *  - 为 null 时表示应用级 key（不绑定单一资源）。
     */
    resourceType: text('resource_type'),
    resourceId: uuid('resource_id'),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('api_keys_key_uq').on(table.key),
    index('api_keys_type_idx').on(table.type),
    index('api_keys_resource_idx').on(table.resourceType, table.resourceId),
  ],
);
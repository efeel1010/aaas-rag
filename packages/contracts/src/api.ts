/**
 * M7 开放 API 网关契约 —— api-keys 管理 / 对外鉴权 / 用量聚合。
 *
 * 密钥安全约定：
 *  - 明文密钥仅在「创建」成功时通过 { key } 返回一次，服务端只存 SHA-256 哈希；
 *  - 任何 View（列表 / 详情 / 状态）都只暴露 prefix 混淆位，绝不返回明文；
 *  - scope 为可访问 agentId / datasetId 白名单，'*' 表示全部。
 */
import { z } from 'zod';

// ---------------------------------------------------------------------------
// 密钥状态与范围
// ---------------------------------------------------------------------------

export const apiKeyStatusSchema = z.enum(['active', 'disabled']);
export type ApiKeyStatus = z.infer<typeof apiKeyStatusSchema>;

/** 可用范围：白名单数组或 '*'（全部） */
export const apiKeyScopeSchema = z.object({
  agents: z.union([z.array(z.string().uuid()), z.literal('*')]).optional(),
  datasets: z.union([z.array(z.string().uuid()), z.literal('*')]).optional(),
});
export type ApiKeyScope = z.infer<typeof apiKeyScopeSchema>;

/** 资源绑定类型：每个智能体（agent）/ 工作流（workflow）可生成独立 token 供第三方调用 */
export const apiKeyResourceTypeSchema = z.enum(['agent', 'workflow']);
export type ApiKeyResourceType = z.infer<typeof apiKeyResourceTypeSchema>;

// ---------------------------------------------------------------------------
// 分享链接（多渠道发布，share_links 表）
// ---------------------------------------------------------------------------

/** 创建分享链接输入 */
export const createShareLinkInputSchema = z.object({
  /** 过期时间（ISO；null 不过期） */
  expiresAt: z.string().datetime({ offset: true }).nullish(),
  /** 每分钟请求上限（null 不限） */
  rpm: z.number().int().min(1).max(10000).nullish(),
});
export type CreateShareLinkInput = z.infer<typeof createShareLinkInputSchema>;

/** 分享链接视图（创建时明文 token 仅返回一次，此后只见 prefix） */
export const shareLinkViewSchema = z.object({
  id: z.string().uuid(),
  resourceType: apiKeyResourceTypeSchema,
  resourceId: z.string().uuid(),
  /** 混淆展示位（如 sh_ab12…34cd），创建时返回完整明文 token */
  prefix: z.string().nullable(),
  /** 明文 token：仅创建时返回一次，查询恒为 null */
  token: z.string().nullable(),
  status: z.enum(['active', 'revoked']),
  expiresAt: z.string().datetime({ offset: true }).nullable(),
  lastUsedAt: z.string().datetime({ offset: true }).nullable(),
  createdAt: z.string().datetime({ offset: true }),
});
export type ShareLinkView = z.infer<typeof shareLinkViewSchema>;

// ---------------------------------------------------------------------------
// Create / Update
// ---------------------------------------------------------------------------

export const createApiKeyInputSchema = z.object({
  name: z.string().trim().min(1).max(128),
  /** 过期时间（ISO8601），缺省永不过期 */
  expiresAt: z.string().datetime({ offset: true }).optional(),
  /** 累计请求配额（null=不限），达到后对外调用返回 429 QUOTA_EXCEEDED */
  quota: z.number().int().positive().nullable().optional(),
  /** 每分钟请求上限 rpm（null=不限），基于 Redis 滑动窗口计数 */
  rpm: z.number().int().positive().nullable().optional(),
  /** 可用范围：agents / datasets 白名单，'*'=全部，缺省不限制 */
  scope: apiKeyScopeSchema.optional(),
}).strict();
export type CreateApiKeyInput = z.infer<typeof createApiKeyInputSchema>;

/** 启停请求体：仅允许 active / disabled */
export const setApiKeyStatusInputSchema = z.object({ status: apiKeyStatusSchema }).strict();
export type SetApiKeyStatusInput = z.infer<typeof setApiKeyStatusInputSchema>;

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

/** 密钥视图：绝不返回明文，仅暴露 prefix 混淆位 */
export const apiKeyViewSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  prefix: z.string().nullable(),
  status: apiKeyStatusSchema,
  quota: z.number().int().nullable(),
  rpm: z.number().int().nullable(),
  scope: apiKeyScopeSchema.nullable(),
  /** 资源绑定（agent / workflow）；null 表示应用级 key */
  resourceType: apiKeyResourceTypeSchema.nullable(),
  resourceId: z.string().uuid().nullable(),
  lastUsedAt: z.string().datetime({ offset: true }).nullable(),
  expiresAt: z.string().datetime({ offset: true }).nullable(),
  createdAt: z.string().datetime({ offset: true }),
});
export type ApiKeyView = z.infer<typeof apiKeyViewSchema>;

/** 创建结果：在 View 基础上追加明文密钥（仅此一次返回） */
export const apiKeyCreatedSchema = apiKeyViewSchema.extend({
  key: z.string(),
});
export type ApiKeyCreated = z.infer<typeof apiKeyCreatedSchema>;

// ---------------------------------------------------------------------------
// 用量聚合（GET /api/v1/api-keys/:id/usage）
// ---------------------------------------------------------------------------

/** 按日聚合：date 为 YYYY-MM-DD（API 所在时区） */
export const apiKeyUsageByDaySchema = z.object({
  date: z.string(),
  requests: z.number().int().nonnegative(),
  tokens: z.number().int().nullable(),
});
export type ApiKeyUsageByDay = z.infer<typeof apiKeyUsageByDaySchema>;

/** 按 endpoint 聚合 */
export const apiKeyUsageByEndpointSchema = z.object({
  route: z.string(),
  requests: z.number().int().nonnegative(),
  tokens: z.number().int().nullable(),
  avgLatencyMs: z.number().nonnegative().nullable(),
});
export type ApiKeyUsageByEndpoint = z.infer<typeof apiKeyUsageByEndpointSchema>;

export const apiKeyUsageSummarySchema = z.object({
  apiKeyId: z.string().uuid(),
  byDay: z.array(apiKeyUsageByDaySchema),
  byEndpoint: z.array(apiKeyUsageByEndpointSchema),
});
export type ApiKeyUsageSummary = z.infer<typeof apiKeyUsageSummarySchema>;

// ---------------------------------------------------------------------------
// 资源级 API 访问（智能体 / 工作流独立 token）
// ---------------------------------------------------------------------------

/**
 * 资源级 API 访问视图：
 *  - GET  查询：enabled 表示是否已生成 token，prefix 为混淆展示位，key 恒为 null；
 *  - POST 新建：若已存在则返回既有 prefix 且 key=null，若不存在则生成并仅此一次返回 key 明文；
 *  - POST rotate：强制轮换，返回新 key 明文（旧 key 随即失效）。
 */
export const resourceApiAccessSchema = z.object({
  resourceType: apiKeyResourceTypeSchema,
  resourceId: z.string().uuid(),
  /** 是否已存在 token */
  enabled: z.boolean(),
  /** 混淆展示位（prefix），未生成时为 null */
  prefix: z.string().nullable(),
  /** 明文 token：仅「新建/轮换」返回一次，查询接口恒为 null */
  key: z.string().nullable(),
  createdAt: z.string().datetime({ offset: true }).nullable(),
});
export type ResourceApiAccess = z.infer<typeof resourceApiAccessSchema>;

// ---------------------------------------------------------------------------
// 资源级 API 调用日志（智能体 / 工作流详情页）
// ---------------------------------------------------------------------------

/** 单条 API 调用日志 */
export const apiCallLogSchema = z.object({
  id: z.string().uuid(),
  /** 调用方：API Key 名称（资源级 token 的标识名） */
  caller: z.string(),
  /** 调用方混淆前缀（令牌标识位，非明文） */
  callerPrefix: z.string().nullable(),
  /** 命中路由（如 /agents/:id/chat） */
  route: z.string(),
  /** 调用请求内容（问答中的「问」/ 工作流 inputs） */
  requestContent: z.string().nullable(),
  /** 调用响应内容（问答中的「答」/ 工作流 outputs），流式可为 null */
  responseContent: z.string().nullable(),
  /** HTTP 状态码（2xx=成功，4xx/5xx=失败） */
  status: z.number().int(),
  /** 调用耗时（ms） */
  latencyMs: z.number().int().nullable(),
  /** token 用量 */
  tokens: z.number().int().nullable(),
  createdAt: z.string().datetime({ offset: true }),
});
export type ApiCallLog = z.infer<typeof apiCallLogSchema>;

/** 资源级 API 调用日志分页列表 */
export const apiCallLogListSchema = z.object({
  items: z.array(apiCallLogSchema),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  pageSize: z.number().int().positive(),
});
export type ApiCallLogList = z.infer<typeof apiCallLogListSchema>;
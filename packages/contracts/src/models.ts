/**
 * M2 模型网关契约 —— providers / models / chat(流式 SSE) / embedding / ping。
 *
 * providers（提供方）与 models（模型）表已在 M1 地基中定义；本文件仅定义
 * 跨前后端 / API 边界共享的运行时 Zod schema 与类型推导。
 *
 * 凭据安全约定：
 *  - providers.credentials 落库前逐字段加密（字段级 AES-256-GCM，密钥来自 env）；
 *  - 对外返回的 provider 视图中的 credentials 一律脱敏（每个键值为 "******"）；
 *  - 真实密钥仅通过 `getProviderClient` 解密后在内存中使用，绝不外泄。
 */
import { z } from 'zod';

/** 提供方类型 */
export const providerTypeSchema = z.enum(['openai', 'openai_compatible', 'anthropic']);
export type ProviderTypeValue = z.infer<typeof providerTypeSchema>;

/** 模型类型（与 Dify 对齐） */
export const modelTypeSchema = z.enum(['llm', 'embedding', 'rerank']);
export type ModelTypeValue = z.infer<typeof modelTypeSchema>;

/** 启停状态 */
export const enabledStatusSchema = z.enum(['active', 'disabled']);
export type EnabledStatus = z.infer<typeof enabledStatusSchema>;

/** credentials 中允许的标量值类型 */
const credentialScalar = z.union([z.string(), z.number(), z.boolean()]);
export const credentialMapSchema = z.record(z.string(), credentialScalar);

/** 非敏感配置（如 baseURL），明文存储 */
const unknownRecord = z.record(z.string(), z.unknown());

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

export const createProviderInputSchema = z.object({
  type: providerTypeSchema,
  name: z.string().min(1).max(128),
  description: z.string().max(512).optional(),
  config: unknownRecord.optional(),
  credentials: credentialMapSchema.optional(),
  status: enabledStatusSchema.optional(),
});
export type CreateProviderInput = z.infer<typeof createProviderInputSchema>;

export const updateProviderInputSchema = createProviderInputSchema.partial();
export type UpdateProviderInput = z.infer<typeof updateProviderInputSchema>;

/** 对外返回的 Provider 视图：credentials 已逐字段脱敏 */
export const providerViewSchema = z.object({
  id: z.string().uuid(),
  type: providerTypeSchema,
  name: z.string(),
  description: z.string().nullable(),
  config: unknownRecord.nullable(),
  /** 脱敏视图：每个键都为 "******"，仅表达“已配置” */
  credentials: z.record(z.string(), z.string()).nullable(),
  /** 是否存在凭据（便于前端展示待配置状态） */
  hasCredentials: z.boolean(),
  status: enabledStatusSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ProviderView = z.infer<typeof providerViewSchema>;

export const providerPingResultSchema = z.object({
  providerId: z.string().uuid(),
  type: providerTypeSchema,
  ok: z.boolean(),
  latencyMs: z.number().nonnegative(),
  model: z.string().optional(),
  message: z.string().optional(),
});
export type ProviderPingResult = z.infer<typeof providerPingResultSchema>;

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

export const createModelInputSchema = z.object({
  providerId: z.string().uuid(),
  name: z.string().min(1).max(128),
  modelType: modelTypeSchema,
  config: unknownRecord.optional(),
  status: enabledStatusSchema.optional(),
});
export type CreateModelInput = z.infer<typeof createModelInputSchema>;

export const updateModelInputSchema = createModelInputSchema.partial();
export type UpdateModelInput = z.infer<typeof updateModelInputSchema>;

export const modelViewSchema = z.object({
  id: z.string().uuid(),
  providerId: z.string().uuid(),
  name: z.string(),
  modelType: modelTypeSchema,
  config: unknownRecord.nullable(),
  status: enabledStatusSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ModelView = z.infer<typeof modelViewSchema>;

// ---------------------------------------------------------------------------
// Chat（含流式 SSE）
// ---------------------------------------------------------------------------

export const chatMessageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant', 'tool']),
  content: z.string(),
});
export type ChatMessage = z.infer<typeof chatMessageSchema>;

/**
 * 聊天请求（M2 直连模型 / M4 Agent 编排双通道）：
 *  - 直连模型：modelId + messages（既有契约，行为不变）；
 *  - Agent 编排：agentId + messages（取最后一条 user 消息作为 query，模型由 Agent 绑定）。
 * 两个通道互斥：modelId 与 agentId 必须且只能提供其一。
 */
export const chatRequestSchema = z
  .object({
    modelId: z.string().uuid().optional(),
    messages: z.array(chatMessageSchema).min(1),
    temperature: z.number().min(0).max(2).optional(),
    maxTokens: z.number().int().positive().optional(),
    /** true 时走 SSE 流式，false 返回一次性 JSON */
    stream: z.boolean().default(false),
    /** M4：Agent 编排通道，携带即触发完整 Agent 流程 */
    agentId: z.string().uuid().optional(),
    /** M4：Agent 会话标识（配合 agentId 使用） */
    sessionId: z.string().trim().min(1).max(256).optional(),
  })
  .superRefine((v, ctx) => {
    const hasModel = v.modelId !== undefined;
    const hasAgent = v.agentId !== undefined;
    if (hasModel === hasAgent) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['modelId'],
        message: 'modelId 与 agentId 必须且只能提供其一',
      });
    }
  });
export type ChatRequest = z.infer<typeof chatRequestSchema>;

export const chatResultSchema = z.object({
  id: z.string().optional(),
  content: z.string(),
  model: z.string().optional(),
  usage: z
    .object({
      inputTokens: z.number().int().nonnegative(),
      outputTokens: z.number().int().nonnegative(),
    })
    .optional(),
});
export type ChatResult = z.infer<typeof chatResultSchema>;

/** 模型流式事件（归一化后的内部事件；路由层负责编码为 SSE） */
export const modelStreamEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('delta'), content: z.string() }),
  z.object({
    type: z.literal('usage'),
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    model: z.string().optional(),
  }),
  z.object({ type: z.literal('done'), id: z.string().optional() }),
  z.object({ type: z.literal('error'), code: z.string(), message: z.string() }),
]);
export type ModelStreamEvent = z.infer<typeof modelStreamEventSchema>;

/** SSE 传输层事件类型名 */
export const sseEventTypeSchema = z.enum(['delta', 'usage', 'done', 'error']);

// ---------------------------------------------------------------------------
// Embedding
// ---------------------------------------------------------------------------

export const embeddingRequestSchema = z.object({
  modelId: z.string().uuid(),
  input: z.union([z.string(), z.array(z.string()).min(1)]),
});
export type EmbeddingRequest = z.infer<typeof embeddingRequestSchema>;

export const embeddingResultSchema = z.object({
  model: z.string().optional(),
  /** 与 input 一一对应；单串 input 返回单元素数组 */
  embeddings: z.array(z.array(z.number())),
  dimensions: z.number().int().positive(),
});
export type EmbeddingResult = z.infer<typeof embeddingResultSchema>;

// ---------------------------------------------------------------------------
// Rerank（重排）
// ---------------------------------------------------------------------------

/**
 * Rerank 调用请求。走 openai_compatible provider 的 `/reranks` 兼容端点，
 * 请求体扁平：{ model, query, documents, top_n?, instruct? }。
 * query/documents 为纯文本，网关负责按 provider 配置补齐端点到 URL。
 */
export const rerankRequestSchema = z.object({
  query: z.string().trim().min(1).max(2048),
  documents: z.array(z.string().min(1)).min(1).max(100),
  /** 只返回相关性最高的 topN 个（缺省返回全部 documents） */
  topN: z.number().int().min(1).max(100).optional(),
  /** 指令式重排开关（qwen3-rerank 走 compatible-api 支持 instruct 参数） */
  instruct: z.boolean().optional(),
});
export type RerankRequest = z.infer<typeof rerankRequestSchema>;

/** 单条重排结果：index 为 documents 数组下标（0 基），relevanceScore 越高越相关 */
export const rerankScoreSchema = z.object({
  index: z.number().int().nonnegative(),
  relevanceScore: z.number(),
});
export type RerankScore = z.infer<typeof rerankScoreSchema>;

/**
 * Rerank 结果。qwen3-rerank 走 compatible-api 时响应扁平：
 *   { results: [{ index, relevance_score }], usage: { total_tokens } }
 * 网关负责把上游扁平字段归一化为本契约（relevance_score → relevanceScore、total_tokens → totalTokens）。
 */
export const rerankResultSchema = z.object({
  model: z.string().optional(),
  results: z.array(rerankScoreSchema).min(0),
  usage: z
    .object({
      totalTokens: z.number().int().nonnegative(),
    })
    .optional(),
});
export type RerankResult = z.infer<typeof rerankResultSchema>;
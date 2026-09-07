/** Hono 的应用上下文类型（变量绑定） */
import type { AuthContext, UsageRecord } from './middleware/auth.js';

export interface AppEnv {
  Variables: {
    /** 请求追踪 id */
    requestId: string;
    /** 请求开始时间戳（ms） */
    requestStart: number;
    /** 鉴权解析结果（全局 auth() 注入；对外端点由 requireExternalApi 补充 apiKeyId） */
    auth: AuthContext;
    /** 对外调用用量采样（requireExternalApi 在本周期内维护，响应后落库） */
    usage?: UsageRecord;
  };
  Bindings: Record<string, unknown>;
}
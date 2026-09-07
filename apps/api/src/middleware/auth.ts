import { createMiddleware } from 'hono/factory';
import type { AppEnv } from '../types.js';

/** 鉴权上下文（M7：全局只做解析注入，真实校验由对外鉴权中间件完成） */
export interface AuthContext {
  authenticated: boolean;
  /** none=无凭据 console=站内(管理) api=外部 API Key */
  kind: 'none' | 'console' | 'api';
  /** 已通过外部鉴权后的 API Key id（requireExternalApi 注入） */
  apiKeyId?: string;
  /** 本次请求的用量采样（对外调用由 requireExternalApi 维护） */
  usage?: UsageRecord;
}

/** 单次对外调用的用量采样（handler 内可补充 tokens，由中间件在响应后统一落库） */
export interface UsageRecord {
  apikeyId: string;
  route: string;
  agentId?: string | null;
  /** 关联工作流（工作流运行调用） */
  workflowId?: string | null;
  /** 调用请求内容（问答中的「问」/ 工作流 inputs） */
  requestContent?: string | null;
  /** 调用响应内容（问答中的「答」/ 工作流 outputs），流式可为 null */
  responseContent?: string | null;
  tokens?: number | null;
  latencyMs?: number | null;
  status?: number;
}

/**
 * 全局鉴权解析（不落库、不校验）：解析 Authorization: Bearer <token>，
 * 仅注入 authenticated / kind。真正的密钥校验、状态/过期/scope/限流/用量
 * 由对外调用端点上的 requireExternalApi() 完成。
 */
export const auth = () =>
  createMiddleware<AppEnv>(async (c, next) => {
    const header = c.req.header('Authorization');
    let ctx: AuthContext = { authenticated: false, kind: 'none' };
    if (header?.startsWith('Bearer ')) {
      const token = header.slice('Bearer '.length).trim();
      ctx = { authenticated: Boolean(token), kind: 'api' };
    }
    c.set('auth', ctx);
    await next();
  });
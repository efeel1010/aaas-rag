import { randomUUID } from 'node:crypto';
import { createMiddleware } from 'hono/factory';
import type { AppEnv } from '../types.js';

/** 请求 ID：生成 / 透传并注入响应头，用于日志关联与追踪 */
export const requestId = () =>
  createMiddleware<AppEnv>(async (c, next) => {
    const incoming = c.req.header('x-request-id');
    const id =
      incoming && incoming.length > 0 && incoming.length <= 128 ? incoming : randomUUID();
    c.set('requestId', id);
    c.header('x-request-id', id);
    await next();
  });
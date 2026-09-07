import { createMiddleware } from 'hono/factory';
import { logger } from '../lib/logger.js';
import type { AppEnv } from '../types.js';

/** 结构化访问日志：方法 / 路径 / 状态 / 耗时 / requestId */
export const logging = () =>
  createMiddleware<AppEnv>(async (c, next) => {
    const start = Date.now();
    await next();
    const durationMs = Date.now() - start;
    logger.info(
      {
        requestId: c.get('requestId'),
        method: c.req.method,
        path: c.req.path,
        status: c.res.status,
        durationMs,
      },
      'http request',
    );
  });
import { createMiddleware } from 'hono/factory';
import type { AppEnv } from '../types.js';

/** 基础安全响应头（Hono millor 中间件可后续替代） */
const DEFAULT_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
} as const;

export const securityHeaders = () =>
  createMiddleware<AppEnv>(async (c, next) => {
    for (const [k, v] of Object.entries(DEFAULT_HEADERS)) {
      c.header(k, v);
    }
    await next();
  });
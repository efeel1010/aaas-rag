import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { v1Routes } from './routes/v1.js';
import { onError, notFound } from './middleware/error-handler.js';
import { requestId } from './middleware/request-id.js';
import { logging } from './middleware/logging.js';
import { securityHeaders } from './middleware/security.js';
import { auth } from './middleware/auth.js';
import { requireManagementApiKey } from './middleware/api-gateway.js';
import { env } from './config/env.js';
import type { AppEnv } from './types.js';

/** 允许的来源：M1 阶段默认放行本地前端，生产部署时改为显式域名 */
const ALLOWED_ORIGINS = (process.env.CORS_ORIGIN ?? 'http://localhost:3002')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

export function createApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // 全局中间件（顺序：RequestID -> 安全头 -> CORS -> 鉴权 -> 访问日志）
  app.use('*', requestId());
  app.use('*', securityHeaders());
  app.use(
    '*',
    cors({
      origin: ALLOWED_ORIGINS,
      allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowHeaders: ['Content-Type', 'Authorization', 'X-Request-Id'],
      exposeHeaders: ['X-Request-Id'],
      maxAge: 600,
    }),
  );
  app.use('*', auth());
  // M7：可选地对「管理类」路由全量 Key 保护（ENABLE_API_KEY_FOR_MANAGEMENT=true 时开启）
  if (env.ENABLE_API_KEY_FOR_MANAGEMENT) {
    app.use('/api/v1', requireManagementApiKey());
  }
  app.use('*', logging());

  // 路由
  app.route('/api/v1', v1Routes);

  // 异常与 404
  app.notFound(notFound);
  app.onError(onError);

  return app;
}
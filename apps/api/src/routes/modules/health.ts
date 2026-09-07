import { Hono } from 'hono';
import { healthResultSchema, type HealthResult } from '@pulse/contracts';
import { ok } from '../../lib/http.js';
import type { AppEnv } from '../../types.js';

const SERVICE_NAME = 'pulse-rag-api';
const VERSION = '0.1.0';

/** GET /api/v1/health —— 存活探针 */
export const healthRoutes = new Hono<AppEnv>().get('/health', (c) => {
  const payload: HealthResult = {
    status: 'up',
    service: SERVICE_NAME,
    version: VERSION,
    uptimeSec: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
  };
  // 运行时 schema 校验，保证契约一致
  const result = healthResultSchema.parse(payload);
  return c.json(ok(result));
});
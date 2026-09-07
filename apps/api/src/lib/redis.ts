/**
 * Redis 客户端单例（ioredis）—— M7 开放 API 网关限流。
 *
 * 降级策略（关键）：
 *  - 连接失败 / 命令超时 / 运行期连接异常 → 标记 degraded；
 *  - 调用方据此 fail-open（放行 + x-ratelimit 头降级标注 + 降级日志），
 *    保证 Redis 未启 / 故障时对外 API 业务不中断（仅 rpm 限流失效，
 *    鉴权 / 配额 / 用量采样仍走 PostgreSQL 完全可用）。
 */
import Redis from 'ioredis';
import { env } from '../config/env.js';
import { logger } from './logger.js';

let client: Redis | null = null;
let degraded = false;
let connecting: Promise<Redis | null> | null = null;
let lastAttemptAt = 0;

export function isRedisDegraded(): boolean {
  return degraded;
}

/** 惰性建立连接并返回就绪客户端；不可用返回 null（已标记 degraded） */
export async function ensureRedis(): Promise<Redis | null> {
  if (client && client.status === 'ready') {
    return client;
  }
  // 已降级时在冷却期内不再反复尝试（避免每个请求都等一次连接超时）
  if (degraded && Date.now() - lastAttemptAt < env.REDIS_RETRY_INTERVAL_MS) {
    return null;
  }
  if (!connecting) connecting = establish();
  return connecting;
}

async function establish(): Promise<Redis | null> {
  lastAttemptAt = Date.now();
  if (env.NODE_ENV === 'test') {
    degraded = true;
    logger.warn('[redis] 测试环境跳过真实 Redis 连接 → 限流降级 fail-open');
    return null;
  }
  try {
    const inst = new Redis(env.REDIS_URL, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      enableReadyCheck: true,
      connectTimeout: env.REDIS_CONNECT_TIMEOUT_MS,
      retryStrategy: () => null, // 失败即放弃，交给上层降级，不无限重连
    });
    inst.on('error', (err) => {
      degraded = true;
      lastAttemptAt = Date.now();
      logger.warn({ err: err.message }, '[redis] 连接异常 → 限流降级 fail-open');
    });
    await inst.connect();
    await inst.ping();
    client = inst;
    degraded = false; // 成功后解除降级，恢复限流
    logger.info('[redis] connected，限流已启用');
    return inst;
  } catch (err) {
    degraded = true;
    lastAttemptAt = Date.now();
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      '[redis] 不可用 → 限流降级 fail-open',
    );
    return null;
  }
}
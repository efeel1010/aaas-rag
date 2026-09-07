/**
 * 基于 Redis 有序集合的滑动窗口限流器（M7 开放 API 网关）。
 * 原子性由 Lua 脚本保证（清理过期成员 + 计数 + 写入本次 + 设 TTL）。
 */
import type Redis from 'ioredis';
import { isRedisDegraded, ensureRedis } from './redis.js';

export interface RateLimitResult {
  allowed: boolean;
  /** 窗口内最大允许数；-1 = 不限 */
  limit: number;
  /** 本次调用后窗口剩余；-1 = 不限 */
  remaining: number;
  /** 当前窗口结束 epoch 毫秒 */
  reset: number;
}

export interface RateLimiter {
  check(bucket: string, max: number, windowMs: number): Promise<RateLimitResult>;
}

/** 原子滑动窗口：返回「本次加入前」窗口内计数，供上层判断是否超限 */
const SLIDING_WINDOW_LUA = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local min = now - window
redis.call('ZREMRANGEBYSCORE', key, '-inf', min)
local count = redis.call('ZCARD', key)
redis.call('ZADD', key, now, now .. ':' .. math.random())
redis.call('PEXPIRE', key, window)
return count
`;

export const DEFAULT_WINDOW_MS = 60_000;

function windowReset(now: number, windowMs: number): number {
  return now - (now % windowMs) + windowMs;
}

export class RedisSlidingWindowRateLimiter implements RateLimiter {
  constructor(private readonly redis: Redis) {}

  async check(bucket: string, max: number, windowMs: number): Promise<RateLimitResult> {
    if (!Number.isFinite(max) || max <= 0) return this.unlimited(max);
    const now = Date.now();
    const count = (await this.redis.eval(
      SLIDING_WINDOW_LUA,
      1,
      bucket,
      now,
      windowMs,
    )) as number;
    const reset = windowReset(now, windowMs);
    if (count >= max) {
      // 已满：本次拒绝，remaining = 0
      return { allowed: false, limit: max, remaining: 0, reset };
    }
    // 本次占用 1 个名额
    return { allowed: true, limit: max, remaining: Math.max(0, max - count - 1), reset };
  }

  private unlimited(_max: number): RateLimitResult {
    const now = Date.now();
    return {
      allowed: true,
      limit: -1,
      remaining: -1,
      reset: windowReset(now, DEFAULT_WINDOW_MS),
    };
  }
}

/** 降级限流器（fail-open）：Redis 不可用时放行并返回「不限」结果 */
export class UnboundedRateLimiter implements RateLimiter {
  async check(): Promise<RateLimitResult> {
    const now = Date.now();
    return { allowed: true, limit: -1, remaining: -1, reset: windowReset(now, DEFAULT_WINDOW_MS) };
  }
}

let unbounded: UnboundedRateLimiter | undefined;

/** 获取当前限流器：Redis 可用则 Redis 实现，否则降级为放行 */
export async function getRateLimiter(): Promise<RateLimiter> {
  if (isRedisDegraded()) {
    unbounded ??= new UnboundedRateLimiter();
    return unbounded;
  }
  const redis = await ensureRedis();
  if (!redis) return new UnboundedRateLimiter();
  return new RedisSlidingWindowRateLimiter(redis);
}
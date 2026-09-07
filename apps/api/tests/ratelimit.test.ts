/**
 * M7 API 网关 —— Redis 滑动窗口限流逻辑单测（mock Redis，不连真实实例）。
 */
import { describe, expect, it, vi } from 'vitest';
import {
  RedisSlidingWindowRateLimiter,
  UnboundedRateLimiter,
  type RateLimiter,
} from '../src/lib/ratelimit.js';

/** 模拟 Redis eval：返回窗口内「本次加入前」计数并自增（等价于抽象滑动窗口语义） */
function fakeRedis(initial: Record<string, number> = {}) {
  const counts: Record<string, number> = { ...initial };
  return {
    eval: vi.fn(async (_lua: string, _num: number, bucket: string, _now: string) => {
      const c = counts[bucket] ?? 0;
      counts[bucket] = c + 1;
      return c;
    }),
  };
}

async function drainRpm(limiter: RateLimiter, max: number, times: number) {
  const results: Awaited<ReturnType<RateLimiter['check']>>[] = [];
  for (let i = 0; i < times; i += 1) {
    results.push(
      await limiter.check(`rl:key1:/chat:60000`, max, 60_000),
    );
  }
  return results;
}

describe('RedisSlidingWindowRateLimiter', () => {
  it('窗口未满放行并给出剩余 / reset', async () => {
    const limiter = new RedisSlidingWindowRateLimiter(fakeRedis() as never);
    const r = await limiter.check('k', 5, 60_000);
    expect(r.allowed).toBe(true);
    expect(r.limit).toBe(5);
    expect(r.remaining).toBe(4);
    expect(r.reset).toBeGreaterThan(Date.now());
  });

  it('rpm=2 时第 3 次被拒绝（滑动窗口满）', async () => {
    const limiter = new RedisSlidingWindowRateLimiter(fakeRedis() as never);
    const results = await drainRpm(limiter, 2, 3);
    expect(results[0]?.allowed).toBe(true);
    expect(results[0]?.remaining).toBe(1);
    expect(results[1]).toMatchObject({ allowed: true, remaining: 0 });
    expect(results[2]).toMatchObject({ allowed: false, limit: 2, remaining: 0 });
  });

  it('max 非正数视为不限（放行 + limit=-1）', async () => {
    const limiter = new RedisSlidingWindowRateLimiter(fakeRedis() as never);
    const r = await limiter.check('k', 0, 60_000);
    expect(r.allowed).toBe(true);
    expect(r.limit).toBe(-1);
    expect(r.remaining).toBe(-1);
  });

  it('不同 bucket 互相独立', async () => {
    const redis = fakeRedis();
    const limiter = new RedisSlidingWindowRateLimiter(redis as never);
    await limiter.check('a', 1, 60_000);
    await limiter.check('a', 1, 60_000); // a 已满
    const b = await limiter.check('b', 1, 60_000); // b 独立
    expect(b.allowed).toBe(true);
    // eval(script, numKeys, bucket, now, windowMs)
    expect(redis.eval).toHaveBeenCalledWith(
      expect.any(String),
      1,
      'a',
      expect.any(Number),
      expect.any(Number),
    );
  });
});

describe('UnboundedRateLimiter（降级 fail-open）', () => {
  it('恒放行且 limit=-1', async () => {
    const limiter = new UnboundedRateLimiter();
    const r = await limiter.check('any', 10, 60_000);
    expect(r).toMatchObject({ allowed: true, limit: -1, remaining: -1 });
  });
});
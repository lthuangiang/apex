import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { RedisRateLimitStore } from "../rate-limit/redis-store";

// Chạy khi có REDIS_URL (ví dụ redis trong docker compose). Không có thì bỏ qua.
const url = process.env.REDIS_URL;

describe.skipIf(url === undefined)("RedisRateLimitStore (integration)", () => {
  let redis: Redis;
  const prefix = `rl-test:${String(process.pid)}:${String(Date.now())}:`;
  const spec = { capacity: 5, refill: 5, intervalMs: 60_000 };

  beforeAll(() => {
    redis = new Redis(url ?? "", { lazyConnect: false, maxRetriesPerRequest: 1 });
  });
  afterAll(async () => {
    const keys = await redis.keys(`${prefix}*`);
    if (keys.length > 0) await redis.del(...keys);
    await redis.quit();
  });

  it("allows up to capacity, then reports retryAfterMs", async () => {
    const store = new RedisRateLimitStore(redis, prefix);
    expect((await store.take("a", spec, 3)).allowed).toBe(true);
    expect((await store.take("a", spec, 2)).allowed).toBe(true);
    const denied = await store.take("a", spec, 1);
    expect(denied.allowed).toBe(false);
    // 1 token nạp lại sau 12 s (5 token / 60 s).
    expect(denied.retryAfterMs).toBeGreaterThan(11_000);
    expect(denied.retryAfterMs).toBeLessThanOrEqual(12_000);
  });

  it("is atomic across concurrent callers", async () => {
    const store = new RedisRateLimitStore(redis, prefix);
    const results = await Promise.all(Array.from({ length: 20 }, () => store.take("b", spec, 1)));
    expect(results.filter((r) => r.allowed)).toHaveLength(5);
  });

  it("keeps buckets separate per key and sets a TTL", async () => {
    const store = new RedisRateLimitStore(redis, prefix);
    await store.take("c", spec, 5);
    expect((await store.take("d", spec, 5)).allowed).toBe(true);
    expect(await redis.pttl(`${prefix}c`)).toBeGreaterThan(0);
  });
});

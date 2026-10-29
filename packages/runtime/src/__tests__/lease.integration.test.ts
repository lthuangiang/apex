import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Lease } from "../lease";

// Chạy khi có REDIS_URL (cùng cách với test Redis của @drift/sodex).
const url = process.env.REDIS_URL;

describe.skipIf(url === undefined)("Lease (integration)", () => {
  let redis: Redis;
  const key = `lease-test:${String(Date.now())}`;
  beforeAll(() => {
    redis = new Redis(url ?? "");
  });
  afterAll(async () => {
    await redis.del(key);
    await redis.quit();
  });

  it("has a single holder, renews, and hands over after release", async () => {
    const a = new Lease(redis, key, 1000);
    const b = new Lease(redis, key, 1000);
    expect(await a.tick()).toBe(true);
    expect(await b.tick()).toBe(false);
    expect(await a.tick()).toBe(true);
    await a.release();
    expect(await b.tick()).toBe(true);
    // a không gia hạn được lease của b.
    expect(await a.tick()).toBe(false);
  });

  it("expires when the holder stops renewing", async () => {
    const k = `${key}:ttl`;
    const a = new Lease(redis, k, 200);
    const b = new Lease(redis, k, 200);
    await a.tick();
    await new Promise((r) => setTimeout(r, 350));
    expect(await b.tick()).toBe(true);
    await b.release();
  });
});

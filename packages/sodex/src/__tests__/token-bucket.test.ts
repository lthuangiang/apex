import { describe, expect, it } from "vitest";

import { initialBucket, MemoryRateLimitStore, takeTokens } from "../rate-limit/token-bucket";

// 1200 weight mỗi phút trên mỗi IP (docs/ARCHITECTURE.md mục 3.3.6).
const perMinute = { capacity: 1200, refill: 1200, intervalMs: 60_000 };

describe("token bucket", () => {
  it("allows up to capacity and then reports the wait time", () => {
    let state = initialBucket(perMinute, 0);
    const first = takeTokens(perMinute, state, 1200, 0);
    expect(first.allowed).toBe(true);
    state = first.state;

    const blocked = takeTokens(perMinute, state, 20, 0);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterMs).toBe(1000);
  });

  it("refills over time without exceeding capacity", () => {
    const empty = { tokens: 0, updatedAt: 0 };
    expect(takeTokens(perMinute, empty, 10, 500).allowed).toBe(true);
    const full = takeTokens(perMinute, empty, 1, 10 * 60_000);
    expect(full.state.tokens).toBe(1199);
  });

  it("rejects invalid costs", () => {
    const state = initialBucket(perMinute, 0);
    expect(() => takeTokens(perMinute, state, 0, 0)).toThrow(RangeError);
    expect(() => takeTokens(perMinute, state, 1.5, 0)).toThrow(RangeError);
    expect(() => takeTokens(perMinute, state, 1201, 0)).toThrow(RangeError);
  });

  it("keeps separate buckets per key", async () => {
    let now = 0;
    const store = new MemoryRateLimitStore(() => now);
    const orders = { capacity: 20, refill: 20, intervalMs: 1000 };
    for (let i = 0; i < 20; i++) {
      expect((await store.take("key:a", orders, 1)).allowed).toBe(true);
    }
    expect((await store.take("key:a", orders, 1)).allowed).toBe(false);
    expect((await store.take("key:b", orders, 1)).allowed).toBe(true);
    now = 50;
    expect((await store.take("key:a", orders, 1)).allowed).toBe(true);
  });
});

describe("reserve for background jobs", () => {
  it("keeps the reserved share for interactive requests", () => {
    const shared = { capacity: 100, refill: 100, intervalMs: 60_000 };
    const background = { ...shared, reserve: 30 };
    let state = initialBucket(shared, 0);
    // Job nền lấy tới khi chạm mức dự trữ 30.
    for (let i = 0; i < 7; i += 1) state = takeTokens(background, state, 10, 0).state;
    const blocked = takeTokens(background, state, 10, 0);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterMs).toBeGreaterThan(0);
    // Request tương tác vẫn dùng được phần dự trữ.
    expect(takeTokens(shared, state, 20, 0).allowed).toBe(true);
  });
});

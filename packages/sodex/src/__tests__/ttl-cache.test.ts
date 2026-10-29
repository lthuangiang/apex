import { describe, expect, it, vi } from "vitest";

import { TtlCache } from "../ttl-cache";

describe("TtlCache", () => {
  it("serves cached values until they expire", async () => {
    let now = 0;
    const cache = new TtlCache<string>(1000, () => now);
    const load = vi.fn().mockResolvedValueOnce("v1").mockResolvedValueOnce("v2");

    expect(await cache.get("btc", load)).toBe("v1");
    now = 999;
    expect(await cache.get("btc", load)).toBe("v1");
    now = 1000;
    expect(await cache.get("btc", load)).toBe("v2");
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("shares one in-flight load between concurrent callers", async () => {
    const cache = new TtlCache<number>(1000);
    const load = vi.fn(() => Promise.resolve(1));
    const results = await Promise.all([cache.get("k", load), cache.get("k", load)]);
    expect(results).toEqual([1, 1]);
    expect(load).toHaveBeenCalledOnce();
  });

  it("does not cache failures", async () => {
    const cache = new TtlCache<number>(1000);
    await expect(cache.get("k", () => Promise.reject(new Error("down")))).rejects.toThrow("down");
    expect(await cache.get("k", () => Promise.resolve(2))).toBe(2);
  });
});

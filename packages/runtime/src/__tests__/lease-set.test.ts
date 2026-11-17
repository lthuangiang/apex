import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Lease, LeaseSet, RENEW_MANY_SCRIPT, type LeaseLoss, type LeaseRedis } from "../lease";

// Redis giả trong bộ nhớ, hạn theo đồng hồ giả của vitest: đủ cho SET NX PX, gia hạn / trả bằng token và script gia hạn
// nhiều lease.
class FakeRedis implements LeaseRedis {
  readonly store = new Map<string, { value: string; expiresAt: number }>();
  evals = 0;
  fail: Error | null = null;

  #get(key: string): string | null {
    const e = this.store.get(key);
    if (e === undefined) return null;
    if (Date.now() >= e.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return e.value;
  }

  set(key: string, value: string, _px: "PX", ttl: number): Promise<string | null> {
    if (this.fail !== null) return Promise.reject(this.fail);
    if (this.#get(key) !== null) return Promise.resolve(null);
    this.store.set(key, { value, expiresAt: Date.now() + ttl });
    return Promise.resolve("OK");
  }

  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown> {
    this.evals += 1;
    if (this.fail !== null) return Promise.reject(this.fail);
    const keys = args.slice(0, numKeys).map(String);
    const argv = args.slice(numKeys).map(String);
    if (script === RENEW_MANY_SCRIPT) {
      if (argv[0] !== "")
        this.store.set(keys[0] ?? "", {
          value: argv[0] ?? "",
          expiresAt: Date.now() + Number(argv[1]),
        });
      const out: number[] = [];
      for (let i = 1; i < keys.length; i += 1) {
        const key = keys[i] ?? "";
        const ok = this.#get(key) === argv[2 * i];
        if (ok)
          this.store.set(key, {
            value: argv[2 * i] ?? "",
            expiresAt: Date.now() + Number(argv[2 * i + 1]),
          });
        out.push(ok ? 1 : 0);
      }
      return Promise.resolve(out);
    }
    const [key = ""] = keys;
    const [token] = argv;
    if (this.#get(key) !== token) return Promise.resolve(0);
    if (script.includes("PEXPIRE")) {
      this.store.set(key, { value: token, expiresAt: Date.now() + Number(argv[1]) });
      return Promise.resolve(1);
    }
    this.store.delete(key);
    return Promise.resolve(1);
  }
}

const TTL = 300;

describe("LeaseSet", () => {
  let redis: FakeRedis;
  let lost: [number, LeaseLoss][];
  let reacquired: number[];
  let verifyResult: boolean;
  let set: LeaseSet<number>;
  const make = () =>
    new LeaseSet<number>({
      redis,
      ttlMs: TTL,
      heartbeat: { key: "engine:worker:w1", value: () => "alive" },
      clock: () => Date.now(),
      verify: () => Promise.resolve(verifyResult),
      onLost: (id, reason) => {
        lost.push([id, reason]);
      },
      onReacquired: (id) => {
        reacquired.push(id);
      },
    });
  const acquire = async (id: number) => {
    const lease = new Lease(redis, `lease:shard:${String(id)}`, TTL);
    const at = Date.now();
    expect(await lease.tick()).toBe(true);
    set.add(id, lease, at);
    return lease;
  };

  beforeEach(() => {
    vi.useFakeTimers({ now: 1_000_000 });
    redis = new FakeRedis();
    lost = [];
    reacquired = [];
    verifyResult = true;
    set = make();
  });
  afterEach(() => {
    set.stop();
    vi.useRealTimers();
  });

  it("renews every lease and the heartbeat in one round trip every ttl / 3, independent of the caller", async () => {
    await acquire(1);
    await acquire(2);
    set.start();
    // Không ai gọi gì khác suốt 10 × ttl: timer tự gia hạn, lease không bao giờ hết.
    for (let i = 0; i < 30; i += 1) await vi.advanceTimersByTimeAsync(100);
    expect(redis.evals).toBe(30);
    expect(set.valid(1)).toBe(true);
    expect(set.valid(2)).toBe(true);
    expect(redis.store.get("lease:shard:1")).toBeDefined();
    expect(redis.store.get("engine:worker:w1")?.value).toBe("alive");
    expect(lost).toEqual([]);
  });

  it("stops being valid at last good renew + ttl − margin when renewing keeps failing", async () => {
    await acquire(1);
    set.start();
    await vi.advanceTimersByTimeAsync(100); // gia hạn được lúc t = 100
    const until = set.validUntil(1) ?? 0;
    expect(until).toBe(1_000_000 + 100 + TTL - TTL / 5);
    redis.fail = new Error("redis down");
    await vi.advanceTimersByTimeAsync(until - Date.now() - 1);
    expect(set.valid(1)).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(set.valid(1)).toBe(false);
    // Redis lỗi không có nghĩa là mất: chưa báo onLost, lease vẫn trong set.
    expect(lost).toEqual([]);
    expect(set.has(1)).toBe(true);
  });

  it("takes an expired lease back with the same token and keeps it when verify confirms", async () => {
    const lease = await acquire(1);
    redis.store.delete("lease:shard:1"); // hết hạn trên Redis (ví dụ timer bị trễ)
    await set.renew();
    expect(lost).toEqual([]);
    expect(reacquired).toEqual([1]);
    expect(set.valid(1)).toBe(true);
    expect(lease.held).toBe(true);
    expect(redis.store.get("lease:shard:1")?.value).toBe(lease.token);
  });

  it("reports the lease lost when another holder has it", async () => {
    await acquire(1);
    redis.store.set("lease:shard:1", { value: "other", expiresAt: Date.now() + TTL });
    await set.renew();
    expect(lost).toEqual([[1, "taken"]]);
    expect(set.has(1)).toBe(false);
    expect(redis.store.get("lease:shard:1")?.value).toBe("other");
  });

  it("gives the lease back and reports it lost when verify says someone else had it", async () => {
    await acquire(1);
    redis.store.delete("lease:shard:1");
    verifyResult = false;
    await set.renew();
    expect(lost).toEqual([[1, "epoch_moved"]]);
    expect(set.has(1)).toBe(false);
    expect(redis.store.has("lease:shard:1")).toBe(false);
  });

  it("shares one in-flight renew between callers", async () => {
    await acquire(1);
    await Promise.all([set.renew(), set.renew(), set.renew()]);
    expect(redis.evals).toBe(1);
  });

  it("gives up on a renew call that hangs, without extending validity", async () => {
    await acquire(1);
    const until = set.validUntil(1);
    const errors: unknown[] = [];
    const hanging = new LeaseSet<number>({
      redis: { set: () => new Promise(() => undefined), eval: () => new Promise(() => undefined) },
      ttlMs: TTL,
      clock: () => Date.now(),
      verify: () => Promise.resolve(true),
      onLost: () => undefined,
      onError: (e) => errors.push(e),
    });
    hanging.add(1, new Lease(redis, "lease:shard:1", TTL), Date.now());
    const done = hanging.renew();
    await vi.advanceTimersByTimeAsync(100); // timeoutMs mặc định = renewEveryMs = ttl / 3
    await done;
    expect(errors).toHaveLength(1);
    expect(hanging.validUntil(1)).toBe(until);
  });

  it("gives back a key it took back after the lease was removed (stop, rebalance) while it was waiting", async () => {
    const gate: { open: (() => void) | null } = { open: null };
    const slow = new (class extends FakeRedis {
      override set(key: string, value: string, px: "PX", ttl: number): Promise<string | null> {
        return new Promise((resolve) => {
          gate.open = () => {
            resolve(super.set(key, value, px, ttl));
          };
        });
      }
    })();
    redis = slow;
    set = make();
    const lease = new Lease(redis, "lease:shard:1", TTL);
    slow.store.set("lease:shard:1", { value: lease.token, expiresAt: Date.now() + TTL });
    set.add(1, lease, Date.now());
    slow.store.delete("lease:shard:1"); // hết hạn
    const done = set.renew();
    await vi.advanceTimersByTimeAsync(0);
    set.delete(1); // engine dừng / trả bớt shard trong lúc đang SET NX
    gate.open?.();
    await done;
    expect(slow.store.has("lease:shard:1")).toBe(false);
    expect(lost).toEqual([]);
  });
});

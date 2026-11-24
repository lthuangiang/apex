import type { Kline, Position } from "@drift/sodex";
import { describe, expect, it } from "vitest";

import {
  REALIZED_ALL_TTL_MS,
  REALIZED_TTL_MS,
  SPARK_TTL_MS,
  cachedRealized,
  cachedSpark,
  createOverviewCache,
} from "../src/modules/account/overview-cache";

const A = { id: "acct-a", address: "0x4E1e4796c10C637EDAB56461450BD8D02EFb29Db" };
const B = { id: "acct-b", address: "0x1111111111111111111111111111111111111111" };
const NOW = 1_800_000_000_000;

/** SoDEX giả: đếm lời gọi `positions/history`; mỗi địa chỉ một vị thế đóng với PnL riêng. */
function fakeHistory(pnlByAddress: Record<string, string>) {
  const calls: string[] = [];
  let fail = false;
  const rest = {
    getPositionsHistory: (address: string): Promise<Position[]> => {
      calls.push(address);
      if (fail) return Promise.reject(new Error("SoDEX down"));
      const pnl = pnlByAddress[address] ?? "0";
      return Promise.resolve([
        { id: 1, realizedPnL: pnl, updatedAt: NOW - 1_000 } as unknown as Position,
      ]);
    },
  };
  return {
    rest,
    calls,
    setFail: (v: boolean) => {
      fail = v;
    },
  };
}

function fakeKlines() {
  const calls: string[] = [];
  let fail = false;
  const rest = {
    getKlines: (engine: string, market: string): Promise<Kline[]> => {
      calls.push(`${engine}:${market}`);
      if (fail) return Promise.reject(new Error("SoDEX down"));
      // Mới nhất trước, như SoDEX.
      return Promise.resolve([
        { t: 2, o: "2", h: "2", l: "2", c: "2" } as unknown as Kline,
        { t: 1, o: "1", h: "1", l: "1", c: "1" } as unknown as Kline,
      ]);
    },
  };
  return {
    rest,
    calls,
    setFail: (v: boolean) => {
      fail = v;
    },
  };
}

describe("cachedRealized (#494)", () => {
  it("reuses the result within 60 s for a dated period and reads again after", async () => {
    const cache = createOverviewCache();
    const f = fakeHistory({ [A.address]: "5" });
    const first = await cachedRealized(cache, f.rest, A, 1, NOW);
    expect(first).toEqual({ since: NOW - 86_400_000, total: "5" });
    // Overview poll mỗi 15 s: 4 lần trong một phút chỉ một lời gọi.
    for (const dt of [15_000, 30_000, 45_000, REALIZED_TTL_MS - 1]) {
      expect(await cachedRealized(cache, f.rest, A, 1, NOW + dt)).toEqual(first);
    }
    expect(f.calls).toHaveLength(1);
    const later = await cachedRealized(cache, f.rest, A, 1, NOW + REALIZED_TTL_MS);
    expect(f.calls).toHaveLength(2);
    expect(later.since).toBe(NOW + REALIZED_TTL_MS - 86_400_000);
  });

  it("keeps All for 5 minutes, separately from dated periods", async () => {
    const cache = createOverviewCache();
    const f = fakeHistory({ [A.address]: "5" });
    expect(await cachedRealized(cache, f.rest, A, null, NOW)).toEqual({ since: 0, total: "5" });
    await cachedRealized(cache, f.rest, A, null, NOW + REALIZED_ALL_TTL_MS - 1);
    expect(f.calls).toHaveLength(1);
    // Period khác là khoá khác.
    await cachedRealized(cache, f.rest, A, 7, NOW + 1);
    expect(f.calls).toHaveLength(2);
    await cachedRealized(cache, f.rest, A, null, NOW + REALIZED_ALL_TTL_MS);
    expect(f.calls).toHaveLength(3);
  });

  it("never shares realized PnL between accounts", async () => {
    const cache = createOverviewCache();
    const f = fakeHistory({ [A.address]: "5", [B.address]: "-3" });
    expect((await cachedRealized(cache, f.rest, A, 1, NOW)).total).toBe("5");
    expect((await cachedRealized(cache, f.rest, B, 1, NOW)).total).toBe("-3");
    // Cùng id account nhưng địa chỉ khác (account kết nối lại) cũng là khoá khác.
    expect((await cachedRealized(cache, f.rest, { ...A, address: B.address }, 1, NOW)).total).toBe(
      "-3",
    );
    expect(f.calls).toHaveLength(3);
  });

  it("does not cache a failed read", async () => {
    const cache = createOverviewCache();
    const f = fakeHistory({ [A.address]: "5" });
    f.setFail(true);
    await expect(cachedRealized(cache, f.rest, A, 1, NOW)).rejects.toThrow("SoDEX down");
    f.setFail(false);
    expect((await cachedRealized(cache, f.rest, A, 1, NOW + 1)).total).toBe("5");
    expect(f.calls).toHaveLength(2);
  });
});

describe("cachedSpark (#494)", () => {
  it("shares one SoDEX read per market across users for 5 minutes, oldest candle first", async () => {
    const cache = createOverviewCache();
    const f = fakeKlines();
    const k = await cachedSpark(cache, f.rest, "perps", "BTC-USD", NOW);
    expect(k.map((c) => c.t)).toEqual([1, 2]);
    // Người dùng khác mở Overview cùng market: không gọi lại.
    await cachedSpark(cache, f.rest, "perps", "BTC-USD", NOW + SPARK_TTL_MS - 1);
    expect(f.calls).toEqual(["perps:BTC-USD"]);
    await cachedSpark(cache, f.rest, "perps", "ETH-USD", NOW);
    await cachedSpark(cache, f.rest, "spot", "BTC-USD", NOW);
    await cachedSpark(cache, f.rest, "perps", "BTC-USD", NOW + SPARK_TTL_MS);
    expect(f.calls).toEqual(["perps:BTC-USD", "perps:ETH-USD", "spot:BTC-USD", "perps:BTC-USD"]);
  });

  it("does not cache a failed read", async () => {
    const cache = createOverviewCache();
    const f = fakeKlines();
    f.setFail(true);
    await expect(cachedSpark(cache, f.rest, "perps", "BTC-USD", NOW)).rejects.toThrow();
    f.setFail(false);
    expect(await cachedSpark(cache, f.rest, "perps", "BTC-USD", NOW + 1)).toHaveLength(2);
    expect(f.calls).toHaveLength(2);
  });
});

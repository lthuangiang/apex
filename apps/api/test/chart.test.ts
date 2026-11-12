import { AppError, ErrorCode } from "@drift/shared";
import type { Kline } from "@drift/sodex";
import { describe, expect, it } from "vitest";

import { createChartService, type LiquidationProvider } from "../src/modules/chart/service";

// IMP-05 (DEC-91): nến SoDEX có cache; bản đồ thanh lý chỉ có khi đã cấu hình nhà cung cấp.
// Provider ở đây là provider giả, chỉ dùng trong test.

const k = (t: number, c: string): Kline => ({
  t,
  o: c,
  h: c,
  l: c,
  c,
  v: "1",
  q: c,
  n: 1,
});

function setup(liquidations: LiquidationProvider | null = null) {
  const clock = { now: 1_793_000_000_000 };
  const calls: string[] = [];
  let fail = false;
  const service = createChartService({
    rest: {
      getKlines: (engine, symbol, q) => {
        calls.push(`${engine}:${symbol}:${q.interval}`);
        // Mới nhất trước, có một dòng trùng thời điểm.
        return fail
          ? Promise.reject(new Error("down"))
          : Promise.resolve([k(3, "103"), k(2, "102"), k(2, "102"), k(1, "101")]);
      },
      getOrderbook: (engine, symbol, limit) => {
        calls.push(`book:${engine}:${symbol}:${String(limit)}`);
        const rows = (from: number, step: number): [string, string][] =>
          Array.from({ length: 12 }, (_, i) => [String(from + i * step), "0.5"]);
        return fail
          ? Promise.reject(new Error("down"))
          : Promise.resolve({ bids: rows(99, -1), asks: rows(101, 1) });
      },
    },
    liquidations,
    now: () => new Date(clock.now),
  });
  return {
    service,
    calls,
    clock,
    fail: () => {
      fail = true;
    },
  };
}

describe("chart candles", () => {
  it("returns SoDEX candles oldest first, without duplicates", async () => {
    const { service } = setup();
    const r = await service.candles("perps", "BTC-USD", "1h");
    expect(r.items.map((c) => c.t)).toEqual([1, 2, 3]);
    expect(r).toMatchObject({ market: "BTC-USD", interval: "1h" });
  });

  it("caches per market and timeframe until the TTL ends", async () => {
    const { service, calls, clock } = setup();
    await service.candles("perps", "BTC-USD", "1h");
    await service.candles("perps", "BTC-USD", "1h");
    await service.candles("perps", "BTC-USD", "15m");
    await service.candles("spot", "vBTC_vUSDC", "1h");
    expect(calls).toEqual(["perps:BTC-USD:1h", "perps:BTC-USD:15m", "spot:vBTC_vUSDC:1h"]);
    clock.now += 61_000;
    await service.candles("perps", "BTC-USD", "1h");
    expect(calls).toHaveLength(4);
  });

  it("maps a SoDEX failure to SODEX_UNAVAILABLE and does not cache it", async () => {
    const s = setup();
    s.fail();
    const err = await s.service.candles("perps", "BTC-USD", "4h").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe(ErrorCode.sodexUnavailable);
    await s.service.candles("perps", "BTC-USD", "4h").catch(() => undefined);
    expect(s.calls).toHaveLength(2);
  });
});

describe("order book (DEC-99)", () => {
  it("returns up to 10 perps levels per side, cached for one second", async () => {
    const { service, calls, clock } = setup();
    const r = await service.orderbook("BTC-USD");
    expect(r.bids).toHaveLength(10);
    expect(r.bids[0]).toEqual({ price: "99", size: "0.5" });
    expect(r.asks[0]).toEqual({ price: "101", size: "0.5" });
    expect(r).toMatchObject({ market: "BTC-USD", at: clock.now });
    await service.orderbook("BTC-USD");
    expect(calls).toEqual(["book:perps:BTC-USD:10"]);
    clock.now += 1_001;
    await service.orderbook("BTC-USD");
    expect(calls).toHaveLength(2);
  });

  it("maps a SoDEX failure to SODEX_UNAVAILABLE", async () => {
    const s = setup();
    s.fail();
    const err = await s.service.orderbook("ETH-USD").catch((e: unknown) => e);
    expect((err as AppError).code).toBe(ErrorCode.sodexUnavailable);
  });
});

describe("liquidation map", () => {
  it("is unavailable when no provider is configured", async () => {
    const { service } = setup(null);
    expect(await service.liquidations("BTC-USD", "1h")).toEqual({
      market: "BTC-USD",
      interval: "1h",
      available: false,
      source: null,
      updatedAt: null,
      bands: [],
    });
  });

  it("returns the provider's bands, cached, and hides markets without data", async () => {
    let calls = 0;
    const fake: LiquidationProvider = {
      name: "Test provider",
      get: (market) => {
        calls += 1;
        return Promise.resolve(
          market === "BTC-USD"
            ? { bands: [{ price: "95000", value: "1200000" }], updatedAt: 1_792_999_000_000 }
            : null,
        );
      },
    };
    const { service } = setup(fake);
    const btc = await service.liquidations("BTC-USD", "1h");
    expect(btc).toMatchObject({ available: true, source: "Test provider" });
    expect(btc.bands).toEqual([{ price: "95000", value: "1200000" }]);
    await service.liquidations("BTC-USD", "1h");
    expect(calls).toBe(1);
    expect((await service.liquidations("ETH-USD", "1h")).available).toBe(false);
  });

  it("treats a provider failure as no data", async () => {
    const { service } = setup({ name: "x", get: () => Promise.reject(new Error("down")) });
    expect((await service.liquidations("BTC-USD", "1d")).available).toBe(false);
  });
});

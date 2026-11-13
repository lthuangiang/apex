import { describe, expect, it } from "vitest";

import { sodexMarketSource } from "../src/modules/desk/market";

// Nguồn "Market today" (DEC-TBD-desk-market): cache 60 s theo market; SoDEX lỗi → không có nến / giá (không ghi 0).

const H = 3_600_000;
const kline = (t: number, o: string) => ({ t, o, h: o, l: o, c: o, v: "1", q: "1", n: 1 });

function stub(fail = false) {
  const calls = { klines: 0 };
  const rest = {
    getKlines: () => {
      calls.klines += 1;
      return fail
        ? Promise.reject(new Error("SoDEX down"))
        : Promise.resolve([kline(H, "101"), kline(0, "100")]);
    },
    getMarkPrices: () =>
      fail
        ? Promise.reject(new Error("SoDEX down"))
        : Promise.resolve([
            {
              symbol: "BTC-USD",
              markPrice: "102",
              indexPrice: "102",
              openInterest: "1",
              fundingRate: "0",
              nextFundingTime: 0,
            },
          ]),
    getPerpsSymbols: () =>
      fail
        ? Promise.reject(new Error("SoDEX down"))
        : Promise.resolve([{ name: "BTC-USD", quoteCoin: "USDC" }]),
    getSpotSymbols: () => Promise.resolve([]),
  };
  return { rest, calls };
}

describe("SoDEX market source", () => {
  it("reads candles, mark price and quote once per minute per market", async () => {
    const { rest, calls } = stub();
    const clock = { now: new Date("2026-11-13T10:00:00Z") };
    const src = sodexMarketSource({
      rest: rest as never,
      prices: () => Promise.resolve({}),
      now: () => clock.now,
    });
    const a = await src.read("perps", "BTC-USD");
    expect(a).toMatchObject({ price: "102", quote: "USDC" });
    expect(a.candles.map((c) => c.o)).toEqual(["101", "100"]);
    await src.read("perps", "BTC-USD");
    expect(calls.klines).toBe(1);
    clock.now = new Date(clock.now.getTime() + 61_000);
    await src.read("perps", "BTC-USD");
    expect(calls.klines).toBe(2);
  });

  it("returns nothing usable when SoDEX fails", async () => {
    const { rest } = stub(true);
    const src = sodexMarketSource({
      rest: rest as never,
      prices: () => Promise.resolve({}),
      now: () => new Date(),
    });
    expect(await src.read("perps", "BTC-USD")).toEqual({ candles: [], price: null, quote: null });
  });
});

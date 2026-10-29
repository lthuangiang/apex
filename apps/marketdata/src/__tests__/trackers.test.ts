import type { WsCandle, WsMarkPrice } from "@drift/sodex";
import { describe, expect, it } from "vitest";

import { CandleTracker, FundingTracker, marketSubject } from "../trackers";

const candle = (t: number, c: string, x = false): WsCandle => ({
  t,
  T: t + 1000,
  s: "BTC-USD",
  i: "1m",
  o: "1",
  h: "2",
  l: "1",
  c,
  v: "1",
  q: "1",
  n: 1,
  x,
});

describe("CandleTracker", () => {
  it("closes the previous minute when the next one starts", () => {
    const tr = new CandleTracker();
    expect(tr.push(candle(0, "10"))).toEqual([]);
    expect(tr.push(candle(0, "11"))).toEqual([]);
    expect(tr.push(candle(60_000, "12"))).toEqual([{ ...candle(0, "11"), x: true }]);
  });

  it("emits an explicitly closed candle once", () => {
    const tr = new CandleTracker();
    expect(tr.push(candle(0, "10", true))).toHaveLength(1);
    expect(tr.push(candle(0, "10", true))).toEqual([]);
    expect(tr.push(candle(60_000, "12"))).toEqual([]);
  });
});

describe("FundingTracker", () => {
  const mark = (E: number, T: number, r: string): WsMarkPrice => ({
    E,
    s: "BTC-USD",
    p: "1",
    i: "1",
    r,
    T,
  });

  it("records the last observed rate when the funding time rolls over", () => {
    const tr = new FundingTracker();
    expect(tr.push([mark(1, 100, "0.0001")])).toEqual([]);
    expect(tr.push([mark(50, 100, "0.0002")])).toEqual([]);
    expect(tr.push([mark(101, 200, "0.0003")])).toEqual([
      { market: "BTC-USD", fundingTime: 100, rate: "0.0002" },
    ]);
  });

  it("does not invent a rate for a period it never observed", () => {
    const tr = new FundingTracker();
    // Lần đầu thấy market sau khi kỳ 100 đã chốt.
    expect(tr.push([mark(150, 200, "0.0003")])).toEqual([]);
  });
});

describe("marketSubject", () => {
  it("builds lowercase dotted subjects", () => {
    expect(marketSubject("vBTC_vUSDC", "kline.1m")).toBe("md.vbtc-vusdc.kline.1m");
  });
});

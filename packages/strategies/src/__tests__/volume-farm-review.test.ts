import { describe, expect, it } from "vitest";

import type { Candle } from "../backtest/run";
import { buildTrades, reviewVolumeFarm, type ReviewFill } from "../volume-farm/review";
import { volumeFarmSchema } from "../volume-farm/schema";

const T0 = Date.parse("2026-11-01T00:00:00Z");
const fee = { maker: 0.00018, taker: 0.00043 };
const config = (over: Record<string, unknown> = {}) =>
  volumeFarmSchema.parse({
    market: "BTC-USD",
    leverage: 25,
    marginMode: "cross",
    orderSizeMinUsd: "100",
    orderSizeMaxUsd: "100",
    minHoldSecs: 180,
    maxHoldSecs: 300,
    maxLoss: "50",
    ...over,
  });

/** Lượt long 100 USDC vào ở `price`, ra cùng giá sau `holdS` giây, cả hai chiều maker. */
function trade(i: number, at: number, price: number, holdS = 200): ReviewFill[] {
  const size = 100 / price;
  const f = 100 * fee.maker;
  return [
    {
      tag: `vf:${String(i)}:in:0`,
      side: "buy",
      price,
      size,
      fee: f,
      builderFee: 0,
      isMaker: true,
      at,
    },
    {
      tag: `vf:${String(i)}:out:0`,
      side: "sell",
      price,
      size,
      fee: f,
      builderFee: 0,
      isMaker: true,
      at: at + holdS * 1000,
    },
  ];
}

describe("volume builder review (DEC-131)", () => {
  it("pairs entry and exit fills into trades, including a stop on SoDEX and partial exits", () => {
    const fills: ReviewFill[] = [
      ...trade(1, T0, 100),
      {
        tag: "vf:2:in:0",
        side: "sell",
        price: 101,
        size: 1,
        fee: 0.02,
        builderFee: 0.005,
        isMaker: true,
        at: T0 + 600_000,
      },
      {
        tag: "vf:2:out:0",
        side: "buy",
        price: 100,
        size: 0.4,
        fee: 0.01,
        builderFee: 0,
        isMaker: true,
        at: T0 + 700_000,
      },
      {
        tag: "vf:2:sl",
        side: "buy",
        price: 102,
        size: 0.6,
        fee: 0.03,
        builderFee: 0,
        isMaker: false,
        at: T0 + 710_000,
      },
      // Lượt chưa đóng: không tính.
      {
        tag: "vf:3:in:0",
        side: "buy",
        price: 100,
        size: 1,
        fee: 0.02,
        builderFee: 0,
        isMaker: true,
        at: T0 + 900_000,
      },
    ];
    const ts = buildTrades(fills);
    expect(ts).toHaveLength(2);
    const short = ts[1];
    expect(short?.long).toBe(false);
    // Bán 1 ở 101, mua lại 0.4 ở 100 và 0.6 ở 102: lãi giá 0.4 − 0.6 = −0.2.
    expect(short?.gross).toBeCloseTo(-0.2, 9);
    expect(short?.fees).toBeCloseTo(0.06, 9);
    expect(short?.allMaker).toBe(false);
  });

  it("needs at least one closed trade (DEC-134)", () => {
    // Lượt khớp lẻ dưới 5 USDC không tính.
    const tiny = trade(1, T0, 100).map((f) => ({ ...f, size: 0.03 }));
    expect(
      reviewVolumeFarm({ config: config(), fills: tiny, candles: [], fallbackFee: fee, seed: 1 }),
    ).toEqual({ status: "insufficient", trades: 0, minTrades: 1 });
  });

  /** `n` lượt long ở giá 100: phút sau khi vào chạm 100.3 rồi đóng lại ở giá vào. */
  function spikes(n: number) {
    const fills: ReviewFill[] = [];
    const candles: Candle[] = [];
    for (let i = 0; i < n; i += 1) {
      const m0 = Math.floor((T0 + i * 1_200_000) / 60_000) * 60_000;
      fills.push(...trade(i, m0 + 10_000, 100));
      for (let k = 0; k <= 16; k += 1)
        candles.push({
          t: m0 + k * 60_000,
          o: "100",
          h: k === 1 ? "100.3" : "100",
          l: "100",
          c: "100",
        });
    }
    return { fills, candles };
  }

  it("does not suggest from a handful of trades it cannot test on unseen trades (DEC-142)", () => {
    const { fills, candles } = spikes(10);
    const r = reviewVolumeFarm({
      config: config({ earlyProfitFees: "20" }),
      fills,
      candles,
      fallbackFee: fee,
      seed: 1,
    });
    expect(r.status).toBe("done");
    if (r.status !== "done") return;
    // Dưới 20 lượt không chia được 70 / 30 nên không kiểm được trên lượt chưa thấy: không đề xuất.
    expect(r.suggestion).toBe("none");
    expect(r.recommended).toBe(false);
  });

  it("recommends an earlier take-profit when every trade spikes up then falls back to entry", () => {
    const n = 300;
    const fills: ReviewFill[] = [];
    const candles: Candle[] = [];
    for (let i = 0; i < n; i += 1) {
      const m0 = Math.floor((T0 + i * 1_200_000) / 60_000) * 60_000;
      fills.push(...trade(i, m0 + 10_000, 100));
      // Phút sau khi vào: chạm 100.3 (0.3%, trên 3 × phí khứ hồi 0.108%), rồi đóng lại ở giá vào.
      for (let k = 0; k <= 16; k += 1) {
        const t = m0 + k * 60_000;
        const h = k === 1 ? "100.3" : "100";
        candles.push({ t, o: "100", h, l: "100", c: "100" });
      }
    }
    // Bộ hiện tại: early profit 20 × phí (0.72%) không bao giờ tới, lượt nào cũng ra ở giá vào và lỗ đúng phí.
    const r = reviewVolumeFarm({
      config: config({ earlyProfitFees: "20" }),
      fills,
      candles,
      fallbackFee: fee,
      seed: 1,
    });
    expect(r.status).toBe("done");
    if (r.status !== "done") return;
    expect(r.trades).toBe(n);
    expect(r.current.costPerMillion).toBeCloseTo(180, 0);
    expect(r.recommended).toBe(true);
    expect(r.suggestion).toBe("strong");
    expect(r.best.params.earlyProfitFees).toBeLessThan(20);
    expect(r.best.costPerMillion).toBeLessThan(0);
    expect(r.best.ciHigh).toBeLessThan(0);
    expect(r.tested).toBe(135);
  });

  it("does not recommend anything when no setting beats the current one on both halves", () => {
    const n = 240;
    const fills: ReviewFill[] = [];
    const candles: Candle[] = [];
    for (let i = 0; i < n; i += 1) {
      const m0 = Math.floor((T0 + i * 1_200_000) / 60_000) * 60_000;
      fills.push(...trade(i, m0 + 10_000, 100));
      for (let k = 0; k <= 16; k += 1)
        candles.push({ t: m0 + k * 60_000, o: "100", h: "100", l: "100", c: "100" });
    }
    const r = reviewVolumeFarm({ config: config(), fills, candles, fallbackFee: fee, seed: 1 });
    expect(r.status === "done" && r.suggestion).toBe("none");
  });
});

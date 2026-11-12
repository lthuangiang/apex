import { describe, expect, it } from "vitest";

import type { Candle } from "../backtest/run";
import {
  buildTrades,
  realFeeRates,
  replayOptions,
  reviewTrades,
  reviewVolumeFarm,
  type ReviewFill,
} from "../volume-farm/review";
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

describe("what-if replay of real entries (AI Desk B+, DEC-166)", () => {
  // Hai lượt long 100 USDC ở giá 100; phút sau giá rơi về 98 (−2%) rồi đứng yên.
  const fills = [...trade(1, T0, 100), ...trade(2, T0 + 10 * 60_000, 100)];
  const candles: Candle[] = Array.from({ length: 40 }, (_, k) => ({
    t: T0 + k * 60_000,
    o: "100",
    h: "100",
    l: "98",
    c: "98",
    v: "1",
  }));
  const base = { earlyProfitFees: 3, earlyExitSecs: 60, minHoldSecs: 180, maxHoldSecs: 300 };

  it("replays each option on the same entries and counts stop-loss exits, worst trade and margin", () => {
    const trades = reviewTrades(fills);
    const [wide, tight] = replayOptions({
      trades,
      candles,
      tpUsd: 0.5,
      fee,
      options: [
        // SL 100% margin ở 25× = 4% giá: không chạm, ra theo giờ giữ ở 98 (−2%).
        { params: { ...base, slMarginPct: 100 }, leverage: 25 },
        // SL 25% margin ở 25× = 1% giá: chạm stop.
        { params: { ...base, slMarginPct: 25 }, leverage: 25 },
      ],
    });
    expect(wide).toMatchObject({ trades: 2, slExits: 0, marginPerTrade: 4 });
    expect(tight).toMatchObject({ trades: 2, slExits: 2 });
    // Mỗi lượt: −1% giá − phí maker + taker trên 100 USDC.
    expect(tight?.worstTrade?.toFixed(4)).toBe((-(0.01 + fee.maker + fee.taker) * 100).toFixed(4));
    expect((tight?.net ?? 0) > (wide?.net ?? 0)).toBe(true);
  });

  it("gives the same result for the same data", () => {
    const run = () =>
      replayOptions({
        trades: reviewTrades(fills),
        candles,
        tpUsd: 0.5,
        fee,
        options: [{ params: { ...base, slMarginPct: 50 }, leverage: 10 }],
      });
    expect(run()).toEqual(run());
  });

  it("reports no trades instead of a zero result when there is nothing to replay", () => {
    const [o] = replayOptions({
      trades: [],
      candles,
      tpUsd: 0.5,
      fee,
      options: [{ params: { ...base, slMarginPct: 50 }, leverage: 10 }],
    });
    expect(o).toMatchObject({ trades: 0, worstTrade: null, marginPerTrade: null });
  });

  it("measures real fee rates per maker / taker side", () => {
    expect(realFeeRates(fills, { maker: 1, taker: 2 })).toEqual({ maker: fee.maker, taker: 2 });
  });
});

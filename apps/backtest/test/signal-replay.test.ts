import { Decimal } from "@drift/shared";
import { describe, expect, it } from "vitest";

import {
  COSTS_V1,
  inferTick,
  medianTicks,
  roundTripCostBp,
  spreadAt,
  spreadBpFromTicks,
} from "../src/signal-replay/costs";
import { evaluateFunding, emptyFundingFunnel, quantileSorted } from "../src/signal-replay/funding";
import { inWindow, pauseWindows } from "../src/signal-replay/macro-calendar";
import {
  enterAndWalk,
  holdCoverage,
  Series,
  typicalMove,
  walkPath,
  type Candle,
  type MarketContext,
} from "../src/signal-replay/market";
import { filterMm, filterVb, markOpening, type MmFill } from "../src/signal-replay/risk-filter";
import {
  attachRandom,
  gateOf,
  groupReport,
  periodStats,
  summarize,
  tradesNeeded,
} from "../src/signal-replay/stats";
import { emptyStructureFunnel, evaluateStructure } from "../src/signal-replay/structure";
import { blankTrade, type SignalTrade } from "../src/signal-replay/types";
import {
  emptyWhaleFunnel,
  evaluateWhales,
  snapshotAsOf,
  walletKey,
  type WalletSnapshot,
  type WhaleEvent,
} from "../src/signal-replay/whales";

// Replay tín hiệu A / B / C + D1 (#274): evaluator, chống survivorship, random baseline, chi phí, cổng. Dữ liệu tự dựng,
// tính tay được.

const d = (v: string) => new Decimal(v);
const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const T0 = Date.parse("2026-11-01T00:00:00Z");

/** Nến phẳng ở `price` mỗi phút từ `from` trong `minutes` phút; `at` sửa từng nến. */
function flat(
  from: number,
  minutes: number,
  price: string,
  at: (i: number, c: Candle) => Candle = (_i, c) => c,
): Candle[] {
  return Array.from({ length: minutes }, (_, i) =>
    at(i, {
      ts: from + i * MIN,
      open: d(price),
      high: d(price),
      low: d(price),
      close: d(price),
      volume: 1,
    }),
  );
}

/** Lịch sử giá theo giờ dao động đều ±`swing`% quanh 100 (biến động thường gặp xác định). */
function hourlyZigzag(end: number, hours: number, swingPct: string): Map<number, Decimal> {
  const out = new Map<number, Decimal>();
  for (let i = hours; i >= 0; i--) {
    const up = i % 2 === 0;
    out.set(end - i * HOUR, d("100").mul(up ? d("1").add(d(swingPct).div(100)) : d("1")));
  }
  return out;
}

/** Như `hourlyZigzag` nhưng chu kỳ 3 giờ, để mọi thời gian giữ (4 h, 8 h) đều có biến động khác 0. */
function hourlyWave(end: number, hours: number, swingPct: string): Map<number, Decimal> {
  const out = new Map<number, Decimal>();
  for (let i = hours; i >= 0; i--)
    out.set(end - i * HOUR, d("100").mul(i % 3 === 0 ? d("1").add(d(swingPct).div(100)) : d("1")));
  return out;
}

function ctxOf(candles: Candle[], hourly?: Map<number, Decimal>): MarketContext {
  const series = new Series("ETH-USD", candles);
  return { series, hourly: hourly ?? series.hourlyCloses(), spreadHours: [], tick: null };
}

describe("costs", () => {
  it("adds taker and builder fee on both legs plus one spread", () => {
    expect(COSTS_V1.takerBpPerLeg.toString()).toBe("4");
    expect(COSTS_V1.builderBpPerLeg.toString()).toBe("1");
    expect(roundTripCostBp(d("2")).toString()).toBe("12");
  });

  it("converts a measured spread in ticks to bp, and falls back to a flagged default", () => {
    expect(medianTicks({ "1": 10, "2": 3, "5": 1 })).toBe(1);
    expect(medianTicks({ "1": 1, "3": 5 })).toBe(3);
    expect(medianTicks({})).toBeNull();
    expect(spreadBpFromTicks(2, d("0.5"), d("1000")).toString()).toBe("10");
    const hours = [{ hour: T0 - HOUR, spreadTicks: { "2": 100 } }];
    expect(spreadAt("ETH-USD", T0, d("1000"), hours, d("0.5"))).toEqual({
      spreadBp: d("10"),
      source: "mm_market_hourly",
    });
    // Giờ sau lúc vào không được dùng (không nhìn tương lai); không có tick cũng về mặc định.
    expect(
      spreadAt("ETH-USD", T0, d("1000"), [{ hour: T0 + HOUR, spreadTicks: { "1": 9 } }], d("0.5"))
        .source,
    ).toBe("default");
    // Bucket của giờ đang chạy (gồm cả các giây sau lúc vào) không được dùng.
    expect(
      spreadAt(
        "ETH-USD",
        T0 + 30 * MIN,
        d("1000"),
        [{ hour: T0, spreadTicks: { "1": 9 } }],
        d("0.5"),
      ).source,
    ).toBe("default");
    expect(spreadAt("ETH-USD", T0, d("1000"), hours, null).spreadBp.toString()).toBe("3");
    expect(spreadAt("XYZ-USD", T0, d("1000"), [], null).spreadBp.toString()).toBe("10");
  });

  it("infers the tick from the candle price grid", () => {
    const prices = Array.from({ length: 30 }, (_, i) => d("100").add(d("0.05").mul(i * 2)));
    prices.push(d("100.05"));
    expect(inferTick(prices)?.toString()).toBe("0.05");
    expect(inferTick([d("1"), d("2")])).toBeNull();
  });
});

describe("price path", () => {
  it("measures the typical move only from hours before the entry", () => {
    const end = T0 + 10 * DAY;
    const hourly = hourlyZigzag(end, 10 * 24, "1");
    const v = typicalMove(hourly, end, HOUR);
    expect(v?.move.toDecimalPlaces(6).toString()).toBe("0.00995");
    // Thêm một cú nhảy SAU lúc vào: không đổi kết quả.
    hourly.set(end + HOUR, d("200"));
    expect(typicalMove(hourly, end, HOUR)?.move.toDecimalPlaces(6).toString()).toBe("0.00995");
    expect(typicalMove(hourlyZigzag(end, 24, "1"), end, HOUR)).toBeNull();
  });

  it("exits at TP, at SL (SL first when one candle touches both), or at max hold", () => {
    const candles = flat(T0, 120, "100", (i, c) =>
      i === 5 ? { ...c, high: d("102") } : i === 10 ? { ...c, low: d("98"), high: d("103") } : c,
    );
    const s = new Series("X", candles);
    const tp = walkPath(s, 0, "long", d("100"), d("101"), d("99"), T0, HOUR);
    expect(tp).toMatchObject({ reason: "take_profit", exit: d("101"), exitAt: T0 + 5 * MIN });
    const both = walkPath(s, 6, "long", d("100"), d("102.5"), d("99"), T0 + 6 * MIN, HOUR);
    expect(both).toMatchObject({ reason: "stop_loss", exit: d("99") });
    const hold = walkPath(s, 20, "short", d("100"), d("90"), d("110"), T0 + 20 * MIN, HOUR);
    expect(hold).toMatchObject({ reason: "max_hold", exit: d("100"), exitAt: T0 + 80 * MIN });
  });

  it("exits a take profit that gaps open at TP, but a gapped stop loss at the worse open", () => {
    const candles = flat(T0, 120, "100", (i, c) =>
      i === 3 ? { ...c, open: d("103"), high: d("103"), low: d("103"), close: d("103") } : c,
    );
    const s = new Series("X", candles);
    expect(walkPath(s, 1, "long", d("100"), d("101"), d("99"), T0, HOUR)).toMatchObject({
      reason: "take_profit",
      exit: d("101"),
    });
    expect(walkPath(s, 1, "short", d("100"), d("99"), d("101"), T0, HOUR)).toMatchObject({
      reason: "stop_loss",
      exit: d("103"),
    });
  });

  it("checks the rest of a mid-minute entry candle for the stop loss only", () => {
    const candles = flat(T0, 120, "100", (i, c) =>
      i === 0 ? { ...c, low: d("98.5"), high: d("102") } : c,
    );
    const s = new Series("X", candles);
    const r = walkPath(
      s,
      1,
      "long",
      d("100"),
      d("101"),
      d("99"),
      T0 + 20_000,
      HOUR,
      candles[0] ?? null,
    );
    expect(r).toMatchObject({ reason: "stop_loss", exit: d("99"), exitAt: T0 + 20_000 });
    // Không có SL trong nến đó: TP của nến vào giữa phút không được tính (chỉ SL).
    const ok = walkPath(
      s,
      1,
      "long",
      d("100"),
      d("101"),
      d("98"),
      T0 + 20_000,
      HOUR,
      candles[0] ?? null,
    );
    expect(ok).toMatchObject({ reason: "max_hold" });
  });

  it("decides on candle gaps over the whole hold before knowing the outcome", () => {
    const s = new Series("X", [...flat(T0, 10, "100"), ...flat(T0 + 50 * MIN, 30, "100")]);
    expect(holdCoverage(s, T0, HOUR)).toBe("gap");
    expect(holdCoverage(new Series("X", flat(T0, 30, "100")), T0, HOUR)).toBe("no_data");
    expect(holdCoverage(new Series("X", flat(T0, 70, "100")), T0, HOUR)).toBe("ok");
    // Lệnh chạm TP ở phút 3, TRƯỚC khoảng trống: vẫn bị bỏ (không chọn lọc theo kết quả).
    const end = T0 + 10 * DAY;
    const candles = [
      ...flat(end, 10, "100", (i, c) => (i === 3 ? { ...c, high: d("105") } : c)),
      ...flat(end + 50 * MIN, 30, "100"),
    ];
    const t = blankTrade({
      type: "funding",
      variant: "v",
      ruleVersion: "B-v1",
      asset: "ETH-USD",
      direction: "long",
      eventAt: end,
      seenAt: end,
      maxHoldMs: HOUR,
      what: "",
    });
    enterAndWalk(t, ctxOf(candles, hourlyZigzag(end, 10 * 24, "2")));
    expect(t.status).toBe("skipped");
    // Chuỗi chỉ có nến ở 40 / 80 phút: market ít giao dịch, đếm riêng.
    expect(t.skipReason).toMatch(/^Illiquid market/);
    // Có market tham chiếu: tham chiếu cũng trống cùng lúc → máy thu dừng; tham chiếu có nến suốt → market ít giao dịch.
    const again = (ref: Candle[]) => {
      const u = blankTrade({
        type: "funding",
        variant: "v",
        ruleVersion: "B-v1",
        asset: "ETH-USD",
        direction: "long",
        eventAt: end,
        seenAt: end,
        maxHoldMs: HOUR,
        what: "",
      });
      const c = ctxOf(candles, hourlyZigzag(end, 10 * 24, "2"));
      enterAndWalk(u, { ...c, reference: new Series("BTC-USD", ref) });
      return u.skipReason;
    };
    expect(again(candles)).toBe("Price data gap during the hold (collector down)");
    expect(again(flat(end, 120, "100"))).toMatch(/^Illiquid market/);
  });

  it("enters after the signal, sets TP / SL from the typical move and simulates both directions", () => {
    const end = T0 + 10 * DAY;
    const candles = flat(end, 120, "100", (i, c) => (i === 3 ? { ...c, high: d("103") } : c));
    const t = blankTrade({
      type: "funding",
      variant: "v",
      ruleVersion: "B-v1",
      asset: "ETH-USD",
      direction: "long",
      eventAt: end - 30_000,
      seenAt: end - 30_000,
      maxHoldMs: HOUR,
      what: "",
    });
    enterAndWalk(t, ctxOf(candles, hourlyZigzag(end, 10 * 24, "2")));
    // Biến động ≈ 1.96%: TP +2.94%, SL −1.47%, chi phí 4×2 + 1×2 + 3 = 13 bp.
    expect(t.status).toBe("entered");
    expect(t.entryAt).toBe(end);
    expect(t.costBp?.toString()).toBe("13");
    expect(t.exitReason).toBe("take_profit");
    expect(t.resultAfterFeesBp?.toDecimalPlaces(1).toString()).toBe(
      t.grossBp?.sub(13).toDecimalPlaces(1).toString(),
    );
    // Short cùng TP / SL: nến 3 chạm 103 ≥ SL 101.485 → −148.5 bp − 13 bp.
    expect(t.shortAfterFeesBp?.toDecimalPlaces(1).toString()).toBe("-161.5");
    expect(t.flags).toContain("spread_default");
  });

  it("skips a signal whose take profit is under 2× the cost", () => {
    const end = T0 + 10 * DAY;
    const t = blankTrade({
      type: "funding",
      variant: "v",
      ruleVersion: "B-v1",
      asset: "ETH-USD",
      direction: "long",
      eventAt: end,
      seenAt: end,
      maxHoldMs: HOUR,
      what: "",
    });
    enterAndWalk(t, ctxOf(flat(end, 120, "100"), hourlyZigzag(end, 10 * 24, "0.05")));
    expect(t.status).toBe("skipped");
    expect(t.skipReason).toMatch(/^Too thin to trade/);
  });
});

describe("A · whales", () => {
  const end = T0 + 10 * DAY;
  const snap = (finishedAt: number, median: string | null): WalletSnapshot => ({
    date: "2026-11-10",
    finishedAt,
    profit: d("1000"),
    winRate: d("0.6"),
    medianEntryNotional: median === null ? null : d(median),
    steadyScore: null,
    hidden: [],
  });
  const ev = (over: Partial<WhaleEvent>): WhaleEvent => ({
    id: "e",
    source: "hyperliquid",
    address: "0xaaa",
    market: "ETH-USD",
    kind: "open",
    positionBefore: d("0"),
    positionAfter: d("10"),
    notional: d("50000"),
    price: d("100"),
    at: end + 5 * MIN - 20_000,
    seenAt: end + 5 * MIN,
    ...over,
  });
  const ctx = () => ctxOf(flat(end, 600, "100"), hourlyWave(end, 10 * 24, "2"));

  it("only counts wallets ranked BEFORE the event (anti-survivorship)", () => {
    expect(snapshotAsOf([snap(end, "1000"), snap(end + DAY, "1")], end + HOUR)?.finishedAt).toBe(
      end,
    );
    expect(snapshotAsOf([snap(end + DAY, "1")], end)).toBeNull();
    const funnel = emptyWhaleFunnel();
    const later = new Map([[walletKey("hyperliquid", "0xAAA"), [snap(end + DAY, "1000")]]]);
    expect(evaluateWhales([ev({})], later, ctx(), funnel)).toEqual([]);
    expect(funnel.notInLeaderboardBefore).toBe(1);
  });

  it("enters a big open in the whale's direction, and drops late, small and reducing events", () => {
    const wallets = new Map([[walletKey("hyperliquid", "0xaaa"), [snap(end, "10000")]]]);
    const funnel = emptyWhaleFunnel();
    const trades = evaluateWhales(
      [
        ev({ id: "big", positionAfter: d("-10") }),
        ev({ id: "late", at: end, seenAt: end + 6 * MIN }),
        ev({ id: "small", notional: d("20000"), seenAt: end + 7 * MIN, at: end + 7 * MIN }),
        ev({
          id: "flat",
          kind: "add",
          positionAfter: d("0"),
          seenAt: end + 8 * MIN,
          at: end + 8 * MIN,
        }),
      ],
      wallets,
      ctx(),
      funnel,
    );
    expect(funnel).toMatchObject({ events: 4, late: 1, belowSize: 1, notOpenOrAdd: 1, signals: 1 });
    expect(trades).toHaveLength(1);
    expect(trades[0]).toMatchObject({
      direction: "short",
      status: "entered",
      delayMs: 20_000,
      ruleVersion: "A-v1",
    });
    expect(trades[0]?.detail.sizeMultiple).toBe(5);
  });

  it("skips a second signal while a Whales trade on the asset is open", () => {
    const wallets = new Map([
      [walletKey("hyperliquid", "0xaaa"), [snap(end, "10000")]],
      [walletKey("hyperliquid", "0xbbb"), [snap(end, "10000")]],
    ]);
    const trades = evaluateWhales(
      [ev({}), ev({ id: "2", address: "0xbbb", seenAt: end + 6 * MIN, at: end + 6 * MIN })],
      wallets,
      ctx(),
      emptyWhaleFunnel(),
    );
    expect(trades.map((t) => t.status)).toEqual(["entered", "skipped"]);
    expect(trades[1]?.skipReason).toMatch(/already open/);
    // Ví thứ hai cùng chiều trong 30 phút: điểm đồng thuận.
    expect(trades[1]?.detail.otherWhalesSameWay30m).toBe(1);
  });
});

describe("B · funding", () => {
  it("goes against a funding rate beyond the trailing 99th / 1st percentile", () => {
    const end = T0 + 10 * DAY;
    const points = Array.from({ length: 150 }, (_, i) => ({
      at: end - (150 - i) * HOUR,
      rate: d(String((i % 10) / 1e6)),
    }));
    points.push({ at: end, rate: d("0.0001") }, { at: end + 2 * HOUR, rate: d("0.000005") });
    const funnel = emptyFundingFunnel();
    const trades = evaluateFunding(
      "ETH-USD",
      points,
      { from: end - 40 * HOUR, to: end + DAY },
      ctxOf(flat(end, 900, "100"), hourlyWave(end, 10 * 24, "2")),
      funnel,
    );
    expect(trades).toHaveLength(1);
    expect(trades[0]?.skipReason).toBeNull();
    expect(trades[0]).toMatchObject({ direction: "short", status: "entered", eventAt: end });
    expect(funnel.signals).toBe(1);
    expect(funnel.notExtreme).toBe(41);
    expect(quantileSorted([d("1"), d("2"), d("3")], 0.5)?.toString()).toBe("2");
  });

  it("never lets a later extreme value change an earlier threshold", () => {
    const end = T0 + 10 * DAY;
    const base = Array.from({ length: 150 }, (_, i) => ({
      at: end - (150 - i) * HOUR,
      rate: d(String((i % 10) / 1e6)),
    }));
    const run = (later: { at: number; rate: Decimal }[]) =>
      evaluateFunding(
        "ETH-USD",
        [...base, { at: end, rate: d("0.0001") }, ...later],
        { from: end, to: end + HOUR },
        ctxOf(flat(end, 900, "100"), hourlyWave(end, 10 * 24, "2")),
        emptyFundingFunnel(),
      )[0];
    const without = run([]);
    const withLater = run([
      { at: end + 20 * HOUR, rate: d("0.5") },
      { at: end + 21 * HOUR, rate: d("-0.5") },
    ]);
    expect(without?.detail.p99).toBe("0.000009");
    expect(withLater?.detail).toEqual(without?.detail);
    expect(withLater?.direction).toBe("short");
  });

  it("needs 100 prior periods", () => {
    const points = Array.from({ length: 50 }, (_, i) => ({ at: T0 + i * HOUR, rate: d("0.001") }));
    const funnel = emptyFundingFunnel();
    evaluateFunding("ETH-USD", points, { from: T0, to: T0 + DAY * 3 }, ctxOf([]), funnel);
    expect(funnel).toMatchObject({ periods: 50, shortHistory: 50, signals: 0 });
  });
});

describe("C · price structure", () => {
  const end = T0 + 10 * DAY;
  it("trades a 60-min range break with 2× volume, not one without volume", () => {
    // 60 phút trong khoảng 99.9–100.1, rồi nến phá lên 100.5; volume 3 (trung vị 1).
    const candles = flat(end - 2 * HOUR, 300, "100", (i, c) => {
      const base = { ...c, high: d("100.1"), low: d("99.9") };
      if (i === 180) return { ...base, high: d("100.6"), close: d("100.5"), volume: 3 };
      if (i === 240) return { ...base, low: d("99"), close: d("99.2"), volume: 1 };
      return base;
    });
    const funnel = emptyStructureFunnel();
    const trades = evaluateStructure(
      ctxOf(candles, hourlyZigzag(end, 10 * 24, "1")),
      { from: end, to: end + 3 * HOUR },
      funnel,
    );
    const breakout = trades.filter((t) => t.variant === "range_breakout");
    expect(breakout).toHaveLength(1);
    expect(breakout[0]).toMatchObject({ direction: "long", eventAt: end + HOUR + MIN });
    expect(funnel.lowVolume).toBeGreaterThan(0);
    // 2 giờ lịch sử: chưa xét được squeeze, đếm riêng, không phải "không hẹp".
    expect(funnel.squeezeHistoryShort).toBeGreaterThan(0);
    expect(funnel.notSqueezed).toBe(0);
  });
});

describe("random baseline and gate", () => {
  /** Lệnh đã vào lúc T0 + `slot` × 2 giờ (12 lệnh mỗi ngày). */
  const trade = (dir: "long" | "short", long: string, short: string, slot: number): SignalTrade => {
    const at = T0 + slot * 2 * HOUR;
    const t = blankTrade({
      type: "whale",
      variant: "v",
      ruleVersion: "A-v1",
      asset: "X",
      direction: dir,
      eventAt: at,
      seenAt: at,
      maxHoldMs: HOUR,
      what: "",
    });
    t.status = "entered";
    t.entryAt = at;
    t.exitAt = at + HOUR;
    t.costBp = d("10");
    t.longAfterFeesBp = d(long);
    t.shortAfterFeesBp = d(short);
    t.resultAfterFeesBp = dir === "long" ? d(long) : d(short);
    return t;
  };
  const many = (n: number, long: string, short: string, from: number) =>
    Array.from({ length: n }, (_, i) =>
      trade(
        i % 2 === 0 ? "long" : "short",
        i % 2 === 0 ? long : short,
        i % 2 === 0 ? short : long,
        from + i,
      ),
    );
  const obs = (vals: string[], at: (i: number) => number) =>
    vals.map((v, i) => ({ v: d(v), at: at(i) }));

  it("uses the same moments with the given Long / Short mix", () => {
    const ts = [
      trade("long", "30", "-50", 1),
      trade("long", "10", "-30", 2),
      trade("short", "-20", "0", 3),
      trade("long", "-10", "-10", 4),
    ];
    expect(attachRandom(ts).longShare).toBe(0.75);
    // 0.75 × 30 + 0.25 × −50 = 10.
    expect(ts[0]?.randomAfterFeesBp?.toString()).toBe("10");
    expect(ts[2]?.randomAfterFeesBp?.toString()).toBe("-15");
    const p = periodStats(ts);
    expect(p.afterFees.mean?.toString()).toBe("7.5");
    expect(p.difference.n).toBe(4);
  });

  it("takes the Long share from the in-sample 2/3 only, and flags an all-long group", () => {
    // 6 lệnh trong mẫu toàn Long, 3 lệnh ngoài mẫu toàn Short: p = 1 từ phần trong mẫu.
    const ts = [
      ...Array.from({ length: 6 }, (_, i) => trade("long", "10", "-10", i)),
      ...Array.from({ length: 3 }, (_, i) => trade("short", "10", "-10", 6 + i)),
    ];
    const r = groupReport(ts);
    expect(r.longShare).toBe(1);
    expect(ts[8]?.randomAfterFeesBp?.toString()).toBe("10");
    expect(r.gate.randomNote).toBe("all long: cannot beat random by construction");
  });

  it("widens the likely range when trades cluster by day", () => {
    // Cùng 100 giá trị: (a) 10 ngày × 10 lệnh giống nhau trong ngày, (b) mỗi lệnh một ngày.
    const vals = Array.from({ length: 100 }, (_, i) => String(Math.floor(i / 10) * 4 - 15));
    const clustered = summarize(obs(vals, (i) => T0 + Math.floor(i / 10) * DAY + (i % 10) * MIN));
    const independent = summarize(obs(vals, (i) => T0 + i * DAY));
    expect(clustered.clusters).toBe(10);
    expect(independent.clusters).toBe(100);
    const width = (x: typeof clustered) => (x.ciHigh ?? d("0")).sub(x.ciLow ?? d("0"));
    expect(width(clustered).gt(width(independent).mul(2))).toBe(true);
    // Khoảng chuẩn (coi độc lập) giống nhau ở hai cách: giữ làm field phụ.
    expect(clustered.normalCiLow?.toString()).toBe(independent.normalCiLow?.toString());
    // Số lệnh cần dùng sai số chuẩn theo cụm: lớn hơn.
    const pos = (x: string[]) => x.map((v) => String(Number(v) + 20));
    const cn = tradesNeeded(summarize(obs(pos(vals), (i) => T0 + Math.floor(i / 10) * DAY)));
    const inn = tradesNeeded(summarize(obs(pos(vals), (i) => T0 + i * DAY)));
    expect(cn).not.toBeNull();
    expect((cn ?? 0) > (inn ?? 0)).toBe(true);
  });

  it("has no likely range from a single day", () => {
    const s = summarize(obs(["1", "3"], () => T0));
    expect(s.mean?.toString()).toBe("2");
    expect(s.sd?.toDecimalPlaces(6).toString()).toBe("1.414214");
    expect(s.normalCiLow?.toDecimalPlaces(4).toString()).toBe("0.04");
    expect(s.ciLow).toBeNull();
    expect(tradesNeeded(s)).toBeNull();
  });

  it("reports max drawdown of the cumulative after-fees result, in bp and USD on 500 USDC", () => {
    const ts = ["10", "-30", "5", "-20", "40"].map((v, i) => {
      const t = trade("long", v, "0", i);
      return t;
    });
    // Cộng dồn 10, −20, −15, −35, 5: đỉnh 10, đáy −35 → 45 bp = 2.25 USD trên 500.
    const r = groupReport(ts);
    expect(r.all.maxDrawdown.bp.toString()).toBe("45");
    expect(r.all.maxDrawdown.usd.toString()).toBe("2.25");
    expect(r.gate.maxDrawdown.group.bp.toString()).toBe("45");
    expect(r.gate.maxDrawdown.threshold).toBeNull();
  });

  it("explains why there is no trades-needed estimate", () => {
    const one = groupReport(many(2, "30", "-20", 0));
    expect(one.outOfSample.n).toBe(1);
    expect(one.gate.tradesNeededNote).toBe("no data yet");
    expect(one.gate.stillNeeds).toContain("no data yet");
    // Trung bình > 0 nhưng < 2 × chi phí (10 bp): không phải "about N trades".
    const small = groupReport(
      many(300, "12", "-20", 0).map((t, i) => {
        t.resultAfterFeesBp = d(i % 2 === 0 ? "14" : "10");
        return t;
      }),
    );
    expect(small.outOfSample.afterFees.mean?.toString()).toBe("12");
    expect(small.gate.outOfSampleTradesNeeded).toBeNull();
    expect(small.gate.tradesNeededNote).toBe("cannot reach 2× cost at this average");
    expect(small.gate.stillNeeds.some((x) => x.startsWith("about"))).toBe(false);
  });

  it("passes only with ≥ 100 out-of-sample trades, a mean ≥ 2× cost above 0, a positive difference and the same sign", () => {
    // Lệnh thật luôn +30 / +32, chiều ngược −20: trung bình > 2 × 10, hơn random.
    const good = groupReport(
      many(330, "30", "-20", 0).map((t, i) => {
        if (i % 3 === 0) t.resultAfterFeesBp = d("32");
        return t;
      }),
    );
    expect(good.outOfSample.n).toBe(110);
    expect(good.outOfSample.afterFees.clusters).toBeGreaterThan(5);
    expect(good.gate.status).toBe("passing");
    expect(good.gate.tradesNeededNote).toBe("estimate");
    const few = groupReport(many(90, "30", "-20", 0));
    expect(few.gate.status).toBe("collecting");
    expect(few.gate.stillNeeds[0]).toBe("70 more out-of-sample trades");
    const inS = periodStats(many(10, "30", "-20", 0));
    const outS = periodStats(many(120, "-30", "20", 100));
    expect(gateOf(inS, outS).checks.sameSignBothPeriods.ok).toBe(false);
    expect(gateOf(inS, outS).tradesNeededNote).toBe("cannot pass at this average");
  });
});

describe("D1 · risk filter", () => {
  const windows = pauseWindows(
    Date.parse("2026-11-10T00:00:00Z"),
    Date.parse("2026-11-11T00:00:00Z"),
  );
  const cpi = Date.parse("2026-11-10T13:30:00Z");

  it("builds pause windows from the versioned calendar", () => {
    expect(windows).toHaveLength(1);
    expect(windows[0]).toMatchObject({
      kind: "CPI",
      start: cpi - 15 * MIN,
      end: cpi + HOUR,
      verified: false,
    });
    expect(inWindow(windows, cpi + 59 * MIN)?.kind).toBe("CPI");
    expect(inWindow(windows, cpi + HOUR)).toBeNull();
  });

  it("drops Volume Builder round trips whose entry order was placed in a window and reports cost per $1M", () => {
    // Lệnh vào đặt lúc `placedAt`, khớp 5 phút sau.
    const rt = (placedAt: number, exit: string) => ({
      botId: "b",
      market: "ETH-USD",
      placedAt,
      t0: placedAt + 5 * MIN,
      side: "long" as const,
      entryPrice: d("100"),
      exitPrice: d(exit),
      qty: d("10"),
      fees: d("0.2"),
      volume: d("2000"),
    });
    // Lượt 2 đặt TRƯỚC khung (cpi − 20 phút) nhưng khớp TRONG khung: bot thật vẫn vào, giữ nguyên.
    const r = filterVb([rt(cpi, "99"), rt(cpi - 20 * MIN, "100")], windows);
    // Gốc: net −10.2 − 0.2 = −10.4 trên 4 000 → 2 600 / $1M. Sau lọc: −0.2 trên 2 000 → 100.
    expect(r.baseline.costPerMillion?.toString()).toBe("2600");
    expect(r.filtered.costPerMillion?.toString()).toBe("100");
    expect(r.costPerMillionChange?.toString()).toBe("-2500");
    expect(r.volumeLostPct?.toString()).toBe("50");
    expect(r.byWindow[0]).toMatchObject({ kind: "CPI", n: 1 });
  });

  it("drops only position-increasing Market Making fills in a window, by 5-minute markout", () => {
    const fills = markOpening(
      [
        { side: "buy" as const, size: d("1"), at: cpi },
        { side: "sell" as const, size: d("1"), at: cpi + MIN },
        { side: "buy" as const, size: d("1"), at: cpi + 2 * HOUR },
      ],
      d("0"),
    );
    expect(fills.map((f) => f.opening)).toEqual([true, false, true]);
    const mm: MmFill[] = fills.map((f) => ({
      ...f,
      botId: "b",
      market: "ETH-USD",
      price: d("100"),
      fee: d("0.01"),
      markout: f.at === cpi + MIN ? null : d("99.9"),
    }));
    const r = filterMm(mm, windows);
    expect(r.noPrice).toBe(1);
    expect(r.skipped.n).toBe(1);
    // Mỗi fill mua: 1 × (99.9 − 100) − 0.01 = −0.11 trên 100.
    expect(r.filtered.costPerMillion?.toString()).toBe("1100");
  });
});

import { describe, expect, it } from "vitest";

import { Decimal } from "../money";
import {
  candidatesOf,
  closeResult,
  costCheck,
  eventTooOld,
  exitCheck,
  isUsMarketOpen,
  levelOf,
  movedPct,
  oneWayFeePct,
  planTrade,
  roundTripCost,
  sourceTierOf,
  spreadPctOf,
  storyKey,
  typicalMovePct,
} from "../signal-research/logic";
import {
  baselineOf,
  gateStatus,
  meanRange,
  replayOnCandles,
  tradesNeeded,
} from "../signal-research/report";
import { catalystRule, NEWS_RULES, SignalReason, SIGNAL_CATALYSTS } from "../signal-research/rules";

const d = (v: string) => new Decimal(v);
const MARKETS = new Set(["BTC-USD", "SOL-USD", "1000PEPE-USD", "NVDA-USD", "MSTR-USD", "COIN-USD"]);
const H = 3_600_000;

describe("rules v2", () => {
  it("maps every catalyst to the direction and max hold of #269 v3.3", () => {
    expect(catalystRule("hack_exploit")).toMatchObject({ direction: "short", maxHoldHours: 24 });
    expect(catalystRule("listing")).toMatchObject({ direction: "long", maxHoldHours: 24 });
    expect(catalystRule("delisting")).toMatchObject({ direction: "short", maxHoldHours: 48 });
    expect(catalystRule("etf_approved")).toMatchObject({ direction: "long", maxHoldHours: 72 });
    expect(catalystRule("etf_delayed_or_rejected")).toMatchObject({
      direction: "short",
      maxHoldHours: 48,
    });
    expect(catalystRule("regulatory_action")).toMatchObject({
      direction: "short",
      maxHoldHours: 72,
    });
    expect(catalystRule("favorable_ruling")).toMatchObject({ direction: "long", maxHoldHours: 72 });
    expect(catalystRule("treasury_buy")).toMatchObject({ direction: "long", maxHoldHours: 48 });
    expect(catalystRule("treasury_sell")).toMatchObject({ direction: "short", maxHoldHours: 48 });
    expect(catalystRule("earnings_beat")).toMatchObject({
      direction: "long",
      maxHoldHours: 72,
      kinds: ["stock"],
    });
    expect(catalystRule("earnings_miss")).toMatchObject({
      direction: "short",
      maxHoldHours: 72,
      kinds: ["stock"],
    });
    expect(catalystRule("token_unlock")).toMatchObject({ direction: "short", maxHoldHours: 48 });
    expect(SIGNAL_CATALYSTS).toHaveLength(12);
    expect(NEWS_RULES.version).toBe("news-v2");
  });
});

describe("candidatesOf", () => {
  it("keeps only SoDEX markets, maps stocks through the ticker map and 1000x coins", () => {
    const c = candidatesOf(
      [
        { symbol: "btc", name: "Bitcoin" },
        { symbol: "PEPE", name: "Pepe" },
        { symbol: "NVDA", name: '{"EN": "NVIDIA CORPORATION"}' },
        { symbol: "MSTRX", name: "MICROSTRATEGY XSTOCK" },
        { symbol: "ANT", name: '{"EN": "ANTHROPIC"}' },
        { symbol: "DOGE", name: "Dogecoin" },
      ],
      MARKETS,
    );
    expect(c).toEqual([
      { symbol: "PEPE", market: "1000PEPE-USD", kind: "crypto" },
      { symbol: "BTC", market: "BTC-USD", kind: "crypto" },
      { symbol: "MSTRX", market: "MSTR-USD", kind: "stock" },
      { symbol: "NVDA", market: "NVDA-USD", kind: "stock" },
    ]);
  });

  it("never maps a coin onto a stock market with the same ticker", () => {
    expect(candidatesOf([{ symbol: "COIN", name: "Some Coin" }], MARKETS)).toEqual([]);
  });
});

describe("source tiers and level", () => {
  it("maps known sources and falls back by category", () => {
    expect(sourceTierOf("Bloomberg", 5)).toBe("top");
    expect(sourceTierOf("TechFlow", 1)).toBe("mid");
    expect(sourceTierOf("some_project", 7)).toBe("mid");
    expect(sourceTierOf("random_kol", 4)).toBe("low");
  });

  it("High = 2+ independent sources incl. a top one; Medium = 1 top or 2+ mid; Low otherwise", () => {
    expect(
      levelOf([
        { name: "Bloomberg", tier: "top" },
        { name: "Odaily", tier: "mid" },
      ]),
    ).toBe("high");
    expect(levelOf([{ name: "Bloomberg", tier: "top" }])).toBe("medium");
    expect(
      levelOf([
        { name: "Bloomberg", tier: "top" },
        { name: "bloomberg", tier: "top" },
      ]),
    ).toBe("medium");
    expect(
      levelOf([
        { name: "Odaily", tier: "mid" },
        { name: "PANews", tier: "mid" },
      ]),
    ).toBe("medium");
    expect(
      levelOf([
        { name: "Odaily", tier: "mid" },
        { name: "kol", tier: "low" },
      ]),
    ).toBe("low");
    expect(levelOf([{ name: "kol", tier: "low" }])).toBe("low");
  });

  it("story key is token + catalyst", () => {
    expect(storyKey("SOL-USD", "etf_delayed_or_rejected")).toBe("SOL-USD|etf_delayed_or_rejected");
    expect(storyKey("SOL-USD", "etf_approved")).not.toBe(
      storyKey("SOL-USD", "etf_delayed_or_rejected"),
    );
  });

  it("drops events more than 24 h older than the publish time", () => {
    const pub = Date.parse("2026-11-18T12:00:00Z");
    expect(eventTooOld("2026-11-18", pub)).toBe(false);
    expect(eventTooOld("2026-11-17", pub)).toBe(false);
    expect(eventTooOld("2026-11-16", pub)).toBe(true);
    expect(eventTooOld(null, pub)).toBe(false);
  });
});

describe("cost filter and trade math", () => {
  const fee = oneWayFeePct(null, 10); // taker 0.04% + builder 0.01%

  it("round-trip cost = taker ×2 + builder ×2 + spread", () => {
    expect(fee.toFixed()).toBe("0.05");
    const q = { bid: d("99.95"), ask: d("100.05") };
    const c = roundTripCost(fee, spreadPctOf(q));
    expect(c.feePct.toFixed()).toBe("0.1");
    expect(c.spreadPct.toFixed()).toBe("0.1");
    expect(c.totalPct.toFixed()).toBe("0.2");
  });

  it("needs TP ≥ 2 × cost; says too thin when the spread dominates", () => {
    const thin = roundTripCost(fee, d("0.5"));
    expect(costCheck(d("1.0"), thin)).toBe(SignalReason.tooThin);
    const tight = roundTripCost(fee, d("0.01"));
    expect(costCheck(d("0.2"), tight)).toBe(SignalReason.moveTooSmall);
    expect(costCheck(d("0.22"), tight)).toBeNull();
  });

  it("enters a short on the bid with TP 1.5× / SL 0.75× the typical move", () => {
    const p = planTrade({
      direction: "short",
      quote: { bid: d("142.18"), ask: d("142.22") },
      typicalMovePct: d("2"),
      oneWayFeePct: fee,
    });
    expect(p.entryPrice.toFixed()).toBe("142.18");
    expect(p.tpPct.toFixed()).toBe("3");
    expect(p.slPct.toFixed()).toBe("1.5");
    expect(p.tpPrice.toFixed()).toBe("137.9146");
    expect(p.slPrice.toFixed()).toBe("144.3127");
    expect(p.entryFee.toFixed()).toBe("0.25");
    const long = planTrade({
      direction: "long",
      quote: { bid: d("99"), ask: d("100") },
      typicalMovePct: d("2"),
      oneWayFeePct: fee,
    });
    expect(long.entryPrice.toFixed()).toBe("100");
    expect(long.tpPrice.toFixed()).toBe("103");
    expect(long.slPrice.toFixed()).toBe("98.5");
  });

  it("result after fees: 2% short on 500 USDC is ≈ $9.50 after a 0.10% round trip", () => {
    const r = closeResult({
      direction: "short",
      entryPrice: "100",
      exitPrice: "98",
      qty: "5",
      sizeUsdc: "500",
      entryFee: "0.25",
      feePct: "0.05",
    });
    expect(r.exitFee.toFixed()).toBe("0.245");
    expect(r.resultUsdc.toFixed()).toBe("9.505");
    expect(r.resultPct.toFixed()).toBe("1.901");
  });

  it("typical move is the median absolute change over the hold", () => {
    const closes = Array.from({ length: 300 }, (_, i) => ({
      hour: i * H,
      close: i % 2 === 0 ? "100" : "101",
    }));
    // Giữ 1 giờ: 150 cặp tăng 1 %, 149 cặp giảm ~0.990 % → trung vị (299 mẫu) là 1 %.
    const m = typicalMovePct(closes, 1);
    expect(m?.toDecimalPlaces(3).toFixed()).toBe("1");
    expect(typicalMovePct(closes.slice(0, 50), 1)).toBeNull();
  });

  it("moved before entry and US market hours", () => {
    expect(movedPct("100", "99.4")?.toFixed()).toBe("-0.6");
    expect(isUsMarketOpen(Date.parse("2026-11-18T15:00:00Z"))).toBe(true); // 10:00 New York, Wed
    expect(isUsMarketOpen(Date.parse("2026-11-18T22:00:00Z"))).toBe(false);
    expect(isUsMarketOpen(Date.parse("2026-11-21T15:00:00Z"))).toBe(false); // Saturday
  });
});

describe("watcher exits", () => {
  const short = {
    direction: "short" as const,
    tpPrice: d("98"),
    slPrice: d("101"),
    maxHoldUntil: 1000,
  };
  const long = {
    direction: "long" as const,
    tpPrice: d("102"),
    slPrice: d("99"),
    maxHoldUntil: 1000,
  };

  it("a short closes on the ask, a long on the bid", () => {
    expect(exitCheck(short, { bid: d("97.9"), ask: d("98.1") }, 0)).toBeNull();
    expect(exitCheck(short, { bid: d("97.8"), ask: d("98") }, 0)).toEqual({
      reason: "take_profit",
      price: d("98"),
    });
    expect(exitCheck(short, { bid: d("100.9"), ask: d("101.2") }, 0)?.reason).toBe("stop_loss");
    expect(exitCheck(long, { bid: d("101.9"), ask: d("102.1") }, 0)).toBeNull();
    expect(exitCheck(long, { bid: d("102"), ask: d("102.2") }, 0)?.reason).toBe("take_profit");
    expect(exitCheck(long, { bid: d("98.9"), ask: d("99.1") }, 0)?.reason).toBe("stop_loss");
  });

  it("closes at max hold, and waits when there is no price", () => {
    expect(exitCheck(long, { bid: d("100"), ask: d("100.1") }, 1000)).toEqual({
      reason: "max_hold",
      price: d("100"),
    });
    expect(exitCheck(long, null, 5000)).toBeNull();
  });
});

describe("report", () => {
  it("replays TP / SL on candles, stop first when one candle hits both", () => {
    const c = (ts: number, high: string, low: string, close: string) => ({ ts, high, low, close });
    const base = { entry: "100", tpPct: "2", slPct: "1", from: 0, until: 10 };
    expect(
      replayOnCandles({
        ...base,
        direction: "long",
        candles: [c(1, "101", "99.5", "100"), c(2, "102.5", "100", "102")],
      })?.toFixed(),
    ).toBe("2");
    expect(
      replayOnCandles({
        ...base,
        direction: "long",
        candles: [c(1, "102.5", "98.5", "100")],
      })?.toFixed(),
    ).toBe("-1");
    expect(
      replayOnCandles({
        ...base,
        direction: "short",
        candles: [c(1, "100.5", "99.5", "99.5")],
      })?.toFixed(),
    ).toBe("0.5");
    expect(replayOnCandles({ ...base, direction: "short", candles: [] })).toBeNull();
  });

  it("random entry keeps the long / short mix; difference is news minus random", () => {
    const b = baselineOf([
      { direction: "long", longPct: d("2"), shortPct: d("-1") },
      { direction: "short", longPct: d("-1"), shortPct: d("2") },
      { direction: "long", longPct: null, shortPct: null },
    ]);
    expect(b.n).toBe(2);
    expect(b.skipped).toBe(1);
    expect(b.longShare?.toFixed()).toBe("0.5");
    expect(b.news?.mean.toFixed()).toBe("2");
    expect(b.random?.mean.toFixed()).toBe("0.5");
    expect(b.difference?.mean.toFixed()).toBe("1.5");
  });

  it("gate: collecting below 100, passing only when every condition holds", () => {
    const few = Array.from({ length: 50 }, () => d("1"));
    expect(gateStatus({ results: few, avgCostPct: d("0.1"), difference: meanRange(few) })).toBe(
      "collecting",
    );
    const good = Array.from({ length: 120 }, (_, i) => d(i % 2 === 0 ? "1.2" : "0.8"));
    expect(gateStatus({ results: good, avgCostPct: d("0.1"), difference: meanRange(good) })).toBe(
      "passing",
    );
    expect(gateStatus({ results: good, avgCostPct: d("0.6"), difference: meanRange(good) })).toBe(
      "failing",
    );
    const noEdge = Array.from({ length: 120 }, (_, i) => d(i % 2 === 0 ? "1" : "-1"));
    expect(gateStatus({ results: good, avgCostPct: d("0.1"), difference: meanRange(noEdge) })).toBe(
      "failing",
    );
  });

  it("trades needed = (1.96 × sd ÷ mean)², at least 100", () => {
    const diff = Array.from({ length: 40 }, (_, i) => d(i % 2 === 0 ? "2.5" : "-2.1"));
    const n = tradesNeeded(meanRange(diff));
    expect(n).toBeGreaterThan(100);
    expect(tradesNeeded(meanRange([d("1"), d("1.1")]))).toBe(100);
    expect(tradesNeeded(meanRange([d("-1"), d("-1.1")]))).toBeNull();
  });
});

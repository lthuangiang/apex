import { describe, expect, it } from "vitest";

import {
  classify,
  coinIndex,
  episodesOf,
  LEADER_STATS,
  leaderStats,
  meetsMinHold,
  sodexMarketOf,
  type LeaderFill,
  type LeaderStats,
} from "../leader-stats";

const NOW = Date.UTC(2026, 10, 11, 12);
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const INDEX = coinIndex(["BTC-USD", "ETH-USD", "1000PEPE-USD", "SOL-USD"]);

function fill(
  p: Partial<LeaderFill> & Pick<LeaderFill, "time" | "side" | "sz" | "startPosition">,
): LeaderFill {
  return { coin: "BTC", px: "100", closedPnl: "0", fee: "0", liquidatedSelf: false, ...p };
}

/** Một episode long: mở `sz` lúc `at`, đóng sau `holdMs` với PnL `pnl`. */
function roundTrip(at: number, holdMs: number, pnl: string, coin = "BTC", sz = "1"): LeaderFill[] {
  return [
    fill({ coin, time: at, side: "B", sz, startPosition: "0" }),
    fill({ coin, time: at + holdMs, side: "A", sz, startPosition: sz, closedPnl: pnl }),
  ];
}

const stats = (fills: LeaderFill[], extra: Partial<Parameters<typeof leaderStats>[0]> = {}) =>
  leaderStats({ fills, funding: [], now: NOW, index: INDEX, historyIncomplete: false, ...extra });

describe("coin mapping", () => {
  it("maps core perps, k-prefixed coins, and skips spot and HIP-3", () => {
    expect(sodexMarketOf("BTC", INDEX)).toBe("BTC-USD");
    expect(sodexMarketOf("kPEPE", INDEX)).toBe("1000PEPE-USD");
    expect(sodexMarketOf("@107", INDEX)).toBeNull();
    expect(sodexMarketOf("xyz:TSLA", INDEX)).toBeNull();
    expect(sodexMarketOf("DOGE", INDEX)).toBeNull();
  });
});

describe("episodes", () => {
  it("opens, adds, reduces and closes one episode", () => {
    const t = NOW - DAY;
    const e = episodesOf([
      fill({ time: t, side: "B", sz: "1", startPosition: "0", fee: "1" }),
      fill({ time: t + 10_000, side: "B", sz: "1", startPosition: "1", fee: "1" }),
      fill({ time: t + HOUR, side: "A", sz: "0.5", startPosition: "2", closedPnl: "5", fee: "1" }),
      fill({
        time: t + 2 * HOUR,
        side: "A",
        sz: "1.5",
        startPosition: "1.5",
        closedPnl: "15",
        fee: "1",
      }),
    ]);
    expect(e).toHaveLength(1);
    expect(e[0]).toMatchObject({
      side: "long",
      openedAt: t,
      closedAt: t + 2 * HOUR,
      liquidated: false,
    });
    expect(e[0]?.net.toString()).toBe("16");
    // Hai fill mở trong 60 giây đầu: 2 × 100.
    expect(e[0]?.entryNotional.toString()).toBe("200");
  });

  it("splits a flip into a close and a new episode, sharing the fee by size", () => {
    const t = NOW - DAY;
    const e = episodesOf([
      fill({ time: t, side: "B", sz: "1", startPosition: "0" }),
      fill({ time: t + HOUR, side: "A", sz: "3", startPosition: "1", closedPnl: "10", fee: "3" }),
      fill({ time: t + 3 * HOUR, side: "B", sz: "2", startPosition: "-2", closedPnl: "-4" }),
    ]);
    expect(e).toHaveLength(2);
    expect(e[0]).toMatchObject({ side: "long", closedAt: t + HOUR });
    expect(e[0]?.net.toString()).toBe("9");
    expect(e[1]).toMatchObject({ side: "short", openedAt: t + HOUR, closedAt: t + 3 * HOUR });
    expect(e[1]?.net.toString()).toBe("-6");
  });

  it("keeps a position opened before the data window as partial (no open time)", () => {
    const e = episodesOf([
      fill({ time: NOW - DAY, side: "A", sz: "1", startPosition: "1", closedPnl: "7" }),
    ]);
    expect(e[0]).toMatchObject({ openedAt: null, closedAt: NOW - DAY });
  });

  it("leaves a still-open position open", () => {
    const e = episodesOf([fill({ time: NOW - HOUR, side: "A", sz: "1", startPosition: "0" })]);
    expect(e[0]).toMatchObject({ side: "short", closedAt: null });
  });

  it("marks an episode closed by the wallet's own liquidation", () => {
    const e = episodesOf([
      fill({ time: NOW - DAY, side: "B", sz: "1", startPosition: "0" }),
      fill({
        time: NOW - HOUR,
        side: "A",
        sz: "1",
        startPosition: "1",
        closedPnl: "-50",
        liquidatedSelf: true,
      }),
    ]);
    expect(e[0]?.liquidated).toBe(true);
  });
});

describe("leaderStats", () => {
  it("returns null hold and win rate when there are too few episodes", () => {
    const s = stats(roundTrip(NOW - DAY, HOUR, "10"));
    expect(s.closedEpisodes).toBe(1);
    expect(s.typicalHoldMs).toBeNull();
    expect(s.winRate).toBeNull();
  });

  it("computes hold from 10 episodes but win rate only from 20", () => {
    const ten = Array.from({ length: 10 }, (_, i) =>
      roundTrip(NOW - (i + 1) * DAY, (i + 1) * HOUR, "1"),
    ).flat();
    const s10 = stats(ten);
    expect(s10.typicalHoldMs).toBe(5.5 * HOUR);
    expect(s10.winRate).toBeNull();
    const twenty = Array.from({ length: 20 }, (_, i) =>
      roundTrip(NOW - (i + 1) * HOUR * 30, HOUR, i < 15 ? "2" : "-1"),
    ).flat();
    const s20 = stats(twenty);
    expect(s20.winRate).toBe("0.75");
    expect(s20.wins).toBe(15);
  });

  it("sums realized minus fees plus funding, and tracks the worst dip on the hourly curve", () => {
    const fills = [
      ...roundTrip(NOW - 5 * DAY, HOUR, "100"),
      ...roundTrip(NOW - 4 * DAY, HOUR, "-60"),
      ...roundTrip(NOW - 3 * DAY, HOUR, "30"),
    ].map((f) => ({ ...f, fee: "1" }));
    const s = stats(fills, { funding: [{ coin: "BTC", time: NOW - 2 * DAY, usdc: "-4" }] });
    // 70 realized − 6 fees − 4 funding.
    expect(s.profit).toBe("60");
    // Đỉnh 98 (100 − 2 phí), đáy 35 (phí mở lần ba) → sụt 63.
    expect(s.worstDip).toBe("63");
  });

  it("ignores fills outside the 30-day window and spot fills", () => {
    const s = stats([
      ...roundTrip(NOW - 40 * DAY, HOUR, "1000"),
      ...roundTrip(NOW - DAY, HOUR, "5", "@107"),
      ...roundTrip(NOW - DAY, HOUR, "5"),
    ]);
    expect(s.profit).toBe("5");
  });

  it("measures SoDEX coverage by notional and lists markets by size", () => {
    const s = stats([
      ...roundTrip(NOW - DAY, HOUR, "1", "BTC", "3"),
      ...roundTrip(NOW - DAY, HOUR, "1", "kPEPE", "1"),
      ...roundTrip(NOW - DAY, HOUR, "1", "DOGE", "1"),
      ...roundTrip(NOW - DAY, HOUR, "1", "xyz:TSLA", "1"),
    ]);
    expect(s.coverage).toBe("0.6667");
    expect(s.markets).toEqual(["BTC-USD", "1000PEPE-USD"]);
    expect(s.unlistedCoins).toEqual(["DOGE", "xyz:TSLA"]);
  });

  it("returns null coverage with no perp fills instead of 0", () => {
    expect(stats([]).coverage).toBeNull();
    expect(stats([]).topTradeShare).toBeNull();
  });

  it("measures top-trade share against the sum of winning episodes", () => {
    const s = stats([
      ...roundTrip(NOW - 3 * DAY, HOUR, "60"),
      ...roundTrip(NOW - 2 * DAY, HOUR, "40"),
    ]);
    expect(s.topTradeShare).toBe("0.6");
  });

  it("counts the wallet's own liquidations once per event", () => {
    const s = stats([
      fill({ time: NOW - DAY, side: "B", sz: "2", startPosition: "0" }),
      fill({ time: NOW - HOUR, side: "A", sz: "1", startPosition: "2", liquidatedSelf: true }),
      fill({ time: NOW - HOUR, side: "A", sz: "1", startPosition: "1", liquidatedSelf: true }),
    ]);
    expect(s.liquidations).toBe(1);
  });

  it("passes the history-incomplete flag through", () => {
    expect(stats([], { historyIncomplete: true }).historyIncomplete).toBe(true);
  });
});

describe("classify", () => {
  const base: LeaderStats = {
    profit: "1000",
    worstDip: "200",
    typicalHoldMs: 2 * HOUR,
    winRate: "0.6",
    wins: 30,
    closedEpisodes: 50,
    topTradeShare: "0.2",
    coverage: "0.9",
    liquidations: 0,
    medianEntryNotional: "5000",
    markets: ["BTC-USD"],
    unlistedCoins: [],
    dailyCurve: [],
    historyIncomplete: false,
    fills: 400,
  };

  it("puts a profitable, spread-out trader in Steady with profit ÷ dip as score", () => {
    expect(classify(base, false)).toEqual({
      hidden: [],
      tabs: ["steady", "top", "long", "all"],
      steadyScore: "5",
    });
  });

  it("hides fast, thin, vault and low-coverage traders with every reason", () => {
    const c = classify(
      { ...base, typicalHoldMs: 5 * MIN, closedEpisodes: 12, coverage: "0.3" },
      true,
    );
    expect(c.hidden).toEqual(["few_trades", "fast", "vault", "low_coverage"]);
    expect(c.tabs).toEqual([]);
  });

  it("keeps Steady out when one trade makes most of the profit or profit is not positive", () => {
    expect(classify({ ...base, topTradeShare: "0.7" }, false).tabs).toEqual(["top", "long", "all"]);
    expect(classify({ ...base, profit: "-1" }, false).steadyScore).toBeNull();
  });

  it("keeps a trader liquidated in the last 30 days out of Steady, still in All", () => {
    const c = classify({ ...base, liquidations: 1 }, false);
    expect(c.tabs).toEqual(["top", "long", "all"]);
    expect(c.steadyScore).toBeNull();
  });

  it("shows history-incomplete traders only under All", () => {
    expect(classify({ ...base, historyIncomplete: true }, false).tabs).toEqual(["all"]);
  });

  it("requires a known typical hold of at least 15 minutes for minHold", () => {
    expect(meetsMinHold({ typicalHoldMs: LEADER_STATS.minHoldMs })).toBe(true);
    expect(meetsMinHold({ typicalHoldMs: LEADER_STATS.minHoldMs - 1 })).toBe(false);
    expect(meetsMinHold({ typicalHoldMs: null })).toBe(false);
  });
});

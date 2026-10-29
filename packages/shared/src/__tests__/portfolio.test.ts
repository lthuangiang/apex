import { describe, expect, it } from "vitest";

import { analyze } from "../portfolio/analyst";
import { balanceDeltas, reconcileBuilderDay } from "../portfolio/builder-revenue";
import { evaluateRisk, exceedsPerTrade, startOfDay } from "../portfolio/risk";
import { valuePortfolio } from "../portfolio/value";

describe("valuePortfolio", () => {
  // Số liệu thật của account trong UI_REVIEW I3 (mainnet, 2026-10-29): Multi-Asset Margin.
  const multiAsset = {
    av: "143.61",
    am: "123.49",
    ami: "101.62",
    im: "0",
    cm: "0",
    B: [
      { a: "WSOSO", wb: "130.2262", px: "0.30009", mr: "0.5", wm: "19.54" },
      { a: "vUSDC", wb: "101.6227", px: "1", mr: "1", wm: "101.62" },
      { a: "vQQQ", wb: "0.004045", px: "718.19", mr: "0.8", wm: "2.32" },
    ],
    P: [],
  };

  it("splits accounts by engine: perps uses am for cross and ami for isolated, collateral with USDC first", () => {
    const v = valuePortfolio([{ coin: "vUSDC", total: "101.84", locked: "0" }], multiAsset, {});
    expect(v.accounts.spot).toEqual({
      value: "101.84",
      available: "101.84",
      inOrders: "0",
      unpricedCoins: [],
    });
    expect(v.accounts.perps).toMatchObject({
      accountValue: "143.61",
      availableMargin: "123.49",
      availableIsolated: "101.62",
      marginInUse: "0",
      openPositions: 0,
    });
    expect(v.accounts.perps?.collateral.map((c) => c.asset)).toEqual(["vUSDC", "WSOSO", "vQQQ"]);
    expect(v.accounts.perps?.collateral[1]).toMatchObject({
      collateralRatio: "0.5",
      marginValue: "19.54",
    });
    // Tổng không đổi: equity = spot + perps; available = spot free + am.
    expect(v.equity).toBe("245.45");
    expect(v.available).toBe("225.33");
  });

  it("prices a spot coin without a market at the SoDEX index price of the same perps collateral", () => {
    const v = valuePortfolio(
      [
        { coin: "WSOSO", total: "10", locked: "0" },
        { coin: "vMAG7.ssi", total: "1", locked: "0" },
      ],
      multiAsset,
      {},
    );
    expect(v.indexPriced).toEqual(["WSOSO"]);
    expect(v.holdings[0]?.value).toBe("3.0009");
    expect(v.unpriced).toEqual(["vMAG7.ssi"]);
  });

  it("handles spot only, perps only and an empty collateral list", () => {
    expect(valuePortfolio([{ coin: "vUSDC", total: "5", locked: "1" }], null, {}).accounts).toEqual(
      {
        spot: { value: "5", available: "4", inOrders: "1", unpricedCoins: [] },
        perps: null,
      },
    );
    const onlyPerps = valuePortfolio([], { ...multiAsset, B: [], ami: null }, {});
    expect(onlyPerps.accounts.spot.value).toBe("0");
    expect(onlyPerps.accounts.perps).toMatchObject({ availableIsolated: null, collateral: [] });
  });

  it("counts isolated positions in the perps account value", () => {
    const v = valuePortfolio([], perps, {});
    expect(v.accounts.perps).toMatchObject({ accountValue: "1080", openPositions: 2 });
  });

  const perps = {
    av: "1000",
    am: "600",
    im: "50",
    cm: "150",
    P: [
      { s: "BTC-USD", m: "CROSS", sz: "0.1", iw: null, ep: "60000", ur: "120", l: 3, lp: "45000" },
      { s: "ETH-USD", m: "ISOLATED", sz: "-1", iw: "100", ep: "3000", ur: "-20", l: 2, lp: "0" },
    ],
  };
  it("values spot at last price, adds perps account value and isolated margin, never guesses missing prices", () => {
    const v = valuePortfolio(
      [
        { coin: "vUSDC", total: "500", locked: "100" },
        { coin: "vBTC", total: "0.01", locked: "0" },
        { coin: "WSOSO", total: "3", locked: "0" },
      ],
      perps,
      { vBTC_vUSDC: "61000", "BTC-USD": "61200" },
    );
    // 500 + 610 (spot) + 1000 (av) + 100 + (−20) (isolated) = 2190
    expect(v.equity).toBe("2190");
    expect(v.available).toBe("1000");
    expect(v.unpriced).toEqual(["WSOSO"]);
    expect(v.unrealizedPnl).toBe("100");
    expect(v.marginInUsePct).toBe("18.5185");
    expect(v.positions[1]).toMatchObject({
      side: "short",
      liquidationPrice: null,
      markPrice: null,
      notional: null,
      marginMode: "isolated",
    });
    expect(v.positions[0]?.notional).toBe("6120");
  });
});

describe("risk", () => {
  const H = 3_600_000;
  const now = Date.parse("2026-10-28T10:00:00Z"); // 17:00 UTC+7
  it("starts the day at midnight in the user's time zone", () => {
    expect(new Date(startOfDay(now, "Asia/Ho_Chi_Minh")).toISOString()).toBe(
      "2026-10-27T17:00:00.000Z",
    );
    expect(new Date(startOfDay(now, "UTC")).toISOString()).toBe("2026-10-28T00:00:00.000Z");
  });

  it("measures daily loss from the day's opening equity and drawdown from the 30-day peak", () => {
    const pts = [
      { at: now - 20 * 24 * H, equity: "12000" },
      { at: Date.parse("2026-10-27T16:59:00Z"), equity: "10000" },
      { at: now - H, equity: "9800" },
      { at: now, equity: "9650" },
    ];
    const r = evaluateRisk(
      { dailyLossPct: "3", maxDrawdownPct: "25" },
      pts,
      now,
      "Asia/Ho_Chi_Minh",
    );
    expect(r.dailyLossPct).toBe("3.5");
    expect(r.drawdownPct).toBe("19.5833");
    expect(r.breaches).toEqual(["daily_loss"]);
    expect(
      evaluateRisk({ dailyLossPct: null, maxDrawdownPct: null }, [], now, "UTC").equity,
    ).toBeNull();
  });

  it("checks per-trade notional against equity", () => {
    expect(exceedsPerTrade("101", "10000", "1")).toBe(true);
    expect(exceedsPerTrade("100", "10000", "1")).toBe(false);
    expect(exceedsPerTrade("1e6", "10000", null)).toBe(false);
  });
});

describe("builder revenue reconciliation", () => {
  it("matches days where the balance grew exactly by the fill fees and holds the rest pending", () => {
    const deltas = balanceDeltas([
      { date: "2026-10-22", engine: "perps", balance: "100" },
      { date: "2026-10-23", engine: "perps", balance: "185.02" },
      { date: "2026-10-24", engine: "perps", balance: "264.12" },
    ]);
    expect(
      reconcileBuilderDay({
        date: "2026-10-23",
        engine: "perps",
        fromFills: "85.02",
        balanceDelta: deltas.get("2026-10-23:perps") ?? null,
      }),
    ).toMatchObject({
      status: "matched",
      difference: "0",
      recognized: "85.02",
    });
    expect(
      reconcileBuilderDay({
        date: "2026-10-24",
        engine: "perps",
        fromFills: "77.9",
        balanceDelta: deltas.get("2026-10-24:perps") ?? null,
      }),
    ).toMatchObject({
      status: "pending",
      difference: "1.2",
      recognized: "77.9",
    });
    expect(
      reconcileBuilderDay({
        date: "2026-10-25",
        engine: "spot",
        fromFills: "3",
        balanceDelta: null,
      }),
    ).toMatchObject({ status: "pending", recognized: "0" });
    expect(
      reconcileBuilderDay({
        date: "2026-10-26",
        engine: "spot",
        fromFills: "3",
        balanceDelta: "2.5",
      }).recognized,
    ).toBe("2.5");
  });
});

describe("analyst", () => {
  it("separates observed data, interpretation and a check, and never forecasts", () => {
    const now = Date.parse("2026-10-28T07:00:00Z");
    const portfolio = valuePortfolio(
      [],
      {
        av: "40000",
        am: "0",
        im: "0",
        cm: "0",
        P: [
          { s: "BTC-USD", m: "CROSS", sz: "0.5", iw: null, ep: "60000", ur: "0", l: 1, lp: "0" },
          { s: "ETH-USD", m: "CROSS", sz: "-1", iw: null, ep: "3000", ur: "0", l: 1, lp: "0" },
        ],
      },
      { "BTC-USD": "67219.12", "ETH-USD": "4130.88" },
    );
    const out = analyze({
      now,
      portfolio,
      portfolioAt: now,
      bots: [
        {
          id: "a",
          name: "Grid · ADA",
          state: "running",
          needsAttention: false,
          attentionSince: null,
          netPnl: "-0.748",
          fees: "0.59",
          fills: 14,
          firstFillAt: now - 3 * 86_400_000,
          quote: "USDT",
        },
        {
          id: "b",
          name: "Grid · BTC",
          state: "running",
          needsAttention: true,
          attentionSince: now - 4 * 3_600_000,
          netPnl: "0",
          fees: "0",
          fills: 3,
          firstFillAt: now - 6 * 86_400_000,
          quote: "USDC",
        },
      ],
      limitsBreached: 0,
    });
    expect(out.briefing).toBe("2 bots are running and 0 paused. All server-enforced limits pass.");
    expect(out.insights.map((i) => i.id)).toEqual(["concentration", "fees:a", "attention:b"]);
    expect(out.insights[0]?.observed).toBe(
      "BTC-USD long is 33,609.56 of 37,740.44 USDC gross exposure (89%).",
    );
    expect(out.notEnough?.progress).toBe("3 of 14 days");
    expect(JSON.stringify(out)).not.toMatch(/will (rise|fall)|expected return|forecast/i);
  });
});

describe("analyst wording", () => {
  it("uses singular nouns for one and the profile time zone without a UTC suffix", () => {
    const now = Date.parse("2026-10-29T06:39:22Z");
    const out = analyze({
      now,
      portfolio: null,
      portfolioAt: now,
      timeZone: "Asia/Ho_Chi_Minh",
      bots: [
        {
          id: "a",
          name: "BNB Futures Grid",
          state: "running",
          needsAttention: false,
          attentionSince: null,
          netPnl: "-0.30",
          fees: "0.20",
          fills: 1,
          firstFillAt: now - 86_400_000,
          quote: "USDC",
        },
      ],
      limitsBreached: null,
    });
    expect(out.insights[0]?.observed).toBe(
      "Profit -0.3000 USDC over 1 day. 1 fill paid 0.2000 USDC in fees.",
    );
    expect(out.briefing).toBe("1 bot is running and 0 paused.");
    expect(out.basis).toBe("Based on data as of Oct 29, 13:39:22 · 0 positions, 1 bot");
  });
});

describe("dust balances", () => {
  it("prints dust balances as plain decimals, so decimal-string schemas accept them", () => {
    const v = valuePortfolio([{ coin: "vUSDC", total: "0.000000247775", locked: "0" }], null, {});
    expect(v.holdings[0]?.total).toBe("0.000000247775");
    expect(v.equity).toBe("0.000000247775");
  });
});

import { describe, expect, it } from "vitest";

import { backtest, type BacktestData, type Candle } from "../backtest";

const RULES = { tickSize: "0.01", stepSize: "0.0001", minQuantity: "0.0001", minNotional: "1" };
const FEES = {
  spot: { maker: "0.0004", taker: "0.0007" },
  perps: { maker: "0.00015", taker: "0.00045" },
  builder: "0.0005",
};
const MIN = 60_000;
const T0 = Date.UTC(2026, 6, 1);

const candle = (i: number, o: number, h: number, l: number, c: number): Candle => ({
  t: T0 + i * MIN,
  o: o.toFixed(2),
  h: h.toFixed(2),
  l: l.toFixed(2),
  c: c.toFixed(2),
});
const data = (
  candles: Candle[],
  engine: "spot" | "perps" = "spot",
  market = "vBTC_vUSDC",
  funding: BacktestData["funding"] = {},
): BacktestData => ({
  markets: { [market]: { engine, candles, rules: RULES } },
  funding,
  fees: FEES,
  slippage: "0.0005",
  intervalMs: MIN,
});

const grid = {
  market: "vBTC_vUSDC",
  lowerPrice: "90",
  upperPrice: "110",
  gridLevels: 5,
  spacing: "arithmetic",
  investment: "1000",
  maxLoss: "500",
  onStop: "keep_base",
};

describe("backtest fill model", () => {
  it("fills the opening market order at the next candle open plus slippage, with taker fee and no builder fee on spot buys", () => {
    const r = backtest(
      "spot_grid",
      grid,
      data([candle(0, 100, 100, 100, 100), candle(1, 101, 101, 101, 101)]),
    );
    const init = r.output.fills.find((f) => f.tag === "grid:init");
    expect(init?.price).toBe("101.0505");
    // taker 0.07%, không có builder fee ở chiều mua Spot.
    expect(Number(init?.fee)).toBeCloseTo(Number(init?.price) * Number(init?.quantity) * 0.0007, 8);
  });

  it("fills limit orders only when price trades through the level, never in the candle that placed them", () => {
    // Nến 0 đặt lưới (mua ở 95, 90; bán ở 105, 110). Nến 2 chạm đúng 95: không khớp. Nến 3 xuyên 95: khớp.
    const candles = [
      candle(0, 100, 100, 100, 100),
      candle(1, 100, 100, 100, 100),
      candle(2, 100, 100, 95, 97),
      candle(3, 97, 97, 94.99, 96),
    ];
    const r = backtest("spot_grid", grid, data(candles));
    const buys = r.output.fills.filter((f) => f.tag !== "grid:init" && f.side === "buy");
    expect(buys).toHaveLength(1);
    expect(buys[0]?.price).toBe("95");
    expect(buys[0]?.at).toBe(T0 + 3 * MIN);
    expect(buys[0]?.maker).toBe(true);
  });

  it("charges the builder fee on spot sells", () => {
    const candles = [
      candle(0, 100, 100, 100, 100),
      candle(1, 100, 100, 100, 100),
      candle(2, 100, 106, 100, 104),
    ];
    const sell = backtest("spot_grid", grid, data(candles)).output.fills.find(
      (f) => f.side === "sell",
    );
    expect(sell?.price).toBe("105");
    expect(Number(sell?.fee)).toBeCloseTo(105 * Number(sell?.quantity) * (0.0004 + 0.0005), 8);
  });

  it("pays funding on perps positions and reports it separately", () => {
    const fgrid = {
      ...grid,
      market: "BTC-USD",
      leverage: 1,
      marginMode: "isolated",
      direction: "short",
      margin: "1000",
      stopBelow: "1",
      onStop: "close_at_market",
      investment: undefined,
    };
    const candles = Array.from({ length: 10 }, (_, i) => candle(i, 100, 100.5, 99.5, 100));
    const r = backtest(
      "futures_grid",
      fgrid,
      data(candles, "perps", "BTC-USD", { "BTC-USD": [{ at: T0 + 5 * MIN, rate: "0.0001" }] }),
    );
    const short = r.output.positions["BTC-USD"] ?? "0";
    expect(Number(short)).toBeLessThan(0);
    // Short nhận funding khi rate dương: funding (trả) âm.
    expect(Number(r.funding)).toBeLessThan(0);
    expect(r.metrics.map((m) => m.key)).toEqual(["fills", "timeInRange"]);
  });

  it("is deterministic and reports drawdown, equity and grid metrics", () => {
    const candles = Array.from({ length: 600 }, (_, i) => {
      const p = 100 + 8 * Math.sin(i / 30);
      return candle(i, p, p + 0.6, p - 0.6, p + 0.1);
    });
    const a = backtest("spot_grid", grid, data(candles));
    const b = backtest("spot_grid", grid, data(candles));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.candles).toBe(600);
    expect(Number(a.metrics.find((m) => m.key === "fills")?.value)).toBeGreaterThan(5);
    expect(a.metrics.find((m) => m.key === "timeInRange")?.value).toBe("100");
    expect(Number(a.maxDrawdown)).toBeGreaterThanOrEqual(0);
    expect(a.equity.length).toBeLessThanOrEqual(201);
  });

  it("stops with the strategy's stop loss and closes the position", () => {
    const dca = {
      market: "vBTC_vUSDC",
      baseOrder: "100",
      safetyOrder: "100",
      maxSafetyOrders: 1,
      firstStepPct: "1",
      stepMultiplier: "1",
      sizeMultiplier: "1",
      takeProfitPct: "2",
      start: "immediately",
      stopLossPct: "5",
    };
    const candles = [
      candle(0, 100, 100, 100, 100),
      candle(1, 100, 100, 100, 100),
      ...Array.from({ length: 10 }, (_, i) => candle(i + 2, 100 - i, 100 - i, 99 - i, 99 - i)),
    ];
    const r = backtest("spot_dca", dca, data(candles));
    expect(r.halted).toBe("STOP_LOSS");
    expect(r.output.fills.at(-1)?.tag).toBe("close");
    expect(r.output.positions.vBTC_vUSDC).toBe("0");
  });

  it("runs 90 days of one-minute candles well under 20 s", () => {
    const n = 90 * 24 * 60;
    const candles = Array.from({ length: n }, (_, i) => {
      const p = 100 + 9 * Math.sin(i / 700) + Math.sin(i / 13);
      return candle(i, p, p + 0.3, p - 0.3, p + 0.05);
    });
    const started = Date.now();
    const r = backtest("spot_grid", { ...grid, gridLevels: 20 }, data(candles));
    const ms = Date.now() - started;
    expect(r.candles).toBe(n);
    expect(ms).toBeLessThan(20_000);
  }, 60_000);
});

import { describe, expect, it } from "vitest";

import { runBacktest, type Candle } from "../backtest";
import type { OrderIntent, StrategyModule } from "../core/types";

// #363: tuỳ chọn mô hình khớp limit của backtest. Mặc định "through": giá phải đi xuyên qua mức đặt. "touch": chạm mức đặt
// là khớp. Lệnh đặt ở timer của nến 0, nến 1 chạm đúng mức đặt rồi quay lại.

const RULES = { tickSize: "0.01", stepSize: "0.0001", minQuantity: "0.0001", minNotional: "1" };
const FEES = {
  spot: { maker: "0.0004", taker: "0.0007" },
  perps: { maker: "0.00015", taker: "0.00045" },
  builder: "0.0001",
};
const MIN = 60_000;
const T0 = Date.UTC(2026, 6, 1);
const M = "BTC-USD";

const candle = (i: number, o: number, h: number, l: number, c: number): Candle => ({
  t: T0 + i * MIN,
  o: o.toFixed(2),
  h: h.toFixed(2),
  l: l.toFixed(2),
  c: c.toFixed(2),
});

const limit = (side: "buy" | "sell", price: string): OrderIntent => ({
  clOrdID: `l-${side}`,
  market: M,
  engine: "perps",
  side,
  type: "limit",
  price,
  quantity: "1",
  timeInForce: "GTC",
  reduceOnly: false,
  tag: `l-${side}`,
});

/** Đặt một lệnh limit ở timer đầu tiên, không làm gì khác. */
const once = (o: OrderIntent): StrategyModule<null, { done: boolean }> => ({
  initialState: () => ({ done: false }),
  step: (_c, state, event) =>
    event.type !== "timer" || state.done
      ? { state, actions: [] }
      : { state: { done: true }, actions: [{ type: "place" as const, order: o }] },
});

function run(o: OrderIntent, candles: Candle[], limitFill?: "through" | "touch") {
  return runBacktest({
    module: once(o),
    config: null,
    markets: { [M]: { engine: "perps", candles, rules: RULES } },
    funding: {},
    fees: FEES,
    slippage: "0",
    intervalMs: MIN,
    capital: "10000",
    ...(limitFill === undefined ? {} : { limitFill }),
  });
}

const flat = candle(0, 100, 100, 100, 100);

describe("backtest limit fill model", () => {
  it("default needs price to trade through a buy limit; touch fills at the touch", () => {
    const touchLow = [flat, candle(1, 100, 100.5, 99, 100), candle(2, 100, 100, 100, 100)];
    expect(run(limit("buy", "99"), touchLow).fills).toHaveLength(0);
    expect(run(limit("buy", "99"), touchLow, "through").fills).toHaveLength(0);
    const f = run(limit("buy", "99"), touchLow, "touch").fills;
    expect(f).toHaveLength(1);
    expect(f[0]?.price).toBe("99");
    expect(f[0]?.maker).toBe(true);
  });

  it("same for a sell limit at the high", () => {
    const touchHigh = [flat, candle(1, 100, 101, 99.5, 100), candle(2, 100, 100, 100, 100)];
    expect(run(limit("sell", "101"), touchHigh).fills).toHaveLength(0);
    expect(run(limit("sell", "101"), touchHigh, "touch").fills).toHaveLength(1);
  });

  it("both models fill when price trades through, and neither fills when price stays away", () => {
    const through = [flat, candle(1, 100, 100.5, 98.5, 100), candle(2, 100, 100, 100, 100)];
    expect(run(limit("buy", "99"), through).fills).toHaveLength(1);
    expect(run(limit("buy", "99"), through, "touch").fills).toHaveLength(1);
    const away = [flat, candle(1, 100, 100.5, 99.5, 100), candle(2, 100, 100, 100, 100)];
    expect(run(limit("buy", "99"), away, "touch").fills).toHaveLength(0);
  });
});

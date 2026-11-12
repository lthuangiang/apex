import { describe, expect, it } from "vitest";

import {
  copyNet,
  copyPositions,
  copyTrade,
  normalizeCopyState,
  type CopyTradeState,
} from "../copy-trade";
import { copyTradeSchema, type CopyTradeConfig } from "../copy-trade/schema";
import type { OrderIntent, StepContext, StrategyAction, StrategyEvent } from "../core/types";

// DEC-163 mục 6, 9: một bot copy một trader trên nhiều market; trần exposure / max loss tính tổng; hạn mức phân bổ.

const LEADER = "0x2222222222222222222222222222222222222222";
const rules = { tickSize: "0.01", stepSize: "0.0001", minQuantity: "0.0001", minNotional: "10" };
const ctx: StepContext = {
  botId: "copy-multi",
  version: 1,
  rules: { "BTC-USD": rules, "ETH-USD": rules },
  feeRate: "0.0002",
};
const T0 = Date.parse("2026-11-11T00:00:00Z");

const cfg = (over: Record<string, unknown> = {}): CopyTradeConfig =>
  copyTradeSchema.parse({
    leaderSource: "hyperliquid",
    leaderAddress: LEADER,
    markets: ["BTC-USD", "ETH-USD"],
    leverage: 2,
    fixedNotional: "1000",
    maxNotionalPerTrade: "1000",
    maxExposure: "1500",
    maxLoss: "100",
    ...over,
  });

const step = (c: CopyTradeConfig, s: CopyTradeState, e: StrategyEvent) =>
  copyTrade.step(c, s, e, ctx);
const tick = (market: string, price: string, at = T0 - 1000): StrategyEvent => ({
  type: "tick",
  at,
  market,
  price,
});
const lf = (
  market: string,
  positionAfter: string,
  price: string,
  extra: Partial<StrategyEvent> = {},
): StrategyEvent =>
  ({
    type: "leaderFill",
    at: T0 + 300,
    leaderAt: T0,
    market,
    side: positionAfter.startsWith("-") ? "sell" : "buy",
    price,
    quantity: positionAfter.replace("-", ""),
    positionAfter,
    ...extra,
  }) as StrategyEvent;
const places = (a: readonly StrategyAction[]): OrderIntent[] =>
  a.flatMap((x) => (x.type === "place" ? [x.order] : []));
const logs = (a: readonly StrategyAction[]) =>
  a.flatMap((x) => (x.type === "log" ? [`${x.decision}: ${x.why}`] : []));

const first = (a: readonly StrategyAction[]): OrderIntent => {
  const [o] = places(a);
  if (o === undefined) throw new Error("no order");
  return o;
};

function fill(c: CopyTradeConfig, s: CopyTradeState, o: OrderIntent, price: string) {
  const f = step(c, s, {
    type: "fill",
    at: T0 + 500,
    clOrdID: o.clOrdID,
    price,
    quantity: o.quantity,
    fee: "0",
  });
  return step(c, f.state, { type: "orderDone", at: T0 + 600, clOrdID: o.clOrdID });
}

function priced(c = cfg()): CopyTradeState {
  let s = copyTrade.initialState(c);
  s = step(c, s, tick("BTC-USD", "100000")).state;
  return step(c, s, tick("ETH-USD", "2000")).state;
}

describe("copy trade across markets", () => {
  it("parses old single-market configs and rejects duplicates", () => {
    expect(cfg({ markets: undefined, market: "BTC-USD" }).markets).toEqual(["BTC-USD"]);
    expect(() => cfg({ markets: ["BTC-USD", "BTC-USD"] })).toThrow();
    expect(() => cfg({ markets: [] })).toThrow();
  });

  it("copies each market on its own book and routes fills back by order", () => {
    const c = cfg();
    let s = priced(c);
    const a = step(c, s, lf("BTC-USD", "1", "100000"));
    const btc = first(a.actions);
    expect(btc).toMatchObject({ market: "BTC-USD", side: "buy", quantity: "0.01" });
    s = fill(c, a.state, btc, "100000").state;
    const b = step(c, s, lf("ETH-USD", "-10", "2000"));
    const eth = first(b.actions);
    expect(eth.market).toBe("ETH-USD");
    expect(eth.clOrdID).not.toBe(btc.clOrdID);
    s = fill(c, b.state, eth, "2000").state;
    expect(copyPositions(s)).toEqual({ "BTC-USD": "0.01", "ETH-USD": "-0.25" });
  });

  it("ignores leader moves on markets the bot doesn't copy", () => {
    const r = step(cfg(), priced(), lf("SOL-USD", "5", "150"));
    expect(r.actions).toEqual([]);
  });

  it("applies maxExposure to the total of all markets", () => {
    const c = cfg();
    let s = priced(c);
    const a = step(c, s, lf("BTC-USD", "1", "100000"));
    s = fill(c, a.state, first(a.actions), "100000").state;
    // 1.000 USD dùng ở BTC → ETH chỉ còn 500.
    const b = step(c, s, lf("ETH-USD", "10", "2000"));
    expect(places(b.actions)[0]?.quantity).toBe("0.25");
  });

  it("stops when the loss of all markets together reaches maxLoss", () => {
    const c = cfg({ maxExposure: "2000" });
    let s = priced(c);
    const a = step(c, s, lf("BTC-USD", "1", "100000"));
    s = fill(c, a.state, first(a.actions), "100000").state;
    const b = step(c, s, lf("ETH-USD", "10", "2000"));
    s = fill(c, b.state, first(b.actions), "2000").state;
    // BTC −5% (−50), ETH −2,5% (−25): chưa tới 100.
    s = step(c, s, tick("BTC-USD", "95000", T0 + 1000)).state;
    s = step(c, s, tick("ETH-USD", "1950", T0 + 1000)).state;
    expect(s.phase).toBe("following");
    // ETH thêm −2,5%: tổng −100 → dừng và đóng.
    const r = step(c, s, tick("ETH-USD", "1900", T0 + 2000));
    expect(r.actions.some((x) => x.type === "stop")).toBe(true);
    expect(copyNet(r.state).toString()).toBe("-100");
  });

  it("cuts an opening order to the liquidity allowance and says why", () => {
    const r = step(
      cfg(),
      priced(),
      lf("BTC-USD", "1", "100000", { allowance: "400", allowanceReason: "liquidity" }),
    );
    expect(places(r.actions)[0]?.quantity).toBe("0.004");
    expect(logs(r.actions)[0]).toMatch(/cut to 400 USD/);
  });

  it("skips opens while the trader fails minHold, but still follows a close", () => {
    const c = cfg();
    let s = priced(c);
    const a = step(c, s, lf("BTC-USD", "1", "100000"));
    s = fill(c, a.state, first(a.actions), "100000").state;
    const blocked = step(
      c,
      s,
      lf("ETH-USD", "10", "2000", { allowance: "0", allowanceReason: "min_hold" }),
    );
    expect(places(blocked.actions)).toEqual([]);
    expect(logs(blocked.actions)[0]).toMatch(/too fast to copy/);
    const close = step(
      c,
      blocked.state,
      lf("BTC-USD", "0", "100000", { allowance: "0", allowanceReason: "min_hold" }),
    );
    expect(places(close.actions)[0]).toMatchObject({
      market: "BTC-USD",
      reduceOnly: true,
      quantity: "0.01",
    });
  });

  it("reads a pre-DEC-163 single-market state into the BTC slot", () => {
    const old = {
      phase: "following",
      ledger: { position: "0.01", avgCost: "100000", realized: "0", fees: "0", funding: "0" },
      lastPrice: "100000",
      leaderPos: "1",
      tracking: true,
      target: "0.01",
      refPrice: null,
      refAt: 0,
      inflight: null,
      orders: { abc: { side: "buy", kind: "open" } },
      seq: 3,
      reduceAttempts: 0,
      openRejects: 0,
      signals: 1,
      copied: 1,
      skipped: 0,
      lastLatencyMs: 300,
      lastLeaderAt: T0,
    };
    const s = normalizeCopyState(cfg({ markets: ["BTC-USD"] }), old);
    expect(s.markets["BTC-USD"]?.ledger.position).toBe("0.01");
    expect(s.orders.abc).toEqual({ side: "buy", kind: "open", market: "BTC-USD" });
    expect(s.seq).toBe(3);
  });
});

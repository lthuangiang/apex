import { describe, expect, it } from "vitest";

import type { StepContext, StrategyAction, StrategyEvent } from "../core/types";
import { costPerMillion, volumeMaker, type VolumeMakerState } from "../volume-maker";
import { volumeMakerSchema, type VolumeMakerConfig } from "../volume-maker/schema";

const ctx: StepContext = {
  botId: "vm-bot",
  version: 1,
  rules: {
    "BTC-USD": { tickSize: "0.1", stepSize: "0.0001", minQuantity: "0.0001", minNotional: "5" },
  },
  feeRate: "0.00065",
};
const cfg = (over: Partial<VolumeMakerConfig> = {}): VolumeMakerConfig =>
  volumeMakerSchema.parse({
    market: "BTC-USD",
    leverage: 1,
    volumeTarget: "100000",
    orderSize: "500",
    distanceBp: "1",
    maxInventory: "2000",
    refreshSeconds: 3,
    runUntil: "target_or_budget",
    costBudget: "300",
    inventoryLossStop: "60",
    onStop: "close_inventory",
    ...over,
  });

function run(c: VolumeMakerConfig, events: StrategyEvent[]) {
  let s: VolumeMakerState = volumeMaker.initialState(c);
  const all: StrategyAction[] = [];
  for (const e of events) {
    const r = volumeMaker.step(c, s, e, ctx);
    s = r.state;
    all.push(...r.actions);
  }
  return { s, all };
}
const places = (a: StrategyAction[]) => a.flatMap((x) => (x.type === "place" ? [x.order] : []));

describe("volume maker", () => {
  it("validates the documented field rules", () => {
    const msgs = (v: unknown) =>
      volumeMakerSchema.safeParse(v).error?.issues.map((i) => i.message) ?? [];
    expect(msgs({ ...cfg(), leverage: 2, refreshSeconds: 1 })).toEqual(
      expect.arrayContaining(["Volume Maker runs at 1×.", "Allowed 2–60 s."]),
    );
    expect(msgs({ ...cfg(), maxInventory: "400", inventoryLossStop: "400" })).toEqual(
      expect.arrayContaining(["Must be above the order size.", "Must be below the budget."]),
    );
  });

  it("quotes both sides post-only around the price and refreshes only after the interval", () => {
    const c = cfg();
    const { all } = run(c, [
      { type: "tick", at: 0, market: "BTC-USD", price: "100000" },
      { type: "timer", at: 1000 },
      { type: "timer", at: 3000 },
    ]);
    const o = places(all);
    expect(o.map((x) => `${x.side}@${x.price ?? ""}:${x.timeInForce}`)).toEqual([
      "buy@99990:GTX",
      "sell@100010:GTX",
      "buy@99990:GTX",
      "sell@100010:GTX",
    ]);
    expect(o.every((x) => x.type === "limit" && !x.reduceOnly)).toBe(true);
    // Lần làm mới huỷ hai báo giá cũ trước.
    expect(all.filter((x) => x.type === "cancel")).toHaveLength(2);
  });

  it("skews away from inventory above 50% and quotes only the reducing side at 100%", () => {
    const c = cfg();
    const half = run(c, [
      { type: "tick", at: 0, market: "BTC-USD", price: "100000" },
      { type: "fill", at: 1, clOrdID: "x", price: "1", quantity: "0", fee: "0" },
    ]);
    let s = half.s;
    // Mua 0.012 BTC (= 1,200 USDC, 60% của max 2,000) qua báo giá bid.
    s = volumeMaker.step(
      c,
      s,
      { type: "fill", at: 2, clOrdID: s.bid ?? "", price: "99990", quantity: "0.012", fee: "0.18" },
      ctx,
    ).state;
    let r = volumeMaker.step(c, s, { type: "timer", at: 5000 }, ctx);
    expect(places(r.actions).map((x) => `${x.side}@${x.price ?? ""}`)).toEqual([
      "buy@99980",
      "sell@100010",
    ]);
    s = r.state;
    s = volumeMaker.step(
      c,
      s,
      {
        type: "fill",
        at: 6000,
        clOrdID: s.bid ?? "",
        price: "99980",
        quantity: "0.009",
        fee: "0.13",
      },
      ctx,
    ).state;
    r = volumeMaker.step(c, s, { type: "timer", at: 9000 }, ctx);
    expect(places(r.actions).map((x) => x.side)).toEqual(["sell"]);
  });

  it("warns at 80% of the cost budget and stops at 100%, closing inventory reduce-only", () => {
    const c = cfg({ costBudget: "10", inventoryLossStop: "5" });
    let { s } = run(c, [{ type: "tick", at: 0, market: "BTC-USD", price: "100000" }]);
    let r = volumeMaker.step(
      c,
      s,
      { type: "fill", at: 1, clOrdID: s.bid ?? "", price: "99990", quantity: "0.005", fee: "8.2" },
      ctx,
    );
    expect(r.actions).toEqual(expect.arrayContaining([{ type: "flag", needsAttention: true }]));
    s = r.state;
    r = volumeMaker.step(
      c,
      s,
      { type: "fill", at: 2, clOrdID: s.ask ?? "", price: "100010", quantity: "0.001", fee: "2" },
      ctx,
    );
    const stop = r.actions.find((x) => x.type === "stop");
    expect(stop).toEqual({ type: "stop", reason: "BUDGET_DONE", close: false });
    const close = places(r.actions)[0];
    expect(close).toMatchObject({
      side: "sell",
      type: "market",
      reduceOnly: true,
      quantity: "0.004",
    });
    expect(costPerMillion(r.state)).not.toBeNull();
  });

  it("stops at the inventory loss limit and when the volume target is reached", () => {
    const c = cfg({ inventoryLossStop: "5", onStop: "keep_position" });
    let { s } = run(c, [{ type: "tick", at: 0, market: "BTC-USD", price: "100000" }]);
    s = volumeMaker.step(
      c,
      s,
      { type: "fill", at: 1, clOrdID: s.bid ?? "", price: "99990", quantity: "0.005", fee: "0" },
      ctx,
    ).state;
    const r = volumeMaker.step(
      c,
      s,
      { type: "tick", at: 2, market: "BTC-USD", price: "98000" },
      ctx,
    );
    expect(r.actions.find((x) => x.type === "stop")).toMatchObject({ reason: "STOP_LOSS" });
    expect(places(r.actions)).toHaveLength(0);

    const t = cfg({ volumeTarget: "400" });
    let s2 = run(t, [{ type: "tick", at: 0, market: "BTC-USD", price: "100000" }]).s;
    const r2 = volumeMaker.step(
      t,
      s2,
      { type: "fill", at: 1, clOrdID: s2.ask ?? "", price: "100010", quantity: "0.005", fee: "0" },
      ctx,
    );
    s2 = r2.state;
    expect(r2.actions.find((x) => x.type === "stop")).toMatchObject({ reason: "MAX_CYCLES" });
  });

  it("counts quotes the engine blocked as self-trades", () => {
    const c = cfg();
    const { s } = run(c, [{ type: "tick", at: 0, market: "BTC-USD", price: "100000" }]);
    const r = volumeMaker.step(
      c,
      s,
      { type: "orderReject", at: 1, clOrdID: s.bid ?? "", code: "SELF_TRADE_BLOCKED" },
      ctx,
    );
    expect(r.state.selfTradeBlocked).toBe(1);
    expect(r.state.bid).toBeNull();
  });
});

describe("volume maker backtest", () => {
  it("reports volume, net cost, maker share and max inventory, and fills only as maker", async () => {
    const { backtest } = await import("../backtest");
    const MIN = 60_000;
    const T0 = Date.UTC(2026, 6, 1);
    const candles = Array.from({ length: 300 }, (_, i) => {
      const p = 100000 + 60 * Math.sin(i / 7);
      return {
        t: T0 + i * MIN,
        o: p.toFixed(1),
        h: (p + 25).toFixed(1),
        l: (p - 25).toFixed(1),
        c: (p + 5).toFixed(1),
      };
    });
    const r = backtest("volume_maker", cfg({ costBudget: "1000", inventoryLossStop: "500" }), {
      markets: {
        "BTC-USD": {
          engine: "perps",
          candles,
          rules: ctx.rules["BTC-USD"] ?? {
            tickSize: "0.1",
            stepSize: "0.0001",
            minQuantity: "0.0001",
            minNotional: "5",
          },
        },
      },
      funding: {},
      fees: {
        spot: { maker: "0.0004", taker: "0.0007" },
        perps: { maker: "0.00015", taker: "0.00045" },
        builder: "0.0005",
      },
      slippage: "0.0005",
      intervalMs: MIN,
    });
    const m = Object.fromEntries(r.metrics.map((x) => [x.key, x.value]));
    expect(Number(m.volumeMade)).toBeGreaterThan(0);
    expect(m.makerShare).toBe("100");
    expect(m.maxInventory).not.toBeNull();
    expect(r.output.fills.filter((f) => f.tag !== "close").every((f) => f.maker)).toBe(true);
  });
});

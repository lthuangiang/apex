import { ReasonCode } from "@drift/shared";
import { describe, expect, it } from "vitest";

import { runSim } from "../sim/exchange";
import { spotGrid } from "../spot-grid";
import { spotGridSchema, type SpotGridConfig } from "../spot-grid/schema";

const ctx = {
  botId: "bot-1",
  version: 1,
  feeRate: "0.0005",
  rules: {
    vBTC_vUSDC: { tickSize: "1", stepSize: "0.0001", minQuantity: "0.0001", minNotional: "5" },
  },
};
const fees = { makerFee: "0", takerFee: "0" };
const base: SpotGridConfig = spotGridSchema.parse({
  market: "vBTC_vUSDC",
  lowerPrice: "90",
  upperPrice: "110",
  gridLevels: 5,
  spacing: "arithmetic",
  investment: "500",
  maxLoss: "100",
  onStop: "keep_base",
});
const ticks = (prices: number[]) =>
  prices.map((p, i) => ({ at: i * 1000, price: String(p), market: "vBTC_vUSDC" }));

describe("spot grid", () => {
  it("starts with a market buy for the sells, buys below and sells above", () => {
    // Mức: 90, 95, 100, 105, 110. Giá 100 → mua ở 90, 95; bán ở 105, 110. Khối lượng = 500/5/100 = 1.
    const r = runSim(spotGrid, base, ctx, ticks([100]), fees);
    const places = r.actions.flatMap((a) => (a.type === "place" ? [a.order] : []));
    expect(places[0]).toMatchObject({
      type: "market",
      side: "buy",
      quantity: "2",
      tag: "grid:init",
    });
    expect(
      places.filter((o) => o.side === "buy" && o.type === "limit").map((o) => o.price),
    ).toEqual(["90", "95"]);
    expect(places.filter((o) => o.side === "sell").map((o) => o.price)).toEqual(["105", "110"]);
    expect(r.state.phase).toBe("running");
  });

  it("re-places the opposite order one level away after each fill and books grid profit", () => {
    // 100 → 95 (mua 95 khớp → bán 100) → 100 (bán 100 khớp → mua 95)
    const r = runSim(spotGrid, base, ctx, ticks([100, 95, 100]), fees);
    const tags = r.exchange.fills.map((f) => f.tag);
    expect(tags).toEqual(["grid:init", "grid:1:buy", "grid:2:sell"]);
    expect([...r.exchange.open.values()].map((o) => `${o.side}@${o.price ?? ""}`).sort()).toEqual(
      ["buy@90", "buy@95", "sell@105", "sell@110"].sort(),
    );
    // Mua 95 bán 100 trên 1 đơn vị: lãi đã chốt 5 (giá vốn bình quân: 3 đơn vị @ (2×100+95)/3).
    expect(Number(r.state.ledger.realized)).toBeCloseTo(100 - (2 * 100 + 95) / 3, 10);
  });

  it("uses unique client order ids across repeated fills at the same level", () => {
    const r = runSim(spotGrid, base, ctx, ticks([100, 95, 100, 95, 100]), fees);
    const ids = r.actions.flatMap((a) => (a.type === "place" ? [a.order.clOrdID] : []));
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => /^[0-9a-zA-Z_-]{1,36}$/.test(id))).toBe(true);
  });

  it("flags needs_attention outside the range without pausing", () => {
    const r = runSim(spotGrid, base, ctx, ticks([100, 115, 100]), fees);
    expect(r.actions.filter((a) => a.type === "flag")).toEqual([
      { type: "flag", needsAttention: true },
      { type: "flag", needsAttention: false },
    ]);
    expect(r.halted).toBeNull();
  });

  it("stops at the stop price and cancels its orders", () => {
    const r = runSim(spotGrid, { ...base, stopPrice: "85" }, ctx, ticks([100, 84]), fees);
    expect(r.halted).toEqual({ type: "stop", reason: ReasonCode.stopLoss, close: false });
    expect(r.actions.filter((a) => a.type === "cancel").length).toBeGreaterThan(0);
    expect(r.exchange.open.size).toBe(0);
  });

  it("stops on take profit", () => {
    // Lãi chốt 5 − ... với TP 0.5% của 500 = 2.5
    const r = runSim(spotGrid, { ...base, takeProfitPct: "0.5" }, ctx, ticks([100, 95, 100]), fees);
    expect(r.halted).toEqual({ type: "stop", reason: ReasonCode.takeProfit, close: false });
  });

  it("pauses on max loss and keeps open orders", () => {
    const r = runSim(spotGrid, { ...base, maxLoss: "10" }, ctx, ticks([100, 95, 91, 89]), fees);
    expect(r.halted).toEqual({ type: "pause", reason: ReasonCode.botMaxLoss });
    expect(r.actions.some((a) => a.type === "cancel")).toBe(false);
  });

  it("pauses when an order is rejected", () => {
    const r = runSim(spotGrid, base, ctx, ticks([100]), {
      ...fees,
      rejectTags: (o) => o.tag === "grid:0:buy",
    });
    expect(r.halted).toEqual({ type: "pause", reason: ReasonCode.orderRejected });
  });

  it("waits for the trigger price to be crossed", () => {
    const r = runSim(spotGrid, { ...base, triggerPrice: "98" }, ctx, ticks([105, 103, 97]), fees);
    expect(r.state.phase).toBe("running");
    const first = r.actions.findIndex((a) => a.type === "place");
    expect(first).toBeGreaterThan(-1);
    expect(r.exchange.fills[0]?.at).toBe(2000);
  });

  it("validates the documented field rules", () => {
    const bad = spotGridSchema.safeParse({
      ...base,
      lowerPrice: "120",
      stopPrice: "130",
      maxLoss: "600",
    });
    expect(bad.success).toBe(false);
    const messages = bad.success ? [] : bad.error.issues.map((i) => i.message);
    expect(messages).toEqual(
      expect.arrayContaining([
        "Must be lower than the upper price.",
        "Must be below the lower price.",
        "Must be below the investment.",
      ]),
    );
  });
});

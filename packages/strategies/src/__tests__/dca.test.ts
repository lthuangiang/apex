import { ReasonCode } from "@drift/shared";
import { describe, expect, it } from "vitest";

import { safetyOffsetPct } from "../common/dca-bot";
import { futuresDca } from "../futures-dca";
import { futuresDcaSchema } from "../futures-dca/schema";
import { runSim } from "../sim/exchange";
import { spotDca } from "../spot-dca";
import { spotDcaSchema } from "../spot-dca/schema";

const rules = { tickSize: "0.01", stepSize: "0.0001", minQuantity: "0.0001", minNotional: "5" };
const ctx = {
  botId: "bot-dca",
  version: 1,
  feeRate: "0.0005",
  rules: { vETH_vUSDC: rules, "ETH-USD": rules },
};
const fees = { makerFee: "0", takerFee: "0" };
const ticks = (market: string, prices: number[]) =>
  prices.map((p, i) => ({ at: i * 1000, price: String(p), market }));
const spot = spotDcaSchema.parse({
  market: "vETH_vUSDC",
  baseOrder: "100",
  safetyOrder: "100",
  maxSafetyOrders: 3,
  firstStepPct: "2",
  stepMultiplier: "1.5",
  sizeMultiplier: "2",
  takeProfitPct: "1",
  start: "immediately",
});

describe("safety order spacing", () => {
  it("follows d1·(1 + m + … + m^(k−1))", () => {
    expect(safetyOffsetPct(spot, 1).toString()).toBe("2");
    expect(safetyOffsetPct(spot, 2).toString()).toBe("5");
    expect(safetyOffsetPct(spot, 3).toString()).toBe("9.5");
  });
});

describe("spot DCA", () => {
  it("starts a cycle with a market base order, safeties and a take profit", () => {
    const r = runSim(spotDca, spot, ctx, ticks("vETH_vUSDC", [100]), fees);
    const orders = r.actions.flatMap((a) => (a.type === "place" ? [a.order] : []));
    expect(orders[0]).toMatchObject({ type: "market", side: "buy", quantity: "1" });
    // safety: 98 (100/98=1.0204), 95 (200/95), 90.5 (400/90.5)
    expect(orders.slice(1, 4).map((o) => `${o.price ?? ""}x${o.quantity}`)).toEqual([
      "98x1.0204",
      "95x2.1052",
      "90.5x4.4198",
    ]);
    expect(orders[4]).toMatchObject({ side: "sell", price: "101", quantity: "1" });
  });

  it("moves the take profit after a safety fill and completes the cycle", () => {
    const r = runSim(spotDca, spot, ctx, ticks("vETH_vUSDC", [100, 98, 101, 105]), fees);
    // sau safety 1: TB = (100 + 98×1.0204)/2.0204 ≈ 99.01 → TP ≈ 100.00; giá 101 khớp TP
    expect(r.state.completedCycles).toBeGreaterThanOrEqual(1);
    expect(Number(r.state.ledger.realized)).toBeGreaterThan(0);
    expect(r.state.cycle).toBe(2);
  });

  it("stops after max cycles", () => {
    const r = runSim(
      spotDca,
      { ...spot, maxCycles: 1 },
      ctx,
      ticks("vETH_vUSDC", [100, 102]),
      fees,
    );
    expect(r.halted).toEqual({ type: "stop", reason: ReasonCode.maxCycles, close: false });
  });

  it("stops on stop loss from the average price", () => {
    const r = runSim(
      spotDca,
      { ...spot, stopLossPct: "12" },
      ctx,
      ticks("vETH_vUSDC", [100, 98, 95, 90.5, 80]),
      fees,
    );
    expect(r.halted).toEqual({ type: "stop", reason: ReasonCode.stopLoss, close: true });
  });

  it("pauses on max loss and on a rejected order", () => {
    const loss = runSim(
      spotDca,
      { ...spot, maxLoss: "5" },
      ctx,
      ticks("vETH_vUSDC", [100, 99, 94]),
      fees,
    );
    expect(loss.halted).toEqual({ type: "pause", reason: ReasonCode.botMaxLoss });
    const rej = runSim(spotDca, spot, ctx, ticks("vETH_vUSDC", [100]), {
      ...fees,
      rejectTags: (o) => o.tag.endsWith(":so2"),
    });
    expect(rej.halted).toEqual({ type: "pause", reason: ReasonCode.orderRejected });
  });

  it("waits for the start level", () => {
    const r = runSim(
      spotDca,
      { ...spot, start: "price_at_or_below", startLevel: "95" },
      ctx,
      ticks("vETH_vUSDC", [100, 97, 95]),
      fees,
    );
    expect(r.exchange.fills[0]?.at).toBe(2000);
  });

  it("rejects a stop loss inside the safety range", () => {
    const r = spotDcaSchema.safeParse({ ...spot, stopLossPct: "9" });
    expect(r.success ? [] : r.error.issues.map((i) => i.message)).toEqual([
      "Must be larger than the last safety order drop.",
    ]);
  });
});

describe("futures DCA", () => {
  const fut = futuresDcaSchema.parse({
    market: "ETH-USD",
    leverage: 2,
    marginMode: "cross",
    direction: "short",
    baseOrder: "50",
    safetyOrder: "50",
    maxSafetyOrders: 2,
    firstStepPct: "2",
    stepMultiplier: "1",
    sizeMultiplier: "1",
    takeProfitPct: "1",
    stopLossPct: "10",
  });

  it("short: sells first, safeties above, reduce-only take profit below", () => {
    const r = runSim(futuresDca, fut, ctx, ticks("ETH-USD", [100]), fees);
    const orders = r.actions.flatMap((a) => (a.type === "place" ? [a.order] : []));
    expect(orders[0]).toMatchObject({
      type: "market",
      side: "sell",
      quantity: "1",
      engine: "perps",
    });
    expect(orders.slice(1, 3).map((o) => o.price)).toEqual(["102", "104"]);
    expect(orders[3]).toMatchObject({ side: "buy", price: "99", reduceOnly: true });
  });

  it("takes profit when price falls and stops on an adverse move", () => {
    const tp = runSim(futuresDca, fut, ctx, ticks("ETH-USD", [100, 98.5]), fees);
    expect(tp.state.completedCycles).toBe(1);
    const sl = runSim(futuresDca, fut, ctx, ticks("ETH-USD", [100, 102, 104, 115]), fees);
    expect(sl.halted).toEqual({ type: "stop", reason: ReasonCode.stopLoss, close: true });
  });

  it("requires a stop loss beyond the last safety", () => {
    const r = futuresDcaSchema.safeParse({ ...fut, stopLossPct: "3" });
    expect(r.success).toBe(false);
  });
});

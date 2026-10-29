import { ReasonCode } from "@drift/shared";
import { describe, expect, it } from "vitest";

import { futuresGrid } from "../futures-grid";
import { futuresGridSchema } from "../futures-grid/schema";
import { runSim } from "../sim/exchange";

const ctx = {
  botId: "bot-fg",
  version: 1,
  feeRate: "0.0005",
  rules: {
    "BTC-USD": { tickSize: "1", stepSize: "0.001", minQuantity: "0.001", minNotional: "5" },
  },
};
const fees = { makerFee: "0", takerFee: "0" };
const base = futuresGridSchema.parse({
  market: "BTC-USD",
  leverage: 2,
  marginMode: "cross",
  direction: "neutral",
  lowerPrice: "90",
  upperPrice: "110",
  gridLevels: 5,
  spacing: "arithmetic",
  margin: "250",
  stopBelow: "50",
  maxLoss: "100",
  onStop: "close_at_market",
});
const ticks = (prices: number[]) =>
  prices.map((p, i) => ({ at: i * 1000, price: String(p), market: "BTC-USD" }));
const placed = (r: ReturnType<typeof runSim>) =>
  r.actions.flatMap((a) => (a.type === "place" ? [a.order] : []));

describe("futures grid", () => {
  it("neutral: no initial position, buys below and sells above on perps", () => {
    const r = runSim(futuresGrid, base, ctx, ticks([100]), fees);
    const orders = placed(r);
    expect(orders.some((o) => o.type === "market")).toBe(false);
    expect(orders.every((o) => o.engine === "perps")).toBe(true);
    // danh nghĩa 500 / 5 mức / giá TB 100 = 1
    expect(orders.map((o) => `${o.side}@${o.price ?? ""}x${o.quantity}`)).toEqual([
      "buy@90x1",
      "buy@95x1",
      "sell@105x1",
      "sell@110x1",
    ]);
  });

  it("long opens the position for levels above; short for levels below", () => {
    const long = placed(
      runSim(futuresGrid, { ...base, direction: "long" }, ctx, ticks([100]), fees),
    );
    expect(long[0]).toMatchObject({ type: "market", side: "buy", quantity: "2" });
    const short = placed(
      runSim(futuresGrid, { ...base, direction: "short" }, ctx, ticks([100]), fees),
    );
    expect(short[0]).toMatchObject({ type: "market", side: "sell", quantity: "2" });
    expect(
      short.filter((o) => o.type === "limit").map((o) => `${o.side}@${o.price ?? ""}`),
    ).toEqual(["sell@105", "sell@110", "buy@90", "buy@95"]);
  });

  it("records funding in PnL and pauses on max loss", () => {
    const r = runSim(futuresGrid, { ...base, maxLoss: "5" }, ctx, ticks([100, 101]), fees, (at) =>
      at === 1000 ? [{ type: "fundingPaid", at, market: "BTC-USD", amount: "6" }] : [],
    );
    expect(r.state.ledger.funding).toBe("6");
    expect(r.halted).toEqual({ type: "pause", reason: ReasonCode.botMaxLoss });
  });

  it("stops above the upper stop and closes the position", () => {
    const r = runSim(futuresGrid, { ...base, stopAbove: "115" }, ctx, ticks([100, 116]), fees);
    expect(r.halted).toEqual({ type: "stop", reason: ReasonCode.stopLoss, close: true });
  });

  it("takes profit on margin and pauses when an order is rejected", () => {
    const tp = runSim(
      futuresGrid,
      { ...base, takeProfitPct: "1" },
      ctx,
      ticks([100, 95, 100]),
      fees,
    );
    expect(tp.halted).toEqual({ type: "stop", reason: ReasonCode.takeProfit, close: true });
    const rej = runSim(futuresGrid, base, ctx, ticks([100]), {
      ...fees,
      rejectTags: (o) => o.side === "sell",
    });
    expect(rej.halted).toEqual({ type: "pause", reason: ReasonCode.orderRejected });
  });

  it("validates stop levels against the range", () => {
    const r = futuresGridSchema.safeParse({ ...base, stopAbove: "100", maxLoss: "300" });
    const messages = r.success ? [] : r.error.issues.map((i) => i.message);
    expect(messages).toEqual(
      expect.arrayContaining(["Must be above the upper price.", "Must be below the margin."]),
    );
  });
});

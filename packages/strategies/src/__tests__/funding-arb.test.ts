import { ReasonCode } from "@drift/shared";
import { describe, expect, it } from "vitest";

import { fundingArb } from "../funding-arb";
import { fundingArbSchema } from "../funding-arb/schema";
import { runSim } from "../sim/exchange";

const rules = { tickSize: "0.1", stepSize: "0.001", minQuantity: "0.001", minNotional: "5" };
const ctx = {
  botId: "bot-arb",
  version: 1,
  feeRate: "0",
  rules: { vBTC_vUSDC: rules, "BTC-USD": rules },
};
const fees = { makerFee: "0", takerFee: "0" };
const base = fundingArbSchema.parse({
  asset: "BTC",
  spotMarket: "vBTC_vUSDC",
  perpMarket: "BTC-USD",
  leverage: 1,
  investment: "2000",
  enterFundingPct: "0.005",
  exitFundingPct: "0",
  maxGapPct: "0.5",
  minMarginRatioPct: "30",
  maxLoss: "40",
});
const ticks = (n: number, price = 100) =>
  Array.from({ length: n }, (_, i) => [
    { at: i * 10, market: "vBTC_vUSDC", price: String(price) },
    { at: i * 10 + 1, market: "BTC-USD", price: String(price) },
  ]).flat();
const rates = (list: [number, string, string | null][]) => (at: number) =>
  list
    .filter(([t]) => t === at)
    .map(([t, current, avg7d]) => ({
      type: "fundingRate" as const,
      at: t,
      market: "BTC-USD",
      current,
      avg7d,
    }));

describe("funding arbitrage", () => {
  it("waits, then buys spot and shorts the perp with the same size", () => {
    const r = runSim(
      fundingArb,
      base,
      ctx,
      ticks(3),
      fees,
      rates([
        [11, "0.004", "0.004"],
        [21, "0.006", "0.006"],
      ]),
    );
    const fills = r.exchange.fills;
    expect(
      fills.map((f) => `${f.tag.split(":").slice(2).join(":")}:${f.side}:${f.quantity}`),
    ).toEqual(["open:spot:buy:10", "open:perp:sell:10"]);
    expect(r.state.phase).toBe("in_position");
    expect(r.state.cycle).toBe(1);
  });

  it("records funding received and exits after three low periods", () => {
    const r = runSim(fundingArb, base, ctx, ticks(6), fees, (at) => [
      ...rates([
        [1, "0.006", "0.006"],
        [21, "0", "0.004"],
        [31, "-0.001", "0.003"],
        [41, "0", "0.002"],
      ])(at),
      ...(at === 11
        ? [{ type: "fundingPaid" as const, at, market: "BTC-USD", amount: "-1.2" }]
        : []),
    ]);
    expect(r.state.perp.funding).toBe("-1.2");
    expect(r.state.phase).toBe("waiting");
    expect(r.exchange.fills.filter((f) => f.tag.includes(":close:"))).toHaveLength(2);
    expect(r.halted).toBeNull();
  });

  it("closes the filled leg and pauses when the other leg is rejected", () => {
    const r = runSim(
      fundingArb,
      base,
      ctx,
      ticks(2),
      { ...fees, rejectTags: (o) => o.tag.endsWith("open:spot") },
      rates([[1, "0.006", "0.006"]]),
    );
    expect(r.halted).toEqual({ type: "pause", reason: ReasonCode.orderRejected });
    // Chân perp đã khớp được đóng lại bằng lệnh reduce-only: không còn vị thế.
    expect(r.state.perp.position).toBe("0");
  });

  it("closes both legs and pauses when the margin ratio is too low", () => {
    const r = runSim(fundingArb, base, ctx, ticks(3), fees, (at) => [
      ...rates([[1, "0.006", "0.006"]])(at),
      ...(at === 21 ? [{ type: "marginRatio" as const, at, ratio: "0.2" }] : []),
    ]);
    expect(r.halted).toEqual({ type: "pause", reason: ReasonCode.insufficientBalance });
    expect(r.state.spot.position).toBe("0");
  });

  it("closes both legs and stops at max loss", () => {
    const r = runSim(fundingArb, base, ctx, ticks(2), fees, (at) => [
      ...rates([[1, "0.006", "0.006"]])(at),
      ...(at === 11 ? [{ type: "fundingPaid" as const, at, market: "BTC-USD", amount: "45" }] : []),
    ]);
    expect(r.halted).toEqual({ type: "stop", reason: ReasonCode.stopLoss, close: true });
  });

  it("requires the exit level below the entry level", () => {
    const r = fundingArbSchema.safeParse({ ...base, exitFundingPct: "0.01" });
    expect(r.success ? [] : r.error.issues.map((i) => i.message)).toEqual([
      "Must be below the entry level.",
    ]);
  });
});

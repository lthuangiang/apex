import { ReasonCode } from "@drift/shared";
import { describe, expect, it } from "vitest";

import { recurringBuy } from "../recurring-buy";
import { nextRun } from "../recurring-buy/schedule";
import { recurringBuySchema } from "../recurring-buy/schema";
import { runSim } from "../sim/exchange";

const ctx = {
  botId: "bot-rb",
  version: 1,
  feeRate: "0",
  rules: {
    vBTC_vUSDC: { tickSize: "1", stepSize: "0.0001", minQuantity: "0.0001", minNotional: "5" },
  },
};
const fees = { makerFee: "0", takerFee: "0" };
const base = recurringBuySchema.parse({
  market: "vBTC_vUSDC",
  amountPerBuy: "150",
  frequency: "weekly",
  dayOfWeek: 1,
  time: "09:00",
  timeZone: "Asia/Ho_Chi_Minh",
  ends: "after_budget",
  totalBudget: "300",
  onLowBalance: "skip_and_notify",
});
// Thứ Hai 2026-10-26 03:00 UTC (ngay sau lần chạy 09:00 UTC+7); mỗi tick cách nhau một tuần.
const START = Date.parse("2026-10-26T03:00:00Z");
const WEEK = 7 * 86_400_000;
const ticksWithTimers = (prices: number[]) =>
  prices.map((p, i) => ({ at: START + i * WEEK, price: String(p), market: "vBTC_vUSDC" }));
const timerEvery = (at: number) => (at > START ? [{ type: "timer" as const, at }] : []);

describe("recurring buy schedule", () => {
  it("runs Monday 09:00 in the user's time zone", () => {
    // Thứ Hai 2026-10-26 09:00 UTC+7 = 02:00 UTC
    const after = Date.parse("2026-10-25T00:00:00Z");
    expect(new Date(nextRun(base, after)).toISOString()).toBe("2026-10-26T02:00:00.000Z");
    expect(new Date(nextRun(base, Date.parse("2026-10-26T02:00:00Z"))).toISOString()).toBe(
      "2026-11-02T02:00:00.000Z",
    );
    expect(
      new Date(nextRun({ ...base, frequency: "monthly", dayOfMonth: 1 }, after)).toISOString(),
    ).toBe("2026-11-01T02:00:00.000Z");
  });
});

describe("recurring buy", () => {
  it("buys the exact amount on each timer and stops when the budget is used", () => {
    const r = runSim(recurringBuy, base, ctx, ticksWithTimers([100, 100, 100]), fees, timerEvery);
    expect(r.exchange.fills.map((f) => f.quantity)).toEqual(["1.5", "1.5"]);
    expect(r.halted).toEqual({ type: "stop", reason: ReasonCode.budgetDone, close: false });
    // Không bao giờ bán.
    expect(r.exchange.fills.every((f) => f.side === "buy")).toBe(true);
  });

  it("skips buys above the price limit without making them up", () => {
    const r = runSim(
      recurringBuy,
      { ...base, skipAbovePrice: "120" },
      ctx,
      ticksWithTimers([100, 130, 100]),
      fees,
      timerEvery,
    );
    expect(r.state.skipped).toBe(1);
    expect(r.exchange.fills).toHaveLength(1);
  });

  it("skips or pauses when the order is rejected for balance", () => {
    const reject = { ...fees, rejectTags: () => true };
    const skip = runSim(recurringBuy, base, ctx, ticksWithTimers([100, 100]), reject, timerEvery);
    expect(skip.halted).toBeNull();
    expect(skip.state.skipped).toBe(1);
    const pause = runSim(
      recurringBuy,
      { ...base, onLowBalance: "pause" },
      ctx,
      ticksWithTimers([100, 100]),
      reject,
      timerEvery,
    );
    expect(pause.halted).toEqual({ type: "pause", reason: ReasonCode.insufficientBalance });
  });

  it("waits for the scheduled time when timers arrive every second", () => {
    const ticks = [{ at: START, price: "100", market: "vBTC_vUSDC" }];
    // Nhịp mỗi giây trong một giờ: chưa tới 09:00 thứ Hai tuần sau nên không mua lần nào.
    const seconds = (at: number) =>
      Array.from({ length: 3600 }, (_, i) => ({ type: "timer" as const, at: at + (i + 1) * 1000 }));
    const early = runSim(recurringBuy, base, ctx, ticks, fees, seconds);
    expect(early.exchange.fills).toHaveLength(0);
    expect(early.state.skipped).toBe(0);
    expect(early.state.nextAt).toBe(Date.parse("2026-11-02T02:00:00Z"));
    // Tới giờ: đúng một lần mua dù nhịp tiếp tục tới.
    const due = runSim(
      recurringBuy,
      base,
      ctx,
      [...ticks, { at: Date.parse("2026-11-02T02:00:00Z"), price: "100", market: "vBTC_vUSDC" }],
      fees,
      (at) => (at > START ? seconds(at - 1000).slice(0, 60) : []),
    );
    expect(due.exchange.fills.map((f) => f.quantity)).toEqual(["1.5"]);
  });

  it("validates the budget", () => {
    const r = recurringBuySchema.safeParse({ ...base, totalBudget: "100" });
    expect(r.success ? [] : r.error.issues.map((i) => i.message)).toEqual([
      "Must be at least one buy.",
    ]);
  });
});

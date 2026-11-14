import { ReasonCode } from "@drift/shared";
import { describe, expect, it } from "vitest";

import { RB_PENDING_TIMEOUT_MS, recurringBuy, type RecurringBuyState } from "../recurring-buy";
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

describe("recurring buy — buys that end part-filled (P0.1)", () => {
  const step = (st: RecurringBuyState, e: Parameters<typeof recurringBuy.step>[2]) =>
    recurringBuy.step(base, st, e, ctx);
  /** Giá 100.000, tới giờ mua: đặt lệnh 0.0015 BTC (150 USDC). */
  const placed = () => {
    let st = recurringBuy.initialState(base);
    st = step(st, { type: "tick", at: START - WEEK, market: "vBTC_vUSDC", price: "100000" }).state;
    const at = st.nextAt ?? START;
    const r = step(st, { type: "timer", at });
    const o = r.actions.find((a) => a.type === "place");
    if (o?.type !== "place") throw new Error("no buy");
    return { st: r.state, order: o.order, at };
  };
  const fill = (id: string, q: string, at: number) =>
    ({ type: "fill", at, clOrdID: id, price: "100000", quantity: q, fee: "0" }) as const;

  it("adds up several fills and counts a part-filled buy when it ends", () => {
    const { st, order, at } = placed();
    expect(order.quantity).toBe("0.0015");
    const a = step(st, fill(order.clOrdID, "0.0005", at + 1)).state;
    const b = step(a, fill(order.clOrdID, "0.0005", at + 2)).state;
    expect(b.pending).toBe(order.clOrdID);
    expect(b.spent).toBe("100");
    const d = step(b, { type: "orderDone", at: at + 3, clOrdID: order.clOrdID });
    expect(d.state).toMatchObject({ pending: null, buys: 1, skipped: 0 });
    expect(d.actions).toEqual([{ type: "log", decision: "Buy 1 filled", why: "0.001 at 100000." }]);
  });

  it("counts a buy that did not fill as skipped, instead of waiting forever", () => {
    const { st, order, at } = placed();
    const d = step(st, { type: "orderDone", at: at + 1, clOrdID: order.clOrdID });
    expect(d.state).toMatchObject({ pending: null, buys: 0, skipped: 1 });
    // Lần sau vẫn mua theo lịch.
    const next = step(d.state, { type: "timer", at: d.state.nextAt ?? at + WEEK });
    expect(next.actions.some((a) => a.type === "place")).toBe(true);
  });

  it("books a fill that arrives after orderDone into the ledger and the money spent", () => {
    const { st, order, at } = placed();
    const d = step(st, { type: "orderDone", at: at + 1, clOrdID: order.clOrdID }).state;
    const late = step(d, fill(order.clOrdID, "0.0015", at + 2)).state;
    expect(late.ledger.position).toBe("0.0015");
    expect(late.spent).toBe("150");
    // Không tính quá khối lượng lệnh.
    expect(step(late, fill(order.clOrdID, "0.001", at + 3)).state.spent).toBe("150");
  });

  it("treats a buy with no orderDone for 60 s as ended", () => {
    const { st, order, at } = placed();
    const a = step(st, fill(order.clOrdID, "0.001", at + 1)).state;
    const early = step(a, { type: "timer", at: at + RB_PENDING_TIMEOUT_MS - 1 }).state;
    expect(early.pending).toBe(order.clOrdID);
    const late = step(early, { type: "timer", at: at + RB_PENDING_TIMEOUT_MS }).state;
    expect(late).toMatchObject({ pending: null, buys: 1 });
  });
});

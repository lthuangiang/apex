import { add, dec, gt, ReasonCode } from "@drift/shared";

import { clOrdId } from "../core/ids";
import { applyFill, emptyLedger, type Ledger } from "../core/ledger";
import { meetsMinimum, qtyForQuote } from "../core/rounding";
import type { StepContext, StepResult, StrategyEvent, StrategyModule } from "../core/types";

import { nextRun } from "./schedule";
import type { RecurringBuyConfig } from "./schema";

// S5 Recurring Buy: `timer` là nhịp đồng hồ (engine gửi mỗi vòng, backtest mỗi nến); chỉ hành động khi đã tới
// `nextAt`. Mỗi lần: bỏ qua nếu giá > ngưỡng; nếu không thì mua market đúng số tiền. Lần bị bỏ qua (kể cả lần
// lỡ khi engine dừng) không mua bù. Hết ngân sách / đủ số lần → stop(BUDGET_DONE).

export interface RecurringBuyState {
  phase: "running" | "halted";
  buys: number;
  skipped: number;
  spent: string;
  lastPrice: string | null;
  pending: string | null;
  nextAt: number | null;
  ledger: Ledger;
}

const initial = (): RecurringBuyState => ({
  phase: "running",
  buys: 0,
  skipped: 0,
  spent: "0",
  lastPrice: null,
  pending: null,
  nextAt: null,
  ledger: emptyLedger(),
});

function done(c: RecurringBuyConfig, s: RecurringBuyState): boolean {
  if (c.ends === "after_n_buys") return s.buys >= (c.buyCount ?? Infinity);
  if (c.ends === "after_budget") return gt(add(s.spent, c.amountPerBuy), c.totalBudget ?? "0");
  return false;
}

export function stepRecurringBuy(
  c: RecurringBuyConfig,
  s: RecurringBuyState,
  e: StrategyEvent,
  ctx: StepContext,
): StepResult<RecurringBuyState> {
  if (s.phase === "halted") return { actions: [], state: s };
  if (e.type === "tick" && e.market === c.market) {
    const state = { ...s, lastPrice: e.price, nextAt: s.nextAt ?? nextRun(c, e.at) };
    return { actions: [], state };
  }
  if (e.type === "timer") {
    // Chưa có lịch (chưa có giá) thì đặt lịch; chưa tới giờ hoặc lệnh trước chưa xong thì chờ.
    if (s.nextAt === null) return { actions: [], state: { ...s, nextAt: nextRun(c, e.at) } };
    if (e.at < s.nextAt || s.pending !== null) return { actions: [], state: s };
    const state = { ...s, nextAt: nextRun(c, e.at) };
    const rules = ctx.rules[c.market];
    if (s.lastPrice === null || rules === undefined) {
      return {
        actions: [{ type: "log", decision: "Buy skipped", why: "No recent price." }],
        state: { ...state, skipped: s.skipped + 1 },
      };
    }
    if (c.skipAbovePrice !== undefined && gt(s.lastPrice, c.skipAbovePrice)) {
      return {
        actions: [
          {
            type: "log",
            decision: "Buy skipped",
            why: `Price ${s.lastPrice} is above ${c.skipAbovePrice}.`,
          },
        ],
        state: { ...state, skipped: s.skipped + 1 },
      };
    }
    const qty = qtyForQuote(c.amountPerBuy, s.lastPrice, rules);
    if (!meetsMinimum(s.lastPrice, qty, rules)) {
      return {
        actions: [
          {
            type: "log",
            decision: "Buy skipped",
            why: "Amount is below SoDEX minimum order size.",
          },
        ],
        state: { ...state, skipped: s.skipped + 1 },
      };
    }
    const id = clOrdId(ctx.botId, ctx.version, `rb:${String(s.buys + s.skipped)}`);
    return {
      actions: [
        {
          type: "place",
          order: {
            clOrdID: id,
            market: c.market,
            engine: "spot",
            side: "buy",
            type: "market",
            quantity: qty,
            timeInForce: "IOC",
            reduceOnly: false,
            tag: "rb:buy",
          },
        },
      ],
      state: { ...state, pending: id },
    };
  }
  if (e.type === "orderReject" && e.clOrdID === s.pending) {
    const state = { ...s, pending: null, skipped: s.skipped + 1 };
    if (c.onLowBalance === "pause")
      return {
        actions: [{ type: "pause", reason: ReasonCode.insufficientBalance }],
        state: { ...state, phase: "halted" },
      };
    return {
      actions: [
        {
          type: "log",
          decision: "Buy skipped",
          why: `Order rejected (${e.code}); skipped buys are not made up.`,
        },
      ],
      state,
    };
  }
  if (e.type === "fill" && e.clOrdID === s.pending) {
    const state: RecurringBuyState = {
      ...s,
      pending: null,
      buys: s.buys + 1,
      spent: add(s.spent, dec(e.price).mul(e.quantity)).toString(),
      ledger: applyFill(s.ledger, "buy", e.price, e.quantity, e.fee),
    };
    if (done(c, state))
      return {
        actions: [{ type: "stop", reason: ReasonCode.budgetDone, close: false }],
        state: { ...state, phase: "halted" },
      };
    return {
      actions: [
        {
          type: "log",
          decision: `Buy ${String(state.buys)} filled`,
          why: `${e.quantity} at ${e.price}.`,
        },
      ],
      state,
    };
  }
  return { actions: [], state: s };
}

export const recurringBuy: StrategyModule<RecurringBuyConfig, RecurringBuyState> = {
  initialState: initial,
  step: stepRecurringBuy,
};

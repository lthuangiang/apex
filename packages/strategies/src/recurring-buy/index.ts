import { add, dec, Decimal, gt, ReasonCode } from "@drift/shared";

import { clOrdId } from "../core/ids";
import { applyFill, emptyLedger, type Ledger } from "../core/ledger";
import { meetsMinimum, qtyForQuote } from "../core/rounding";
import type { StepContext, StepResult, StrategyEvent, StrategyModule } from "../core/types";

import { nextRun } from "./schedule";
import type { RecurringBuyConfig } from "./schema";

// S5 Recurring Buy: `timer` là nhịp đồng hồ (engine gửi mỗi vòng, backtest mỗi nến); chỉ hành động khi đã tới
// `nextAt`. Mỗi lần: bỏ qua nếu giá > ngưỡng; nếu không thì mua market đúng số tiền. Lần bị bỏ qua (kể cả lần
// lỡ khi engine dừng) không mua bù. Hết ngân sách / đủ số lần → stop(BUDGET_DONE).
// Lệnh mua có thể khớp nhiều lần rồi hết hạn (P0.1): cộng dồn theo lệnh, lần mua xong khi khớp đủ hoặc có
// `orderDone` (khớp một phần vẫn tính là một lần mua, không khớp gì thì là một lần bỏ qua). Fill tới trễ vẫn vào sổ
// cái và số tiền đã chi. Lệnh chờ quá 60 s mà không có `orderDone` thì coi như xong.

export interface RecurringBuyState {
  phase: "running" | "halted";
  buys: number;
  skipped: number;
  spent: string;
  lastPrice: string | null;
  pending: string | null;
  nextAt: number | null;
  ledger: Ledger;
  /** Các lệnh gần nhất: khối lượng đặt, đã khớp và tiền đã chi (thiếu ở state cũ). */
  orders?: Record<string, { qty: string; filled: string; cost: string }>;
  /** Lúc đặt lệnh đang chờ (ms). */
  pendingAt?: number | null;
}

/** Lệnh chờ quá lâu mà không có `orderDone` (tin mất) thì coi như xong với phần đã khớp. */
export const RB_PENDING_TIMEOUT_MS = 60_000;
const KEEP_ORDERS = 5;

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

/** Lệnh mua đang chờ đã xong (khớp đủ / `orderDone` / quá hạn chờ). */
function finishBuy(c: RecurringBuyConfig, s: RecurringBuyState): StepResult<RecurringBuyState> {
  const o = s.pending === null ? undefined : s.orders?.[s.pending];
  const base: RecurringBuyState = { ...s, pending: null, pendingAt: null };
  if (o === undefined || !dec(o.filled).gt(0)) {
    return {
      actions: [
        {
          type: "log",
          decision: "Buy skipped",
          why: "The order did not fill; skipped buys are not made up.",
        },
      ],
      state: { ...base, skipped: s.skipped + 1 },
    };
  }
  const state: RecurringBuyState = { ...base, buys: s.buys + 1 };
  if (done(c, state))
    return {
      actions: [{ type: "stop", reason: ReasonCode.budgetDone, close: false }],
      state: { ...state, phase: "halted" },
    };
  const avg = dec(o.cost).div(o.filled).toString();
  return {
    actions: [
      {
        type: "log",
        decision: `Buy ${String(state.buys)} filled`,
        why: `${o.filled} at ${avg}.`,
      },
    ],
    state,
  };
}

export function stepRecurringBuy(
  c: RecurringBuyConfig,
  s: RecurringBuyState,
  e: StrategyEvent,
  ctx: StepContext,
): StepResult<RecurringBuyState> {
  if (e.type === "resumed") {
    // Resume (DEC-240): lần mua đã lỡ trong lúc pause không mua bù; lần kế tiếp theo lịch tính từ lúc resume.
    // Bot tự pause thì chạy tiếp với sổ cái và số tiền đã chi như cũ.
    const late = s.nextAt !== null && s.nextAt <= e.at;
    const state: RecurringBuyState = {
      ...s,
      ...(late ? { nextAt: nextRun(c, e.at) } : {}),
      lastPrice: e.prices[c.market] ?? s.lastPrice,
      ...(s.phase === "halted" ? { phase: "running", pending: null, pendingAt: null } : {}),
    };
    return { actions: [], state };
  }
  if (s.phase === "halted") return { actions: [], state: s };
  if (e.type === "tick" && e.market === c.market) {
    const state = { ...s, lastPrice: e.price, nextAt: s.nextAt ?? nextRun(c, e.at) };
    return { actions: [], state };
  }
  if (e.type === "timer") {
    // Chưa có lịch (chưa có giá) thì đặt lịch; chưa tới giờ hoặc lệnh trước chưa xong thì chờ.
    if (s.nextAt === null) return { actions: [], state: { ...s, nextAt: nextRun(c, e.at) } };
    if (s.pending !== null) {
      // Lệnh chờ không bao giờ có `orderDone`: quá hạn thì coi như xong (state cũ thiếu giờ đặt thì bắt đầu đếm).
      if (s.pendingAt == null) return { actions: [], state: { ...s, pendingAt: e.at } };
      if (e.at - s.pendingAt < RB_PENDING_TIMEOUT_MS) return { actions: [], state: s };
      return finishBuy(c, s);
    }
    if (e.at < s.nextAt) return { actions: [], state: s };
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
      state: {
        ...state,
        pending: id,
        pendingAt: e.at,
        orders: Object.fromEntries(
          [...Object.entries(s.orders ?? {}), [id, { qty, filled: "0", cost: "0" }] as const].slice(
            -KEEP_ORDERS,
          ),
        ),
      },
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
  if (e.type === "orderDone" && e.clOrdID === s.pending) return finishBuy(c, s);
  if (e.type === "fill") {
    const o = s.orders?.[e.clOrdID];
    // State cũ (trước P0.1) không có `orders`: lệnh đang chờ nhận đủ khối lượng như trước.
    if (o === undefined && e.clOrdID !== s.pending) return { actions: [], state: s };
    const room = o === undefined ? dec(e.quantity) : dec(o.qty).sub(o.filled);
    const q = Decimal.min(room, e.quantity);
    if (!q.gt(0)) return { actions: [], state: s };
    const fee = q.lt(e.quantity) ? dec(e.fee).mul(q).div(e.quantity).toString() : e.fee;
    const cost = dec(e.price).mul(q);
    const record = {
      qty: o?.qty ?? q.toString(),
      filled: add(o?.filled ?? "0", q).toString(),
      cost: add(o?.cost ?? "0", cost).toString(),
    };
    const state: RecurringBuyState = {
      ...s,
      spent: add(s.spent, cost).toString(),
      ledger: applyFill(s.ledger, "buy", e.price, q, fee),
      orders: { ...s.orders, [e.clOrdID]: record },
    };
    if (e.clOrdID !== s.pending) {
      // Khớp trễ sau khi lần mua đã xong: chỉ vào sổ cái và số tiền đã chi.
      return done(c, state)
        ? {
            actions: [{ type: "stop", reason: ReasonCode.budgetDone, close: false }],
            state: { ...state, phase: "halted" },
          }
        : { actions: [], state };
    }
    return dec(record.filled).gte(record.qty) ? finishBuy(c, state) : { actions: [], state };
  }
  return { actions: [], state: s };
}

export const recurringBuy: StrategyModule<RecurringBuyConfig, RecurringBuyState> = {
  initialState: initial,
  step: stepRecurringBuy,
};

import { add, dec, gt, lt, ReasonCode, sub } from "@drift/shared";

import { clOrdId } from "../core/ids";
import { applyFill, emptyLedger, type Ledger } from "../core/ledger";
import { meetsMinimum, roundPrice, roundQty } from "../core/rounding";
import type {
  StepContext,
  StepResult,
  StrategyAction,
  StrategyEvent,
  StrategyModule,
} from "../core/types";

import type { TwapConfig } from "./schema";

// S8 TWAP (STRATEGIES.md): mỗi duration/N (kiểm tra ở mỗi `timer`) đặt một lát limit IOC ở giá hiện tại ± trượt giá
// tối đa (giới hạn trượt giá của lát). Lát vượt price limit thì bỏ qua: dồn sang lát sau hoặc để trống.
// Hết lát hoặc hết thời gian → stop(BUDGET_DONE).

export interface TwapState {
  phase: "waiting" | "running" | "halted";
  startedAt: number | null;
  arrivalPrice: string | null;
  lastPrice: string | null;
  sliceIndex: number;
  carry: string;
  filled: string;
  skipped: number;
  pending: string | null;
  ledger: Ledger;
}

const initial = (): TwapState => ({
  phase: "waiting",
  startedAt: null,
  arrivalPrice: null,
  lastPrice: null,
  sliceIndex: 0,
  carry: "0",
  filled: "0",
  skipped: 0,
  pending: null,
  ledger: emptyLedger(),
});

export const sliceIntervalMs = (c: TwapConfig) =>
  Math.floor((c.durationMinutes * 60_000) / c.slices);

function finish(s: TwapState, why: string): StepResult<TwapState> {
  return {
    actions: [
      { type: "log", decision: "TWAP finished", why },
      { type: "stop", reason: ReasonCode.budgetDone, close: false },
    ],
    state: { ...s, phase: "halted" },
  };
}

export function stepTwap(
  c: TwapConfig,
  s: TwapState,
  e: StrategyEvent,
  ctx: StepContext,
): StepResult<TwapState> {
  if (s.phase === "halted") return { actions: [], state: s };
  if (e.type === "tick" && e.market === c.market) {
    const state = { ...s, lastPrice: e.price };
    if (s.phase === "waiting")
      return {
        actions: [],
        state: { ...state, phase: "running", startedAt: e.at, arrivalPrice: e.price },
      };
    return { actions: [], state };
  }
  if (e.type === "timer" && s.phase === "running" && s.pending === null) {
    // `timer` là nhịp đồng hồ: lát thứ k (tính từ 0) tới hạn ở startedAt + k × duration/N.
    const dueAt = (s.startedAt ?? e.at) + s.sliceIndex * sliceIntervalMs(c);
    if (e.at < dueAt) return { actions: [], state: s };
    if (
      s.sliceIndex >= c.slices ||
      (s.startedAt !== null && e.at - s.startedAt > c.durationMinutes * 60_000)
    ) {
      return finish(s, `${s.filled} of ${c.totalSize} filled.`);
    }
    const rules = ctx.rules[c.market];
    const price = s.lastPrice;
    const base = dec(c.totalSize).div(c.slices);
    const isLast = s.sliceIndex === c.slices - 1;
    const want = add(base, c.onSkip === "add_to_end" ? s.carry : "0");
    // Lát cuối lấy phần còn thiếu, tránh lệch do làm tròn.
    const remaining = sub(c.totalSize, s.filled);
    const raw = isLast && c.onSkip === "add_to_end" ? remaining : want;
    const index = s.sliceIndex + 1;
    if (price === null || rules === undefined) return { actions: [], state: s };
    const blocked =
      c.priceLimit !== undefined &&
      (c.side === "buy" ? gt(price, c.priceLimit) : lt(price, c.priceLimit));
    const qty = roundQty(raw, rules);
    const slip = dec(c.maxSlippagePct).div(100);
    const limit = roundPrice(
      c.side === "buy" ? dec(price).mul(dec("1").add(slip)) : dec(price).mul(dec("1").sub(slip)),
      rules,
    );
    if (blocked || !meetsMinimum(limit, qty, rules)) {
      const why = blocked
        ? `Price ${price} is beyond the limit ${c.priceLimit ?? ""}.`
        : "Slice is below SoDEX minimum order size.";
      const state = {
        ...s,
        sliceIndex: index,
        skipped: s.skipped + 1,
        carry: c.onSkip === "add_to_end" ? want.toString() : "0",
      };
      const actions: StrategyAction[] = [
        { type: "log", decision: `Slice ${String(index)} skipped`, why },
      ];
      return index >= c.slices
        ? {
            actions: [
              ...actions,
              ...finish(state, `${state.filled} of ${c.totalSize} filled.`).actions,
            ],
            state: { ...state, phase: "halted" },
          }
        : { actions, state };
    }
    const id = clOrdId(ctx.botId, ctx.version, `twap:${String(index)}`);
    return {
      actions: [
        {
          type: "place",
          order: {
            clOrdID: id,
            market: c.market,
            engine: c.engine,
            side: c.side,
            type: "limit",
            price: limit,
            quantity: qty,
            timeInForce: "IOC",
            reduceOnly: c.engine === "perps" && c.reduceOnly,
            tag: `twap:${String(index)}`,
          },
        },
      ],
      state: { ...s, pending: id, sliceIndex: index, carry: "0" },
    };
  }
  if ((e.type === "fill" || e.type === "orderReject") && e.clOrdID === s.pending) {
    if (e.type === "orderReject") {
      return {
        actions: [{ type: "pause", reason: ReasonCode.orderRejected }],
        state: { ...s, phase: "halted", pending: null },
      };
    }
    const state: TwapState = {
      ...s,
      pending: null,
      filled: add(s.filled, e.quantity).toString(),
      ledger: applyFill(s.ledger, c.side, e.price, e.quantity, e.fee),
    };
    if (state.sliceIndex >= c.slices)
      return finish(state, `${state.filled} of ${c.totalSize} filled.`);
    return { actions: [], state };
  }
  return { actions: [], state: s };
}

export const twap: StrategyModule<TwapConfig, TwapState> = {
  initialState: initial,
  step: stepTwap,
};

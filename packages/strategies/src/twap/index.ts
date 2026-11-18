import { add, dec, Decimal, gt, lt, ReasonCode, RoundMode, sub } from "@drift/shared";

import { clOrdId } from "../core/ids";
import { applyFill, carryLedger, emptyLedger, type Ledger } from "../core/ledger";
import { meetsMinimum, roundPrice, roundQty } from "../core/rounding";
import type {
  Side,
  StepContext,
  StepResult,
  StrategyAction,
  StrategyEvent,
  StrategyModule,
} from "../core/types";

import { twapStartAt, type TwapConfig } from "./schema";

// S8 TWAP (STRATEGIES.md): mỗi duration/N (kiểm tra ở mỗi `timer`) đặt một lát limit IOC ở giá hiện tại ± trượt giá
// tối đa (giới hạn trượt giá của lát). Lát vượt price limit thì bỏ qua: dồn sang lát sau hoặc để trống.
// Hết lát hoặc hết thời gian → stop(BUDGET_DONE).
// Lát IOC có thể khớp nhiều lần rồi hết hạn (P0.1): cộng dồn fill theo lệnh, lát xong khi khớp đủ hoặc có `orderDone`;
// phần chưa khớp được dồn sang lát sau nếu chọn add_to_end. Fill tới trễ vẫn vào sổ cái (trừ khỏi phần đã dồn). Lát
// chờ quá 60 s mà không có `orderDone` thì coi như xong. Giá limit không bao giờ vượt Price limit.

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
  /** Các lát gần nhất: khối lượng đặt và đã khớp, để cộng dồn fill và nhận fill trễ (thiếu ở state cũ). */
  orders?: Record<string, TwapOrder>;
  /** Lúc đặt lát đang chờ (ms). */
  pendingAt?: number | null;
}

export interface TwapOrder {
  qty: string;
  filled: string;
  /** Chiều của lát lúc đặt (#223 M4): fill muộn của lát version cũ sau khi đổi chiều vẫn vào sổ cái đúng dấu. */
  side?: Side;
  /** Đã có `orderDone`; lát chưa kết thúc không bao giờ bị đẩy khỏi bộ nhớ. */
  done?: boolean;
}

/** Giữ mọi lát chưa kết thúc và `KEEP_ORDERS` lát gần nhất; trần `MAX_ORDERS` (lát mới nhất). */
function keepOrders(list: readonly (readonly [string, TwapOrder])[]): Record<string, TwapOrder> {
  const recent = new Set(list.slice(-KEEP_ORDERS).map(([id]) => id));
  return Object.fromEntries(
    list.filter(([id, o]) => o.done !== true || recent.has(id)).slice(-MAX_ORDERS),
  );
}

/** Lát chờ quá lâu mà không có `orderDone` (tin mất) thì coi như xong với phần đã khớp. */
export const TWAP_PENDING_TIMEOUT_MS = 60_000;
const KEEP_ORDERS = 5;
const MAX_ORDERS = 32;

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

/** Lát đang chờ đã xong mà chưa khớp đủ (hết hạn / `orderDone` / quá hạn chờ): dồn phần thiếu nếu add_to_end. */
function sliceDone(c: TwapConfig, s: TwapState): StepResult<TwapState> {
  const o = s.pending === null ? undefined : s.orders?.[s.pending];
  const unfilled = o === undefined ? dec("0") : Decimal.max(0, dec(o.qty).sub(o.filled));
  const state: TwapState = {
    ...s,
    pending: null,
    pendingAt: null,
    carry: c.onSkip === "add_to_end" ? add(s.carry, unfilled).toString() : s.carry,
  };
  if (state.sliceIndex >= c.slices)
    return finish(state, `${state.filled} of ${c.totalSize} filled.`);
  return { actions: [], state };
}

export function stepTwap(
  c: TwapConfig,
  s: TwapState,
  e: StrategyEvent,
  ctx: StepContext,
): StepResult<TwapState> {
  // Resume sau khi bot tự pause (DEC-240): chạy tiếp từ lát kế tiếp với sổ cái và phần đã khớp như cũ.
  if (e.type === "resumed")
    return s.phase === "halted"
      ? {
          actions: [],
          state: {
            ...s,
            phase: s.startedAt === null ? "waiting" : "running",
            lastPrice: e.prices[c.market] ?? s.lastPrice,
            pending: null,
            pendingAt: null,
          },
        }
      : { actions: [], state: s };
  if (s.phase === "halted") {
    // Đã dừng / đã xong: fill tới muộn của lát đang nhớ vẫn vào sổ cái theo chiều của chính lát (#223 M4).
    const o = e.type === "fill" ? s.orders?.[e.clOrdID] : undefined;
    if (e.type !== "fill" || o === undefined) return { actions: [], state: s };
    const q = Decimal.min(dec(o.qty).sub(o.filled), e.quantity);
    if (!q.gt(0)) return { actions: [], state: s };
    const fee = q.lt(e.quantity) ? dec(e.fee).mul(q).div(e.quantity).toString() : e.fee;
    return {
      actions: [],
      state: {
        ...s,
        ledger: applyFill(s.ledger, e.side ?? o.side ?? c.side, e.price, q, fee),
        orders: { ...s.orders, [e.clOrdID]: { ...o, filled: add(o.filled, q).toString() } },
      },
    };
  }
  if (e.type === "tick" && e.market === c.market) {
    const state = { ...s, lastPrice: e.price };
    // Start at (IMP-03): chưa tới giờ thì chỉ ghi giá, chưa đặt lát nào. Giờ đã qua thì chạy ngay.
    const startAt = twapStartAt(c);
    if (s.phase === "waiting" && startAt !== null && e.at < startAt) return { actions: [], state };
    if (s.phase === "waiting")
      return {
        actions: [],
        state: { ...state, phase: "running", startedAt: e.at, arrivalPrice: e.price },
      };
    return { actions: [], state };
  }
  if (e.type === "timer" && s.phase === "running" && s.pending !== null) {
    // Lát đang chờ không bao giờ có `orderDone`: quá hạn thì coi như xong (state cũ thiếu giờ đặt thì bắt đầu đếm).
    if (s.pendingAt == null) return { actions: [], state: { ...s, pendingAt: e.at } };
    if (e.at - s.pendingAt < TWAP_PENDING_TIMEOUT_MS) return { actions: [], state: s };
    return sliceDone(c, s);
  }
  if (e.type === "timer" && s.phase === "running" && s.pending === null) {
    // Version mới đang chờ áp (DEC-304, #223): engine chỉ hoãn khi còn lát đang chờ; lát đó xong thì `versionPending`
    // còn tới vòng áp kế tiếp, và nhịp đồng hồ trong khoảng đó không được đặt lát mới (nếu không, lát mới lại chặn lần áp).
    if (ctx.versionPending !== undefined) return { actions: [], state: s };
    // `timer` là nhịp đồng hồ: lát thứ k (tính từ 0) tới hạn ở startedAt + k × duration/N.
    const dueAt = (s.startedAt ?? e.at) + s.sliceIndex * sliceIntervalMs(c);
    if (e.at < dueAt) return { actions: [], state: s };
    // Phần còn thiếu; version mới (#223) có thể có tổng nhỏ hơn phần đã khớp.
    const remaining = sub(c.totalSize, s.filled);
    if (
      s.sliceIndex >= c.slices ||
      !remaining.gt(0) ||
      (s.startedAt !== null && e.at - s.startedAt > c.durationMinutes * 60_000)
    ) {
      return finish(s, `${s.filled} of ${c.totalSize} filled.`);
    }
    const rules = ctx.rules[c.market];
    const price = s.lastPrice;
    const base = dec(c.totalSize).div(c.slices);
    const isLast = s.sliceIndex === c.slices - 1;
    const want = add(base, c.onSkip === "add_to_end" ? s.carry : "0");
    // Lát cuối lấy phần còn thiếu, tránh lệch do làm tròn. Không lát nào vượt phần còn thiếu (không bao giờ khớp quá
    // tổng khối lượng).
    const raw = Decimal.min(isLast && c.onSkip === "add_to_end" ? remaining : want, remaining);
    const index = s.sliceIndex + 1;
    if (price === null || rules === undefined) return { actions: [], state: s };
    const blocked =
      c.priceLimit !== undefined &&
      (c.side === "buy" ? gt(price, c.priceLimit) : lt(price, c.priceLimit));
    const qty = roundQty(raw, rules);
    const slip = dec(c.maxSlippagePct).div(100);
    // Giá lệnh không vượt Price limit (mua: không cao hơn, bán: không thấp hơn) và làm tròn về phía an toàn.
    const raw0 =
      c.side === "buy" ? dec(price).mul(dec("1").add(slip)) : dec(price).mul(dec("1").sub(slip));
    const capped =
      c.priceLimit === undefined
        ? raw0
        : c.side === "buy"
          ? Decimal.min(raw0, c.priceLimit)
          : Decimal.max(raw0, c.priceLimit);
    const limit = roundPrice(capped, rules, c.side === "buy" ? RoundMode.down : RoundMode.up);
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
      state: {
        ...s,
        pending: id,
        pendingAt: e.at,
        sliceIndex: index,
        carry: "0",
        orders: keepOrders([
          ...Object.entries(s.orders ?? {}),
          [id, { qty, filled: "0", side: c.side }] as const,
        ]),
      },
    };
  }
  if (e.type === "orderReject" && e.clOrdID === s.pending) {
    return {
      actions: [{ type: "pause", reason: ReasonCode.orderRejected }],
      state: { ...s, phase: "halted", pending: null },
    };
  }
  if (e.type === "fill") {
    const o = s.orders?.[e.clOrdID];
    // State cũ (trước P0.1) không có `orders`: lát đang chờ nhận đủ khối lượng như trước.
    if (o === undefined && e.clOrdID !== s.pending) return { actions: [], state: s };
    const room = o === undefined ? dec(e.quantity) : dec(o.qty).sub(o.filled);
    const q = Decimal.min(room, e.quantity);
    if (!q.gt(0)) return { actions: [], state: s };
    const fee = q.lt(e.quantity) ? dec(e.fee).mul(q).div(e.quantity).toString() : e.fee;
    // Chiều của chính lát (engine gửi kèm, rồi chiều đã nhớ), không theo cấu hình hiện tại (#223 M4).
    const side = e.side ?? o?.side ?? c.side;
    const record =
      o === undefined
        ? {}
        : { orders: { ...s.orders, [e.clOrdID]: { ...o, filled: add(o.filled, q).toString() } } };
    // Lát của version cũ ngược chiều (đổi Buy ↔ Sell): chỉ vào sổ cái, không tính vào tiến độ của version này.
    if (side !== c.side)
      return {
        actions: [],
        state: { ...s, ...record, ledger: applyFill(s.ledger, side, e.price, q, fee) },
      };
    let state: TwapState = {
      ...s,
      filled: add(s.filled, q).toString(),
      ledger: applyFill(s.ledger, side, e.price, q, fee),
      ...record,
    };
    if (e.clOrdID !== s.pending) {
      // Khớp trễ sau khi lát đã xong: phần này đã được dồn sang lát sau, trừ lại để không mua dư.
      const carry = Decimal.max(0, dec(state.carry).sub(q)).toString();
      return { actions: [], state: { ...state, carry } };
    }
    const done = o === undefined || add(o.filled, q).gte(o.qty);
    if (!done) return { actions: [], state };
    state = { ...state, pending: null, pendingAt: null };
    if (state.sliceIndex >= c.slices)
      return finish(state, `${state.filled} of ${c.totalSize} filled.`);
    return { actions: [], state };
  }
  if (e.type === "orderDone") {
    const o = s.orders?.[e.clOrdID];
    const state =
      o === undefined ? s : { ...s, orders: { ...s.orders, [e.clOrdID]: { ...o, done: true } } };
    if (e.clOrdID === s.pending) return sliceDone(c, state);
    return { actions: [], state };
  }
  return { actions: [], state: s };
}

/**
 * Áp version mới (#223, DEC-320): trước đây version mới bắt đầu lại từ 0 và mua / bán lại cả
 * tổng khối lượng. Nay giữ tiến độ (phần đã khớp tính vào tổng của version mới, lát kế tiếp, giờ bắt đầu), sổ cái (PM
 * chốt B2: phiên tiếp tục) và danh sách lát (fill muộn vẫn vào sổ cái theo chiều của chính lát). Đổi chiều Buy ↔ Sell:
 * tiến độ bắt đầu từ 0, sổ cái và các lát cũ chưa kết thúc vẫn được giữ. Lát còn đang chờ thì chưa áp (null, như
 * DEC-304).
 */
export function applyTwapVersion(c: TwapConfig, s: TwapState): TwapState | null {
  if (s.pending !== null) return null;
  const pos = dec(s.ledger.position);
  const records = Object.values(s.orders ?? {});
  const oldSide: Side =
    records.at(-1)?.side ?? (pos.isZero() ? c.side : pos.isPositive() ? "buy" : "sell");
  // Lát cũ thiếu chiều (state trước #223): chiều của version cũ.
  const orders = Object.fromEntries(
    Object.entries(s.orders ?? {}).map(([id, o]) => [id, { ...o, side: o.side ?? oldSide }]),
  );
  const ledger = carryLedger(s.ledger);
  if (oldSide !== c.side) return { ...initial(), ledger, lastPrice: s.lastPrice, orders };
  return {
    ...s,
    // Bot tự pause rồi được Resume cùng lúc áp version: chạy tiếp như Resume (DEC-240).
    phase: s.phase === "halted" ? (s.startedAt === null ? "waiting" : "running") : s.phase,
    ledger,
    orders,
    pendingAt: null,
  };
}

export const twap: StrategyModule<TwapConfig, TwapState> = {
  initialState: initial,
  step: stepTwap,
  applyVersion: applyTwapVersion,
  waiting: (c, s) => {
    const at = twapStartAt(c);
    return s.phase === "waiting" && at !== null ? { kind: "start_at", at } : null;
  },
};

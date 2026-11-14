import { dec, Decimal, ReasonCode } from "@drift/shared";

import { clOrdId, without } from "../core/ids";
import { applyFill, applyFunding, emptyLedger, netPnl, type Ledger } from "../core/ledger";
import { meetsMinimum, roundQty } from "../core/rounding";
import type {
  OrderIntent,
  StepContext,
  StepResult,
  StrategyAction,
  StrategyEvent,
  StrategyModule,
} from "../core/types";

import type { FundingArbConfig } from "./schema";

// S7 Funding Arbitrage (STRATEGIES.md, DEC-36). `maxGapPct` = chênh giá spot / perp (chặn vào lệnh); lệch khối lượng
// giữa hai chân dùng ngưỡng cố định `ARB_MAX_SIZE_GAP_PCT`.
// chờ funding TB 7 ngày ≥ ngưỡng → mua Spot + short Perp cùng khối lượng (mỗi chân nửa vốn) →
// ghi funding mỗi kỳ → 3 kỳ liên tiếp funding ≤ ngưỡng thoát thì đóng cả hai chân và chờ lại.
// Margin ratio dưới ngưỡng: không chuyển margin giữa engine (chưa xác nhận SoDEX cho phép) mà đóng cả hai
// chân và pause(INSUFFICIENT_BALANCE). Lỗ chạm max loss: đóng cả hai chân và stop.

export const EXIT_PERIODS = 3;

export interface FundingArbState {
  phase: "waiting" | "opening" | "in_position" | "closing" | "halted";
  spot: Ledger;
  perp: Ledger;
  prices: Record<string, string>;
  pending: Record<string, "spot" | "perp">;
  lowPeriods: number;
  cycle: number;
  /** Lý do khi đang đóng hai chân: tiếp tục chờ hay dừng. */
  after: StrategyAction | null;
  /** Một chân lúc mở bị từ chối: chờ chân kia khớp xong rồi đóng nó. */
  rejectedLeg: "spot" | "perp" | null;
  /**
   * Lệnh gần đây (P0.1): chân, chiều, khối lượng đặt / đã khớp. Cộng dồn các lần khớp, không cộng trùng fill phát lại,
   * nhận fill trễ. Thiếu ở state cũ: lệnh cũ coi như khớp đủ ở lần khớp đầu.
   */
  orders?: Record<string, ArbOrder>;
  /** Lúc đặt lô lệnh đang chờ (ms). */
  pendingSince?: number | null;
  /** Số lần đã gửi lệnh cân chân / lệnh đóng trong chu kỳ (để clOrdID không trùng). */
  balanceAttempt?: number;
  closeAttempt?: number;
}

export interface ArbOrder {
  leg: "spot" | "perp";
  side: "buy" | "sell";
  qty: string;
  filled: string;
}

/** Lô lệnh chờ quá lâu mà không có `orderDone` (tin mất) thì coi như xong với phần đã khớp (P0.1). */
export const ARB_PENDING_TIMEOUT_MS = 60_000;
/** Đóng hai chân không xong sau ngần này lần thì pause để người dùng xem. */
export const ARB_MAX_CLOSE_ATTEMPTS = 3;
const KEEP_ORDERS = 20;

function track(
  s: FundingArbState,
  list: readonly OrderIntent[],
  at: number | null,
): FundingArbState {
  const legOf = (o: OrderIntent): "spot" | "perp" => (o.engine === "spot" ? "spot" : "perp");
  return {
    ...s,
    pendingSince: list.length === 0 ? (s.pendingSince ?? null) : at,
    orders: Object.fromEntries(
      [
        ...Object.entries(s.orders ?? {}),
        ...list.map(
          (o) =>
            [o.clOrdID, { leg: legOf(o), side: o.side, qty: o.quantity, filled: "0" }] as const,
        ),
      ].slice(-KEEP_ORDERS),
    ),
  };
}

const initial = (): FundingArbState => ({
  phase: "waiting",
  spot: emptyLedger(),
  perp: emptyLedger(),
  prices: {},
  pending: {},
  lowPeriods: 0,
  cycle: 0,
  after: null,
  rejectedLeg: null,
});

function order(
  c: FundingArbConfig,
  ctx: StepContext,
  leg: "spot" | "perp",
  side: "buy" | "sell",
  qty: string,
  tag: string,
  reduceOnly = false,
): OrderIntent {
  return {
    clOrdID: clOrdId(ctx.botId, ctx.version, tag),
    market: leg === "spot" ? c.spotMarket : c.perpMarket,
    engine: leg === "spot" ? "spot" : "perps",
    side,
    type: "market",
    quantity: qty,
    timeInForce: "IOC",
    reduceOnly,
    tag,
  };
}

/**
 * Lãi / lỗ ròng của hai chân; chân đang có vị thế mà chưa có giá thì null ("Not available"), không định giá bằng 0
 * (trước đây làm max loss kích hoạt giả ngay sau khi vào lệnh).
 */
export function totalPnl(c: FundingArbConfig, s: FundingArbState): Decimal | null {
  const spotPrice = s.prices[c.spotMarket];
  const perpPrice = s.prices[c.perpMarket];
  if (spotPrice === undefined && !dec(s.spot.position).isZero()) return null;
  if (perpPrice === undefined && !dec(s.perp.position).isZero()) return null;
  return netPnl(s.spot, spotPrice ?? "0").add(netPnl(s.perp, perpPrice ?? "0"));
}

/**
 * Lệch khối lượng tối đa giữa hai chân trước khi cân lại (%, cố định, không có trên form). `maxGapPct` của người dùng là
 * chênh GIÁ giữa spot và perp (đúng tên field "Max price gap between legs"), PM chốt sau bản rà soát strategy.
 */
export const ARB_MAX_SIZE_GAP_PCT = "0.5";

function open(
  c: FundingArbConfig,
  s: FundingArbState,
  ctx: StepContext,
  at: number,
): StepResult<FundingArbState> {
  const price = s.prices[c.perpMarket];
  const spotPrice = s.prices[c.spotMarket];
  const spotRules = ctx.rules[c.spotMarket];
  const perpRules = ctx.rules[c.perpMarket];
  // Cần giá của cả hai chân để so chênh giá.
  if (
    price === undefined ||
    spotPrice === undefined ||
    spotRules === undefined ||
    perpRules === undefined
  )
    return { actions: [], state: s };
  // Chênh giá spot / perp vượt "Max price gap between legs": không vào lệnh, chờ lần funding sau.
  const gapPct = dec(price).sub(spotPrice).abs().div(spotPrice).mul(100);
  if (gapPct.gt(c.maxGapPct))
    return {
      actions: [
        {
          type: "log",
          decision: "Not entering",
          why: `Price gap between legs is ${gapPct.toDecimalPlaces(2).toString()}%, above ${c.maxGapPct}%.`,
        },
      ],
      state: s,
    };
  // Cùng khối lượng tài sản ở hai chân: làm tròn theo lot lớn hơn của hai market.
  const lot = Decimal.max(spotRules.stepSize, perpRules.stepSize).toString();
  const qty = roundQty(dec(c.investment).div(2).div(price), { ...spotRules, stepSize: lot });
  if (!meetsMinimum(price, qty, spotRules) || !meetsMinimum(price, qty, perpRules)) {
    return {
      actions: [{ type: "log", decision: "Not entering", why: "Leg size is below SoDEX minimum." }],
      state: s,
    };
  }
  const cycle = s.cycle + 1;
  const a = order(c, ctx, "spot", "buy", qty, `arb:${String(cycle)}:open:spot`);
  const b = order(c, ctx, "perp", "sell", qty, `arb:${String(cycle)}:open:perp`);
  return {
    actions: [
      { type: "place", order: a },
      { type: "place", order: b },
      { type: "log", decision: "Entered", why: `Funding average above ${c.enterFundingPct}%.` },
    ],
    state: track(
      {
        ...s,
        phase: "opening",
        cycle,
        pending: { [a.clOrdID]: "spot", [b.clOrdID]: "perp" },
        lowPeriods: 0,
        balanceAttempt: 0,
        closeAttempt: 0,
      },
      [a, b],
      at,
    ),
  };
}

function close(
  c: FundingArbConfig,
  s: FundingArbState,
  ctx: StepContext,
  after: StrategyAction | null,
  why: string,
  at: number | null = null,
): StepResult<FundingArbState> {
  const actions: StrategyAction[] = [];
  const placed: OrderIntent[] = [];
  const pending: FundingArbState["pending"] = {};
  const n = s.closeAttempt ?? 0;
  // Lần đóng đầu giữ clOrdID cũ; lần thử lại thêm số để SoDEX không coi là lệnh trùng (P0.1).
  const suffix = n === 0 ? "" : `:${String(n)}`;
  const spotRules = ctx.rules[c.spotMarket];
  const perpRules = ctx.rules[c.perpMarket];
  const spotQty =
    spotRules === undefined ? dec(s.spot.position) : dec(roundQty(dec(s.spot.position), spotRules));
  const perpQty =
    perpRules === undefined
      ? dec(s.perp.position)
      : dec(roundQty(dec(s.perp.position).abs(), perpRules)).neg();
  if (spotQty.gt(0)) {
    const o = order(
      c,
      ctx,
      "spot",
      "sell",
      spotQty.toString(),
      `arb:${String(s.cycle)}:close:spot${suffix}`,
    );
    actions.push({ type: "place", order: o });
    placed.push(o);
    pending[o.clOrdID] = "spot";
  }
  if (perpQty.lt(0)) {
    const o = order(
      c,
      ctx,
      "perp",
      "buy",
      perpQty.abs().toString(),
      `arb:${String(s.cycle)}:close:perp${suffix}`,
      true,
    );
    actions.push({ type: "place", order: o });
    placed.push(o);
    pending[o.clOrdID] = "perp";
  }
  actions.push({ type: "log", decision: "Closing both legs", why });
  if (actions.length === 1) {
    return {
      actions: after === null ? actions : [...actions, after],
      state: {
        ...s,
        phase: after === null ? "waiting" : "halted",
        pending: {},
        after: null,
        pendingSince: null,
      },
    };
  }
  return {
    actions,
    state: track(
      { ...s, phase: "closing", pending, after, closeAttempt: n + 1 },
      placed,
      at ?? s.pendingSince ?? null,
    ),
  };
}

function guards(
  c: FundingArbConfig,
  s: FundingArbState,
  ctx: StepContext,
): StepResult<FundingArbState> | null {
  if (s.phase !== "in_position") return null;
  const pnl = totalPnl(c, s);
  if (pnl?.lte(dec(c.maxLoss).neg()) === true) {
    return close(
      c,
      s,
      ctx,
      { type: "stop", reason: ReasonCode.stopLoss, close: true },
      "Loss reached the bot's max loss.",
    );
  }
  return null;
}

function onFill(
  c: FundingArbConfig,
  s: FundingArbState,
  ctx: StepContext,
  e: Extract<StrategyEvent, { type: "fill" }>,
): StepResult<FundingArbState> {
  const live = s.pending[e.clOrdID];
  const rec = s.orders?.[e.clOrdID];
  if (live === undefined && rec === undefined) return { actions: [], state: s };
  const leg = rec?.leg ?? live ?? "spot";
  // Chiều lưu lúc đặt; state cũ suy theo phase như trước.
  const side =
    rec?.side ??
    (s.phase === "closing" ? (leg === "spot" ? "sell" : "buy") : leg === "spot" ? "buy" : "sell");
  const room = rec === undefined ? dec(e.quantity) : dec(rec.qty).sub(rec.filled);
  const q = Decimal.min(room, e.quantity);
  if (!q.gt(0)) return { actions: [], state: s };
  const fee = q.lt(e.quantity) ? dec(e.fee).mul(q).div(e.quantity).toString() : e.fee;
  const filled = dec(rec?.filled ?? "0").add(q);
  let state: FundingArbState = {
    ...s,
    [leg]: applyFill(s[leg], side, e.price, q, fee),
    ...(rec === undefined
      ? {}
      : { orders: { ...s.orders, [e.clOrdID]: { ...rec, filled: filled.toString() } } }),
  };
  // Khớp trễ của lệnh đã xong: chỉ vào sổ cái.
  if (live === undefined) return guards(c, state, ctx) ?? { actions: [], state };
  // Chưa khớp đủ: chờ phần còn lại hoặc `orderDone`.
  if (rec !== undefined && filled.lt(rec.qty)) return { actions: [], state };
  state = { ...state, pending: without(state.pending, e.clOrdID) };
  return legsDone(c, state, ctx, e.at);
}

/** Một lệnh vừa xong: khi không còn lệnh nào chờ thì đi bước kế tiếp (đóng, vào vị thế, cân chân). */
function legsDone(
  c: FundingArbConfig,
  s: FundingArbState,
  ctx: StepContext,
  at: number,
): StepResult<FundingArbState> {
  let state = s;
  if (Object.keys(state.pending).length > 0) return { actions: [], state };
  state = { ...state, pendingSince: null };
  if (state.rejectedLeg !== null) {
    const rejected = state.rejectedLeg;
    return close(
      c,
      { ...state, rejectedLeg: null },
      ctx,
      { type: "pause", reason: ReasonCode.orderRejected },
      `The ${rejected} leg was rejected.`,
      at,
    );
  }
  const spotRules = ctx.rules[c.spotMarket];
  const perpRules = ctx.rules[c.perpMarket];
  const spotLeft =
    spotRules === undefined
      ? dec(state.spot.position)
      : dec(roundQty(dec(state.spot.position), spotRules));
  const perpLeft =
    perpRules === undefined
      ? dec(state.perp.position).abs()
      : dec(roundQty(dec(state.perp.position).abs(), perpRules));
  if (state.phase === "closing") {
    // Lệnh đóng kết thúc mà còn vị thế (khớp thiếu): đóng tiếp phần còn lại, tối đa vài lần rồi pause.
    if (spotLeft.gt(0) || perpLeft.gt(0)) {
      if ((state.closeAttempt ?? 0) >= ARB_MAX_CLOSE_ATTEMPTS)
        return {
          actions: [
            {
              type: "log",
              decision: "Paused",
              why: `Could not close both legs after ${String(ARB_MAX_CLOSE_ATTEMPTS)} tries.`,
            },
            { type: "pause", reason: ReasonCode.orderRejected },
          ],
          state: { ...state, phase: "halted", after: null },
        };
      return close(c, state, ctx, state.after, "Part of a leg is still open.", at);
    }
    const after = state.after;
    state = { ...state, phase: after === null ? "waiting" : "halted", after: null };
    return { actions: after === null ? [] : [after], state };
  }
  // Mở xong mà một chân không khớp gì: như chân bị từ chối, đóng chân kia rồi pause (S7 bước 2).
  if (spotLeft.isZero() !== perpLeft.isZero()) {
    const empty = spotLeft.isZero() ? "spot" : "perp";
    return close(
      c,
      state,
      ctx,
      { type: "pause", reason: ReasonCode.orderRejected },
      `The ${empty} leg did not fill.`,
      at,
    );
  }
  if (spotLeft.isZero() && perpLeft.isZero())
    return { actions: [], state: { ...state, phase: "waiting" } };
  state = { ...state, phase: "in_position" };
  // Hai chân lệch khối lượng quá ngưỡng thì cân lại bằng chân perp.
  const gap = dec(state.spot.position).add(state.perp.position);
  const qty = perpRules === undefined ? gap.abs().toString() : roundQty(gap.abs(), perpRules);
  const price = state.prices[c.perpMarket] ?? state.prices[c.spotMarket];
  if (
    gap.abs().div(state.spot.position).mul(100).gt(ARB_MAX_SIZE_GAP_PCT) &&
    dec(qty).gt(0) &&
    (perpRules === undefined || price === undefined || meetsMinimum(price, qty, perpRules))
  ) {
    const n = state.balanceAttempt ?? 0;
    // Mỗi lần cân chân một clOrdID riêng: lặp lại cùng clOrdID thì engine bỏ qua im lặng và bot kẹt (P0.1).
    const o = order(
      c,
      ctx,
      "perp",
      gap.isPositive() ? "sell" : "buy",
      qty,
      `arb:${String(state.cycle)}:balance${n === 0 ? "" : `:${String(n)}`}`,
    );
    return {
      actions: [{ type: "place", order: o }],
      state: track(
        {
          ...state,
          phase: "opening",
          pending: { [o.clOrdID]: "perp" },
          balanceAttempt: n + 1,
        },
        [o],
        at,
      ),
    };
  }
  return guards(c, state, ctx) ?? { actions: [], state };
}

export function stepFundingArb(
  c: FundingArbConfig,
  s: FundingArbState,
  e: StrategyEvent,
  ctx: StepContext,
): StepResult<FundingArbState> {
  if (e.type === "resumed") {
    if (s.phase !== "halted") return { actions: [], state: s };
    // Resume sau khi bot tự pause (DEC-240): giữ sổ cái hai chân. Còn vị thế thì theo dõi tiếp như đang giữ
    // (thoát theo funding / max loss như thường); không còn thì chờ funding đủ để vào lại.
    const open = !dec(s.spot.position).isZero() || !dec(s.perp.position).isZero();
    return {
      actions: [],
      state: {
        ...s,
        prices: { ...s.prices, ...e.prices },
        phase: open ? "in_position" : "waiting",
        pending: {},
        pendingSince: null,
        after: null,
        rejectedLeg: null,
        lowPeriods: 0,
      },
    };
  }
  if (s.phase === "halted") return { actions: [], state: s };
  switch (e.type) {
    case "tick": {
      const state = { ...s, prices: { ...s.prices, [e.market]: e.price } };
      return guards(c, state, ctx) ?? { actions: [], state };
    }
    case "fundingRate": {
      if (e.market !== c.perpMarket) return { actions: [], state: s };
      if (s.phase === "waiting") {
        return e.avg7d !== null && dec(e.avg7d).gte(c.enterFundingPct)
          ? open(c, s, ctx, e.at)
          : { actions: [], state: s };
      }
      if (s.phase !== "in_position") return { actions: [], state: s };
      const low = dec(e.current).lte(c.exitFundingPct) ? s.lowPeriods + 1 : 0;
      if (low >= EXIT_PERIODS)
        return close(
          c,
          { ...s, lowPeriods: 0 },
          ctx,
          null,
          `Funding at or below ${c.exitFundingPct}% for ${String(EXIT_PERIODS)} periods.`,
        );
      return { actions: [], state: { ...s, lowPeriods: low } };
    }
    case "fundingPaid": {
      if (e.market !== c.perpMarket) return { actions: [], state: s };
      const state = { ...s, perp: applyFunding(s.perp, e.amount) };
      return guards(c, state, ctx) ?? { actions: [], state };
    }
    case "marginRatio": {
      if (s.phase === "in_position" && dec(e.ratio).mul(100).lt(c.minMarginRatioPct)) {
        return close(
          c,
          s,
          ctx,
          { type: "pause", reason: ReasonCode.insufficientBalance },
          "Perp margin ratio fell below the limit.",
        );
      }
      return { actions: [], state: s };
    }
    case "orderReject": {
      const leg = s.pending[e.clOrdID];
      if (leg === undefined) return { actions: [], state: s };
      const pending = without(s.pending, e.clOrdID);
      // Một chân lỗi: đóng chân còn lại rồi pause (STRATEGIES.md S7 bước 2). Chân kia còn đang chờ khớp
      // thì đợi nó khớp xong mới đóng, để không bỏ sót vị thế không được hedge.
      if (Object.keys(pending).length > 0) {
        return {
          actions: [
            {
              type: "log",
              decision: "Leg rejected",
              why: `The ${leg} leg was rejected (${e.code}).`,
            },
          ],
          state: { ...s, pending, rejectedLeg: leg },
        };
      }
      return close(
        c,
        { ...s, pending },
        ctx,
        { type: "pause", reason: ReasonCode.orderRejected },
        `The ${leg} leg was rejected (${e.code}).`,
        e.at,
      );
    }
    case "fill":
      return onFill(c, s, ctx, e);
    case "orderDone": {
      if (s.pending[e.clOrdID] === undefined) return { actions: [], state: s };
      return legsDone(c, { ...s, pending: without(s.pending, e.clOrdID) }, ctx, e.at);
    }
    case "timer": {
      if (Object.keys(s.pending).length === 0) return { actions: [], state: s };
      // Lệnh chờ không bao giờ có `orderDone`: quá hạn thì coi như xong (state cũ thiếu giờ đặt thì bắt đầu đếm).
      if (s.pendingSince == null) return { actions: [], state: { ...s, pendingSince: e.at } };
      if (e.at - s.pendingSince < ARB_PENDING_TIMEOUT_MS) return { actions: [], state: s };
      return legsDone(c, { ...s, pending: {} }, ctx, e.at);
    }
    case "orderAck":
    case "positionSync":
    case "guard":
    case "leaderFill":
    case "leaderPosition":
      return { actions: [], state: s };
  }
}

export const fundingArb: StrategyModule<FundingArbConfig, FundingArbState> = {
  initialState: initial,
  step: stepFundingArb,
};

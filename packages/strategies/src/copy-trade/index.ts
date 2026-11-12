import { dec, Decimal, ReasonCode, RoundMode } from "@drift/shared";

import { clOrdId } from "../core/ids";
import { applyFill, applyFunding, emptyLedger, netPnl, type Ledger } from "../core/ledger";
import { meetsMinimum, roundPrice, roundQty } from "../core/rounding";
import type {
  OrderIntent,
  Side,
  StepContext,
  StepResult,
  StrategyAction,
  StrategyEvent,
  StrategyModule,
} from "../core/types";

import type { CopyTradeConfig } from "./schema";

// S12 Copy Trade (DEC-161, DEC-163). Một bot = một leader × nhiều market. Mỗi market có "market view" riêng (vị thế mục
// tiêu, sổ cái, lệnh đang chờ); `maxExposure` và `maxLoss` tính trên tổng mọi market. Trong mỗi market, bot giữ một vị
// thế MỤC TIÊU suy ra từ vị thế của leader rồi đặt lệnh để vị thế thật đuổi theo mục tiêu đó, mỗi market một lệnh:
// - Leader mở mới / đảo chiều: mục tiêu = cỡ theo `sizing` (fixed: `fixedNotional`; ratio: `ratioPct`% của leader).
// - Leader tăng / giảm: mục tiêu = vị thế hiện tại × |sau| / |trước| (giữ đúng tỷ lệ, kể cả khi đã bị cắt bởi trần).
// - Leader đóng: mục tiêu = 0.
// - `inverse`: đảo dấu mục tiêu.
// Chỉ copy vị thế leader mở SAU khi bot start (`tracking`): leader đang có sẵn vị thế thì chờ vị thế mới.
// Mở / tăng: IOC giới hạn tại giá tham chiếu ± maxSlippagePct; không khớp thì bỏ qua, không đuổi theo.
// Giảm / đóng: market reduce-only, luôn thực hiện (giảm rủi ro quan trọng hơn giá); thiếu thì thử lại, 3 lần thì pause.
// Tín hiệu cũ hơn `COPY.maxSignalAgeMs` chỉ được dùng để giảm / đóng, không dùng để mở.

export const COPY = {
  /** Tín hiệu mở / tăng cũ hơn mức này (tính từ lúc leader khớp) thì bỏ qua. */
  maxSignalAgeMs: 5_000,
  /** Số lần lệnh giảm / đóng liên tiếp không xong thì pause. */
  maxReduceAttempts: 3,
  /** Số lần liên tiếp SoDEX từ chối lệnh mở thì pause. */
  maxOpenRejects: 3,
  /** Số lệnh gần nhất được nhớ để nhận fill tới trễ. */
  keepOrders: 20,
} as const;

type OrderKind = "open" | "reduce";

/** Config nhìn từ một market: như config của bot, thêm `market` đang xét; trần đã trừ phần của market khác. */
export type MarketConfig = Omit<CopyTradeConfig, "markets"> & { market: string };

export interface CopyInflight {
  id: string;
  kind: OrderKind;
  side: Side;
  qty: string;
  filled: string;
  /** Mục tiêu lúc đặt lệnh. Lệnh xong mà mục tiêu đã đổi (tín hiệu mới tới trong lúc chờ) thì giữ mục tiêu mới. */
  aim: string;
}

/** State của một market (logic DEC-161 giữ nguyên) kèm các trường dùng chung của bot. */
export interface CopyMarketView {
  phase: "following" | "halted";
  ledger: Ledger;
  lastPrice: string | null;
  /** Vị thế leader gần nhất đã biết (có dấu); null trước tín hiệu đầu tiên. */
  leaderPos: string | null;
  /** Bot đang giữ phần copy của vị thế hiện tại của leader. */
  tracking: boolean;
  /** Vị thế mục tiêu của bot (có dấu, đã tính `inverse`). */
  target: string;
  /** Giá tham chiếu cho lệnh mở của tín hiệu gần nhất, và lúc leader khớp. */
  refPrice: string | null;
  refAt: number;
  inflight: CopyInflight | null;
  /** `COPY.keepOrders` lệnh gần nhất: fill tới sau `orderDone` vẫn ghi đúng chiều vào sổ cái. */
  orders: Record<string, { side: Side; kind: OrderKind; market?: string }>;
  seq: number;
  reduceAttempts: number;
  openRejects: number;
  signals: number;
  copied: number;
  skipped: number;
  /** Độ trễ của tín hiệu gần nhất (ms, lúc engine nhận − lúc leader khớp). */
  lastLatencyMs: number | null;
  lastLeaderAt: number | null;
}

const initialView = (): CopyMarketView => ({
  phase: "following",
  ledger: emptyLedger(),
  lastPrice: null,
  leaderPos: null,
  tracking: false,
  target: "0",
  refPrice: null,
  refAt: 0,
  inflight: null,
  orders: {},
  seq: 0,
  reduceAttempts: 0,
  openRejects: 0,
  signals: 0,
  copied: 0,
  skipped: 0,
  lastLatencyMs: null,
  lastLeaderAt: null,
});

const none = (s: CopyMarketView): StepResult<CopyMarketView> => ({ actions: [], state: s });
const log = (decision: string, why: string): StrategyAction => ({ type: "log", decision, why });
const dirSign = (c: MarketConfig): number => (c.direction === "inverse" ? -1 : 1);
const pos = (s: CopyMarketView): Decimal => dec(s.ledger.position);
const fmt = (d: Decimal, dp = 8): string => d.toDecimalPlaces(dp).toString();

export type LeaderMove = "open" | "increase" | "decrease" | "close" | "flip" | "none";

/** Phân loại thay đổi vị thế của leader từ `prev` sang `next` (có dấu). */
export function leaderMove(prev: Decimal, next: Decimal): LeaderMove {
  if (next.eq(prev)) return "none";
  if (next.isZero()) return "close";
  if (prev.isZero()) return "open";
  if (next.isNegative() !== prev.isNegative()) return "flip";
  return next.abs().gt(prev.abs()) ? "increase" : "decrease";
}

/** Cỡ (khối lượng, không dấu) cho một vị thế mới khi leader đang giữ `leaderAbs` ở giá `price`. */
export function freshSize(
  c: Pick<CopyTradeConfig, "sizing" | "ratioPct" | "fixedNotional">,
  leaderAbs: Decimal,
  price: Decimal,
): Decimal {
  if (c.sizing === "ratio") return leaderAbs.mul(dec(c.ratioPct ?? "0")).div(100);
  return dec(c.fixedNotional ?? "0").div(price);
}

/** Cắt mục tiêu theo `maxExposure` (cả vị thế) và `maxNotionalPerTrade` (phần tăng thêm). Chỉ áp cho chiều tăng. */
export function capTarget(
  c: Pick<CopyTradeConfig, "maxExposure" | "maxNotionalPerTrade">,
  current: Decimal,
  target: Decimal,
  price: Decimal,
): Decimal {
  const sameSide =
    current.isZero() || target.isZero() || current.isNegative() === target.isNegative();
  const base = sameSide ? current.abs() : new Decimal(0);
  if (target.abs().lte(base)) return target;
  // Trần không bao giờ thấp hơn phần đang giữ: tín hiệu tăng không được làm bot tự giảm vị thế.
  const maxAbs = Decimal.max(
    base,
    Decimal.min(dec(c.maxExposure).div(price), base.add(dec(c.maxNotionalPerTrade).div(price))),
  );
  return target.abs().gt(maxAbs) ? maxAbs.mul(target.isNegative() ? -1 : 1) : target;
}

function intent(
  c: MarketConfig,
  s: CopyMarketView,
  ctx: StepContext,
  kind: OrderKind,
  side: Side,
  qty: string,
  price?: string,
): OrderIntent {
  return {
    clOrdID: clOrdId(ctx.botId, ctx.version, `copy:${String(s.seq)}`),
    market: c.market,
    engine: "perps",
    side,
    type: kind === "reduce" ? "market" : "limit",
    ...(price === undefined ? {} : { price }),
    quantity: qty,
    timeInForce: "IOC",
    reduceOnly: kind === "reduce",
    tag: `copy:${kind}:${String(s.seq)}`,
  };
}

function place(
  c: MarketConfig,
  s: CopyMarketView,
  ctx: StepContext,
  kind: OrderKind,
  side: Side,
  qty: string,
  price?: string,
): StepResult<CopyMarketView> {
  const o = intent(c, s, ctx, kind, side, qty, price);
  return {
    actions: [{ type: "place", order: o }],
    state: {
      ...s,
      seq: s.seq + 1,
      inflight: { id: o.clOrdID, kind, side, qty, filled: "0", aim: s.target },
      orders: Object.fromEntries(
        [...Object.entries(s.orders), [o.clOrdID, { side, kind }] as const].slice(-COPY.keepOrders),
      ),
    },
  };
}

/** Bỏ lệnh mở đang chờ: giữ vị thế hiện tại làm mục tiêu, không đuổi theo. */
function settleOpen(s: CopyMarketView): CopyMarketView {
  const p = pos(s);
  return { ...s, target: p.toString(), tracking: s.tracking && !p.isZero() };
}

/** Đặt lệnh để vị thế thật đi tới `target`. Mỗi lúc chỉ một lệnh. */
function reconcile(
  c: MarketConfig,
  s: CopyMarketView,
  ctx: StepContext,
  now: number,
): StepResult<CopyMarketView> {
  if (s.phase !== "following" || s.inflight !== null) return none(s);
  const rules = ctx.rules[c.market];
  if (rules === undefined) return none(s);
  const p = pos(s);
  const t = dec(s.target);
  if (t.eq(p)) return none(s);
  const flips = !p.isZero() && !t.isZero() && p.isNegative() !== t.isNegative();
  if (!p.isZero() && (t.isZero() || flips || t.abs().lt(p.abs()))) {
    const qty = roundQty(t.isZero() || flips ? p.abs() : p.abs().sub(t.abs()), rules);
    if (!dec(qty).gt(0))
      return none({ ...s, target: t.isZero() || flips ? s.target : p.toString() });
    return place(c, s, ctx, "reduce", p.isPositive() ? "sell" : "buy", qty);
  }
  // Mở hoặc tăng.
  const ref = c.leaderSource === "sodex" ? s.refPrice : s.lastPrice;
  if (ref === null) return none(settleOpen(s));
  if (now - s.refAt > COPY.maxSignalAgeMs)
    return {
      actions: [log("Skipped", "Signal too old to open a position.")],
      state: { ...settleOpen(s), skipped: s.skipped + 1 },
    };
  const buy = t.gt(p);
  const slip = dec(c.maxSlippagePct).div(100);
  const limit = dec(ref).mul(buy ? slip.add(1) : new Decimal(1).sub(slip));
  if (s.lastPrice !== null && (buy ? dec(s.lastPrice).gt(limit) : dec(s.lastPrice).lt(limit)))
    return {
      actions: [
        log(
          "Skipped",
          `Price moved more than ${c.maxSlippagePct}% from ${fmt(dec(ref))} before the order.`,
        ),
      ],
      state: { ...settleOpen(s), skipped: s.skipped + 1 },
    };
  const price = roundPrice(limit, rules, buy ? RoundMode.down : RoundMode.up);
  const qty = roundQty(t.sub(p).abs(), rules);
  if (!meetsMinimum(price, qty, rules))
    return {
      actions: [log("Skipped", "Copy size is below the SoDEX minimum order size.")],
      state: { ...settleOpen(s), skipped: s.skipped + 1 },
    };
  return place(c, s, ctx, "open", buy ? "buy" : "sell", qty, price);
}

/** Lệnh đang chờ đã xong (khớp đủ, `orderDone` hoặc bị từ chối): cập nhật mục tiêu rồi đặt lệnh kế tiếp. */
function complete(
  c: MarketConfig,
  s0: CopyMarketView,
  ctx: StepContext,
  now: number,
  rejected: boolean,
): StepResult<CopyMarketView> {
  const f = s0.inflight;
  if (f === null) return none(s0);
  const s: CopyMarketView = { ...s0, inflight: null };
  const filled = dec(f.filled);
  if (f.kind === "open" && s.target !== f.aim) {
    // Tín hiệu mới đã đổi mục tiêu trong lúc chờ: theo mục tiêu mới.
    const next = { ...s, openRejects: rejected ? s.openRejects : 0 };
    return reconcile(c, filled.gt(0) ? { ...next, copied: s.copied + 1 } : next, ctx, now);
  }
  if (f.kind === "open") {
    if (rejected) {
      const n = s.openRejects + 1;
      if (n >= COPY.maxOpenRejects)
        return {
          actions: [
            log("Paused", `SoDEX rejected the copy order ${String(n)} times in a row.`),
            { type: "pause", reason: ReasonCode.orderRejected },
          ],
          state: { ...settleOpen(s), phase: "halted", openRejects: n },
        };
      return {
        actions: [log("Skipped", "SoDEX rejected the copy order.")],
        state: { ...settleOpen(s), openRejects: n, skipped: s.skipped + 1 },
      };
    }
    const base = { ...settleOpen(s), openRejects: 0 };
    if (filled.isZero())
      return {
        actions: [log("Skipped", `No fill within ${c.maxSlippagePct}% of the leader's price.`)],
        state: { ...base, skipped: s.skipped + 1 },
      };
    return none({ ...base, copied: s.copied + 1 });
  }
  // Giảm / đóng: phải xong. Thiếu thì thử lại bằng market reduce-only.
  const p = pos(s);
  const t = dec(s.target);
  const done =
    t.isZero() || (!p.isZero() && t.isNegative() !== p.isNegative())
      ? p.isZero() || dec(roundQty(p.abs(), ctx.rules[c.market] ?? fallbackRules)).isZero()
      : p.abs().lte(t.abs());
  if (done) {
    const next = { ...s, reduceAttempts: 0, copied: s.copied + (filled.gt(0) ? 1 : 0) };
    return reconcile(c, next, ctx, now);
  }
  const n = s.reduceAttempts + 1;
  if (n >= COPY.maxReduceAttempts)
    return {
      actions: [
        log("Paused", `Could not reduce the position after ${String(n)} tries.`),
        { type: "pause", reason: ReasonCode.orderRejected },
      ],
      state: { ...s, phase: "halted", reduceAttempts: n },
    };
  return reconcile(c, { ...s, reduceAttempts: n }, ctx, now);
}

const fallbackRules = { tickSize: "0", stepSize: "0", minQuantity: "0", minNotional: "0" };

function onLeaderFill(
  c: MarketConfig,
  s: CopyMarketView,
  ctx: StepContext,
  e: Extract<StrategyEvent, { type: "leaderFill" }>,
): StepResult<CopyMarketView> {
  if (e.market !== c.market) return none(s);
  const next = dec(e.positionAfter);
  const signedFill = dec(e.quantity).mul(e.side === "buy" ? 1 : -1);
  const prev = s.leaderPos === null ? next.sub(signedFill) : dec(s.leaderPos);
  const move = leaderMove(prev, next);
  const latency = Math.max(0, e.at - e.leaderAt);
  const base: CopyMarketView = {
    ...s,
    leaderPos: next.toString(),
    lastLatencyMs: latency,
    lastLeaderAt: e.leaderAt,
    signals: s.signals + 1,
  };
  const ref = dec(e.price);
  const fresh = latency <= COPY.maxSignalAgeMs;
  const p = pos(s);
  const sign = dirSign(c);
  switch (move) {
    case "none":
      return none(base);
    case "close":
      if (!s.tracking) return none(base);
      return reconcile(c, { ...base, target: "0", tracking: false }, ctx, e.at);
    case "open":
    case "flip": {
      if (!fresh) {
        const st = { ...base, skipped: s.skipped + 1, tracking: false };
        const r =
          s.tracking && !p.isZero() ? reconcile(c, { ...st, target: "0" }, ctx, e.at) : none(st);
        return {
          actions: [log("Skipped", `Signal arrived ${String(latency)} ms late.`), ...r.actions],
          state: r.state,
        };
      }
      const size = freshSize(c, next.abs(), ref).mul(next.isNegative() ? -sign : sign);
      // Đảo chiều: phần đang giữ không còn là "vị thế hiện tại" để giữ lại, nên cắt trần tính từ 0.
      const target = capTarget(c, s.tracking ? p : new Decimal(0), size, ref);
      const st: CopyMarketView = {
        ...base,
        tracking: true,
        target: target.toString(),
        refPrice: e.price,
        refAt: e.leaderAt,
      };
      const r = reconcile(c, st, ctx, e.at);
      const what = move === "open" ? "opened" : "flipped to";
      return {
        actions: [
          log(
            "Copy",
            `Leader ${what} ${next.isNegative() ? "short" : "long"} ${fmt(next.abs())} at ${e.price}.`,
          ),
          ...r.actions,
        ],
        state: r.state,
      };
    }
    case "increase":
    case "decrease": {
      if (!s.tracking || p.isZero()) return none(base);
      if (move === "increase" && !fresh)
        return {
          actions: [log("Skipped", `Signal arrived ${String(latency)} ms late.`)],
          state: { ...base, skipped: s.skipped + 1 },
        };
      const scaled = p.mul(next.abs()).div(prev.abs());
      const target = move === "increase" ? capTarget(c, p, scaled, ref) : scaled;
      const st: CopyMarketView = {
        ...base,
        target: target.toString(),
        ...(move === "increase" ? { refPrice: e.price, refAt: e.leaderAt } : {}),
      };
      const pct = next.abs().div(prev.abs()).sub(1).mul(100).abs().toDecimalPlaces(1);
      const r = reconcile(c, st, ctx, e.at);
      return {
        actions: [
          log(
            "Copy",
            `Leader ${move === "increase" ? "added" : "cut"} ${pct.toString()}% of the position at ${e.price}.`,
          ),
          ...r.actions,
        ],
        state: r.state,
      };
    }
  }
}

function onLeaderPosition(
  c: MarketConfig,
  s: CopyMarketView,
  ctx: StepContext,
  e: Extract<StrategyEvent, { type: "leaderPosition" }>,
): StepResult<CopyMarketView> {
  if (e.market !== c.market) return none(s);
  const next = dec(e.size);
  const base: CopyMarketView = { ...s, leaderPos: next.toString() };
  if (s.leaderPos === null || !s.tracking) return none(base);
  const prev = dec(s.leaderPos);
  const move = leaderMove(prev, next);
  const p = pos(s);
  // Fill bị lỡ: chỉ bù chiều giảm rủi ro. Leader tăng thì không đuổi theo.
  if (move === "close" || move === "flip") {
    const r = reconcile(c, { ...base, target: "0", tracking: false }, ctx, e.at);
    return {
      actions: [
        log("Catch up", "Leader closed the position while the stream was down."),
        ...r.actions,
      ],
      state: r.state,
    };
  }
  if (move === "decrease" && !p.isZero()) {
    const r = reconcile(
      c,
      { ...base, target: p.mul(next.abs()).div(prev.abs()).toString() },
      ctx,
      e.at,
    );
    return {
      actions: [
        log("Catch up", "Leader cut the position while the stream was down."),
        ...r.actions,
      ],
      state: r.state,
    };
  }
  return none(base);
}

function guards(
  c: MarketConfig,
  s: CopyMarketView,
  ctx: StepContext,
  now: number,
): StepResult<CopyMarketView> | null {
  const price = s.lastPrice;
  if (price === null) return null;
  if (netPnl(s.ledger, price).lte(dec(c.maxLoss).neg()))
    return {
      actions: [
        log("Copy stopped", `Net loss reached the max loss of ${c.maxLoss}.`),
        { type: "stop", reason: ReasonCode.botMaxLoss, close: true },
      ],
      state: { ...s, phase: "halted" },
    };
  const p = pos(s);
  if (p.isZero() || s.inflight !== null || !dec(s.target).eq(p)) return null;
  const move = dec(price)
    .sub(s.ledger.avgCost)
    .div(s.ledger.avgCost)
    .mul(100)
    .mul(p.isPositive() ? 1 : -1);
  const hit =
    c.stopLossPct !== undefined && move.lte(dec(c.stopLossPct).neg())
      ? "Stop loss"
      : c.takeProfitPct !== undefined && move.gte(c.takeProfitPct)
        ? "Take profit"
        : null;
  if (hit === null) return null;
  const r = reconcile(c, { ...s, target: "0", tracking: false }, ctx, now);
  return {
    actions: [
      log(
        hit,
        `Price moved ${fmt(move, 2)}% from the average price. Waiting for the leader's next position.`,
      ),
      ...r.actions,
    ],
    state: r.state,
  };
}

function onFill(
  c: MarketConfig,
  s: CopyMarketView,
  ctx: StepContext,
  e: Extract<StrategyEvent, { type: "fill" }>,
): StepResult<CopyMarketView> {
  const order = s.orders[e.clOrdID];
  if (order === undefined) return none(s);
  const ledger = applyFill(s.ledger, order.side, e.price, e.quantity, e.fee);
  let st: CopyMarketView = { ...s, ledger };
  if (s.inflight?.id !== e.clOrdID) {
    // Khớp trễ sau khi lệnh đã xong. Lệnh mở và chưa có tín hiệu mới (mục tiêu = vị thế cũ): nhận vị thế mới làm mục
    // tiêu. Có tín hiệu mới rồi thì giữ mục tiêu đó; reconcile đưa vị thế về đúng.
    if (order.kind === "open" && s.tracking && dec(s.target).eq(pos(s)))
      st = { ...st, target: ledger.position };
    return s.phase === "halted" ? none(st) : reconcile(c, st, ctx, e.at);
  }
  const filled = dec(s.inflight.filled).add(e.quantity);
  st = { ...st, inflight: { ...s.inflight, filled: filled.toString() } };
  if (s.phase === "halted") return none(st);
  return filled.gte(s.inflight.qty) ? complete(c, st, ctx, e.at, false) : none(st);
}

function stepMarket(
  c: MarketConfig,
  s: CopyMarketView,
  e: StrategyEvent,
  ctx: StepContext,
): StepResult<CopyMarketView> {
  if (s.phase === "halted" && e.type !== "fill" && e.type !== "orderDone") return none(s);
  switch (e.type) {
    case "tick": {
      if (e.market !== c.market) return none(s);
      const st = { ...s, lastPrice: e.price };
      return guards(c, st, ctx, e.at) ?? none(st);
    }
    case "timer":
      // Lệnh giảm còn thiếu (ví dụ sau khi khớp trễ) được đặt lại ở nhịp đồng hồ.
      return reconcile(c, s, ctx, e.at);
    case "leaderFill":
      return onLeaderFill(c, s, ctx, e);
    case "leaderPosition":
      return onLeaderPosition(c, s, ctx, e);
    case "fill":
      return onFill(c, s, ctx, e);
    case "orderDone":
      if (s.inflight?.id !== e.clOrdID || s.phase === "halted") return none(s);
      return complete(c, s, ctx, e.at, false);
    case "orderReject": {
      // Lệnh bị từ chối không bao giờ khớp: quên nó.
      const orders = Object.fromEntries(
        Object.entries(s.orders).filter(([id]) => id !== e.clOrdID),
      );
      const st = { ...s, orders };
      if (s.inflight?.id !== e.clOrdID) return none(st);
      return complete(c, st, ctx, e.at, true);
    }
    case "fundingPaid":
      return e.market === c.market
        ? none({ ...s, ledger: applyFunding(s.ledger, e.amount) })
        : none(s);
    case "orderAck":
    case "fundingRate":
    case "marginRatio":
    case "positionSync":
      return none(s);
  }
}

/* ------------------------------------------------------------------------------------------------------------------
 * Nhiều market (DEC-163 mục 6). Mỗi market chạy logic ở trên trên "market view" của nó; các trường dùng chung (phase,
 * lệnh đã gửi, seq cho clOrdID, bộ đếm) nằm ở state của bot.
 * ---------------------------------------------------------------------------------------------------------------- */

/** Phần riêng của một market trong state. */
export type CopyMarketState = Pick<
  CopyMarketView,
  | "ledger"
  | "lastPrice"
  | "leaderPos"
  | "tracking"
  | "target"
  | "refPrice"
  | "refAt"
  | "inflight"
  | "reduceAttempts"
  | "openRejects"
>;

export interface CopyTradeState {
  phase: "following" | "halted";
  markets: Record<string, CopyMarketState>;
  /** Lệnh gần nhất của mọi market, kèm market để fill tới trễ về đúng sổ cái. */
  orders: Record<string, { side: Side; kind: OrderKind; market: string }>;
  seq: number;
  signals: number;
  copied: number;
  skipped: number;
  lastLatencyMs: number | null;
  lastLeaderAt: number | null;
}

const sliceOf = (v: CopyMarketView): CopyMarketState => ({
  ledger: v.ledger,
  lastPrice: v.lastPrice,
  leaderPos: v.leaderPos,
  tracking: v.tracking,
  target: v.target,
  refPrice: v.refPrice,
  refAt: v.refAt,
  inflight: v.inflight,
  reduceAttempts: v.reduceAttempts,
  openRejects: v.openRejects,
});

const emptySlice = (): CopyMarketState => sliceOf(initialView());

const initial = (): CopyTradeState => ({
  phase: "following",
  markets: {},
  orders: {},
  seq: 0,
  signals: 0,
  copied: 0,
  skipped: 0,
  lastLatencyMs: null,
  lastLeaderAt: null,
});

/** State cũ (một market, trước DEC-163) → state nhiều market. */
export function normalizeCopyState(c: CopyTradeConfig, raw: unknown): CopyTradeState {
  const r = (raw ?? {}) as Partial<CopyTradeState> & Partial<CopyMarketView>;
  if (r.markets !== undefined) return { ...initial(), ...r, markets: r.markets };
  if (r.ledger === undefined) return initial();
  const legacy = { ...initialView(), ...r } as CopyMarketView;
  const market = c.markets[0] ?? "";
  return {
    phase: legacy.phase,
    markets: { [market]: sliceOf(legacy) },
    orders: Object.fromEntries(
      Object.entries(legacy.orders).map(([id, o]) => [id, { ...o, market }]),
    ),
    seq: legacy.seq,
    signals: legacy.signals,
    copied: legacy.copied,
    skipped: legacy.skipped,
    lastLatencyMs: legacy.lastLatencyMs,
    lastLeaderAt: legacy.lastLeaderAt,
  };
}

const priceOf = (m: CopyMarketState): Decimal | null => {
  if (m.lastPrice !== null) return dec(m.lastPrice);
  return dec(m.ledger.avgCost).gt(0) ? dec(m.ledger.avgCost) : null;
};

/** Config nhìn từ market `m`: trần exposure và max loss đã trừ phần của các market khác. */
function configFor(c: CopyTradeConfig, s: CopyTradeState, m: string): MarketConfig {
  let usedExposure = new Decimal(0);
  let othersNet = new Decimal(0);
  for (const [k, v] of Object.entries(s.markets)) {
    if (k === m) continue;
    const price = priceOf(v);
    if (price === null) continue;
    usedExposure = usedExposure.add(dec(v.ledger.position).abs().mul(price));
    othersNet = othersNet.add(netPnl(v.ledger, price.toString()));
  }
  // `markets` thừa trong object không ảnh hưởng logic một market.
  return {
    ...c,
    market: m,
    maxExposure: Decimal.max(0, dec(c.maxExposure).sub(usedExposure)).toString(),
    // Tổng lỗ chạm `maxLoss` ⟺ lỗ của market này chạm `maxLoss` + lãi ròng của các market khác.
    maxLoss: dec(c.maxLoss).add(othersNet).toString(),
  };
}

function viewOf(s: CopyTradeState, m: string): CopyMarketView {
  return {
    ...(s.markets[m] ?? emptySlice()),
    phase: s.phase,
    orders: s.orders,
    seq: s.seq,
    signals: s.signals,
    copied: s.copied,
    skipped: s.skipped,
    lastLatencyMs: s.lastLatencyMs,
    lastLeaderAt: s.lastLeaderAt,
  };
}

function merge(s: CopyTradeState, m: string, v: CopyMarketView): CopyTradeState {
  const orders: CopyTradeState["orders"] = {};
  for (const [id, o] of Object.entries(v.orders))
    orders[id] = { side: o.side, kind: o.kind, market: o.market ?? m };
  return {
    phase: v.phase,
    markets: { ...s.markets, [m]: sliceOf(v) },
    orders,
    seq: v.seq,
    signals: v.signals,
    copied: v.copied,
    skipped: v.skipped,
    lastLatencyMs: v.lastLatencyMs,
    lastLeaderAt: v.lastLeaderAt,
  };
}

function runMarket(
  c: CopyTradeConfig,
  s: CopyTradeState,
  m: string,
  e: StrategyEvent,
  ctx: StepContext,
  over: Partial<MarketConfig> = {},
): StepResult<CopyTradeState> {
  const r = stepMarket({ ...configFor(c, s, m), ...over }, viewOf(s, m), e, ctx);
  return { actions: r.actions, state: merge(s, m, r.state) };
}

const MIN_HOLD_SKIP =
  "This trader now trades too fast to copy (typical hold under 15 minutes). New positions are not copied; cuts and closes still are.";

function onLeaderFillMulti(
  c: CopyTradeConfig,
  s: CopyTradeState,
  e: Extract<StrategyEvent, { type: "leaderFill" }>,
  ctx: StepContext,
): StepResult<CopyTradeState> {
  if (e.allowance === undefined) return runMarket(c, s, e.market, e, ctx);
  // Hạn mức phân bổ (thanh khoản / minHold) chỉ cắt phần mở / tăng: thay `maxNotionalPerTrade` nhỏ hơn.
  const allowance = Decimal.max(0, dec(e.allowance));
  const cap = Decimal.min(allowance, dec(c.maxNotionalPerTrade));
  const r = runMarket(c, s, e.market, e, ctx, { maxNotionalPerTrade: cap.toString() });
  if (allowance.gte(dec(c.maxNotionalPerTrade))) return r;
  const opens = r.actions.some((a) => a.type === "place" && !a.order.reduceOnly);
  const prevPos = dec(s.markets[e.market]?.leaderPos ?? "0");
  const move = leaderMove(prevPos, dec(e.positionAfter));
  if (move !== "open" && move !== "flip" && move !== "increase") return r;
  const why =
    e.allowanceReason === "min_hold"
      ? MIN_HOLD_SKIP
      : opens
        ? `Order size cut to ${fmt(cap, 2)} USD so copies don't take more than half of the SoDEX order book.`
        : "Not enough SoDEX liquidity near the price to copy this trade.";
  return {
    actions: [
      log(opens && e.allowanceReason !== "min_hold" ? "Copy" : "Skipped", why),
      ...r.actions,
    ],
    state: opens
      ? r.state
      : { ...r.state, skipped: r.state.skipped + (r.state.skipped === s.skipped ? 1 : 0) },
  };
}

export function stepCopyTrade(
  c: CopyTradeConfig,
  s0: CopyTradeState,
  e: StrategyEvent,
  ctx: StepContext,
): StepResult<CopyTradeState> {
  const s = normalizeCopyState(c, s0);
  switch (e.type) {
    case "tick":
    case "fundingPaid":
    case "leaderPosition":
      return c.markets.includes(e.market) ? runMarket(c, s, e.market, e, ctx) : none2(s);
    case "leaderFill":
      return c.markets.includes(e.market) ? onLeaderFillMulti(c, s, e, ctx) : none2(s);
    case "fill":
    case "orderDone":
    case "orderReject": {
      const m = s.orders[e.clOrdID]?.market;
      return m === undefined ? none2(s) : runMarket(c, s, m, e, ctx);
    }
    case "timer": {
      let st = s;
      const actions: StrategyAction[] = [];
      for (const m of c.markets) {
        const r = runMarket(c, st, m, e, ctx);
        st = r.state;
        actions.push(...r.actions);
      }
      return { actions, state: st };
    }
    case "orderAck":
    case "fundingRate":
    case "marginRatio":
    case "positionSync":
      return none2(s);
  }
}

const none2 = (s: CopyTradeState): StepResult<CopyTradeState> => ({ actions: [], state: s });

/** Vị thế đang giữ theo market (cho engine đóng khi Stop, cho API hiển thị). */
export function copyPositions(s: CopyTradeState): Record<string, string> {
  return Object.fromEntries(
    Object.entries(s.markets)
      .filter(([, v]) => !dec(v.ledger.position).isZero())
      .map(([m, v]) => [m, v.ledger.position]),
  );
}

/** Lãi / lỗ ròng cộng mọi market (giá gần nhất của từng market; thiếu giá thì dùng giá vốn). */
export function copyNet(s: CopyTradeState): Decimal {
  let total = new Decimal(0);
  for (const v of Object.values(s.markets)) {
    const price = priceOf(v);
    total = total.add(price === null ? netPnl(v.ledger, "0") : netPnl(v.ledger, price.toString()));
  }
  return total;
}

export const copyTrade: StrategyModule<CopyTradeConfig, CopyTradeState> = {
  initialState: initial,
  step: stepCopyTrade,
};

/** State có phải dạng nhiều market (DEC-163) không — cho code đọc `bot_runtime.state` mà không biết chiến lược. */
export function isMultiMarketCopyState(state: unknown): state is CopyTradeState {
  return (
    typeof state === "object" &&
    state !== null &&
    "markets" in state &&
    typeof state.markets === "object"
  );
}

/** Tổng sổ cái của mọi market (đã chốt, phí, funding) và các vị thế đang mở theo market. */
export function copyLedgerTotals(s: CopyTradeState): {
  realized: string;
  fees: string;
  funding: string;
  positions: { market: string; ledger: Ledger }[];
} {
  let realized = new Decimal(0);
  let fees = new Decimal(0);
  let funding = new Decimal(0);
  const positions: { market: string; ledger: Ledger }[] = [];
  for (const [market, v] of Object.entries(s.markets)) {
    realized = realized.add(v.ledger.realized);
    fees = fees.add(v.ledger.fees);
    funding = funding.add(v.ledger.funding);
    if (!dec(v.ledger.position).isZero()) positions.push({ market, ledger: v.ledger });
  }
  return {
    realized: realized.toString(),
    fees: fees.toString(),
    funding: funding.toString(),
    positions,
  };
}

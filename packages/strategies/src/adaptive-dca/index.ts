import { dec, Decimal, ReasonCode, RoundMode } from "@drift/shared";

import { clOrdId } from "../core/ids";
import { applyFill, applyFunding, emptyLedger, netPnl, type Ledger } from "../core/ledger";
import { meetsMinimum, roundPrice, roundQty } from "../core/rounding";
import type {
  MinuteCandle,
  OrderIntent,
  StepContext,
  StepResult,
  StrategyAction,
  StrategyEvent,
  StrategyModule,
} from "../core/types";
import {
  atr,
  detectRegime,
  toFiveMinute,
  validCandles,
  type FarmRegime,
} from "../volume-farm/signal";

import type { AdaptiveDcaConfig } from "./schema";

// S11 AI Adaptive DCA (DEC-107). Một chu kỳ:
//   idle ──regime hợp lệ + RSI──▶ entering (base, market) ──fill──▶ in_cycle ──TP khớp──▶ idle
//                                                                  └─Exit / hard stop──▶ exiting ──đóng──▶ idle (cooldown)
// - Chỉ MỘT lệnh DCA nằm trên sổ: đặt ở giá khớp gần nhất ∓ ATR5m × atrMultiplier × 1.2^(k−1), ATR đo lại mỗi lần
//   đặt. Thị trường mạnh → lệnh xa ra; yên → gần lại; không nhỏ hơn ADCA_MIN_STEP_PCT để phí không ăn hết lãi.
// - Không bao giờ vượt `maxExposure` (tổng giá trị vị thế) và `maxSafetyOrders`: hết chỗ thì giữ, không thêm vốn.
// - Quyết định mỗi nhịp (quy tắc cố định, `adcaDecision`): regime ngược hướng (long gặp TREND_DOWN) thì Reduce, ngược
//   liên tục ≥ 4 giờ thì Exit; biến động mạnh và đã dùng ≥ 70% số lệnh DCA cũng Reduce (huỷ lệnh DCA, chốt ở hoà vốn
//   + phí); còn lại Continue.
// - Lệnh đã huỷ vẫn có thể khớp trước khi SoDEX xác nhận huỷ: giữ trong `cancelled` tới `orderDone`, khớp muộn vẫn vào
//   sổ cái để vị thế không lệch.
// - Hard stop: giá đi ngược ≥ hardStopLossPct so với giá trung bình → đóng cả chu kỳ bằng market. maxLoss của bot →
//   dừng bot và đóng vị thế.

export const ADCA = {
  candles: 120,
  atrPeriod: 14,
  rsiPeriod: 14,
  stepGrowth: "1.2",
  /** Khoảng cách tối thiểu giữa các lệnh DCA (%), để phí khứ hồi không ăn hết lãi. */
  minStepPct: "0.3",
  /** Reduce khi đã dùng chừng này phần số lệnh DCA và regime là HIGH_VOLATILITY. */
  reduceShare: 0.7,
  /** Exit khi regime ngược hướng liên tục chừng này phút (ngắn hơn thì chỉ Reduce). */
  exitAfterMinutes: 240,
  /** Lệnh vào bị từ chối chừng này lần liên tiếp thì pause, không thử lại mãi mỗi phút. */
  maxBaseRejects: 3,
} as const;

export type AdcaDecision = "continue" | "reduce" | "exit";

export interface AdaptiveDcaState {
  phase: "idle" | "entering" | "in_cycle" | "exiting" | "halted";
  cycle: number;
  completedCycles: number;
  exits: number;
  ledger: Ledger;
  lastPrice: string | null;
  baseId: string | null;
  tpId: string | null;
  tpAttempt: number;
  safetyId: string | null;
  /** Lệnh DCA kế tiếp (1-based) và số lệnh đã khớp trong chu kỳ. */
  nextSafety: number;
  safetiesFilled: number;
  lastFillPrice: string | null;
  exitId: string | null;
  exitAttempt: number;
  reduced: boolean;
  atr: string | null;
  rsi: number | null;
  regime: FarmRegime;
  decision: AdcaDecision;
  cooldownUntil: number;
  lastSkip: string | null;
  /** Mốc regime bắt đầu ngược hướng (ms); null khi không ngược. State cũ không có. */
  againstSince?: number | null;
  /** Phí và funding của sổ cái lúc mở chu kỳ, để tính giá hoà vốn của riêng chu kỳ (Reduce). */
  cycleFeesStart?: string;
  cycleFundingStart?: string;
  /** Giá trị vị thế lớn nhất từng đạt (quote, theo giá vốn), để theo dõi mức dùng trần. */
  peakExposure?: string;
  /** Lệnh đã gửi huỷ nhưng chưa có `orderDone`: khớp muộn vẫn được ghi vào sổ cái theo chiều này. */
  cancelled?: Record<string, "entry" | "exit">;
  /** Số lần liên tiếp lệnh vào chu kỳ bị từ chối; đủ `ADCA.maxBaseRejects` thì pause. */
  baseRejects?: number;
  /**
   * Lệnh gần đây (P0.1): chiều, khối lượng đặt / đã khớp, tiền đã khớp. Cộng dồn các lần khớp của một lệnh, không cộng
   * trùng fill phát lại, nhận fill trễ. Thiếu ở state cũ: lệnh cũ coi như khớp đủ ở lần khớp đầu.
   */
  orders?: Record<string, AdcaOrder>;
  /** Số lần resume: hậu tố tag của lệnh DCA đặt lại, để không dùng lại clOrdID cũ. */
  resumes?: number;
}

export interface AdcaOrder {
  kind: "entry" | "exit";
  qty: string;
  filled: string;
  cost: string;
}

const KEEP_ORDERS = 30;

function track(s: AdaptiveDcaState, o: OrderIntent, kind: "entry" | "exit"): AdaptiveDcaState {
  return {
    ...s,
    orders: Object.fromEntries(
      [
        ...Object.entries(s.orders ?? {}),
        [o.clOrdID, { kind, qty: o.quantity, filled: "0", cost: "0" }] as const,
      ].slice(-KEEP_ORDERS),
    ),
  };
}

const initial = (): AdaptiveDcaState => ({
  phase: "idle",
  cycle: 0,
  completedCycles: 0,
  exits: 0,
  ledger: emptyLedger(),
  lastPrice: null,
  baseId: null,
  tpId: null,
  tpAttempt: 0,
  safetyId: null,
  nextSafety: 1,
  safetiesFilled: 0,
  lastFillPrice: null,
  exitId: null,
  exitAttempt: 0,
  reduced: false,
  atr: null,
  rsi: null,
  regime: "UNKNOWN",
  decision: "continue",
  cooldownUntil: 0,
  lastSkip: null,
});

const none = (s: AdaptiveDcaState): StepResult<AdaptiveDcaState> => ({ actions: [], state: s });

/** Huỷ các lệnh còn mở và nhớ chiều của chúng tới khi SoDEX báo `orderDone`. */
function cancelAll(
  s: AdaptiveDcaState,
  ids: readonly { id: string | null; side: "entry" | "exit" }[],
): { actions: StrategyAction[]; cancelled: Record<string, "entry" | "exit"> } {
  const cancelled = { ...(s.cancelled ?? {}) };
  const actions: StrategyAction[] = [];
  for (const { id, side } of ids) {
    if (id === null) continue;
    cancelled[id] = side;
    actions.push({ type: "cancel", clOrdID: id });
  }
  return { actions, cancelled };
}

/** RSI Wilder trên giá đóng cửa; null khi chưa đủ dữ liệu. Chỉ là chấm điểm nên dùng number. */
export function rsi(closes: readonly number[], period: number = ADCA.rsiPeriod): number | null {
  if (closes.length < period + 1) return null;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i += 1) {
    const d = (closes[i] ?? 0) - (closes[i - 1] ?? 0);
    if (d >= 0) gain += d;
    else loss -= d;
  }
  gain /= period;
  loss /= period;
  for (let i = period + 1; i < closes.length; i += 1) {
    const d = (closes[i] ?? 0) - (closes[i - 1] ?? 0);
    gain = (gain * (period - 1) + Math.max(d, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-d, 0)) / period;
  }
  if (loss === 0) return gain === 0 ? 50 : 100;
  return 100 - 100 / (1 + gain / loss);
}

/** Đọc thị trường từ nến 1 phút (gộp 5 phút): regime, ATR, RSI. */
export function adcaMarket(candles: readonly MinuteCandle[], now: number) {
  const five = toFiveMinute(validCandles(candles, now));
  const a = atr(five, ADCA.atrPeriod);
  return {
    regime: detectRegime(five),
    atr: a > 0 ? new Decimal(a).toSignificantDigits(8).toString() : null,
    rsi: rsi(five.map((k) => k.c)),
  };
}

/** Regime cho phép vào chu kỳ theo hướng. */
export function regimeAllows(direction: "long" | "short", regime: FarmRegime): boolean {
  return direction === "long"
    ? regime === "SIDEWAY" || regime === "TREND_UP"
    : regime === "SIDEWAY" || regime === "TREND_DOWN";
}

/** Quyết định khi đang có vị thế (mục "AI quyết định Continue / Reduce / Exit"). */
export function adcaDecision(input: {
  direction: "long" | "short";
  regime: FarmRegime;
  safetiesFilled: number;
  maxSafetyOrders: number;
  /** Số phút regime đã ngược hướng liên tục (0 nếu không ngược). */
  againstMinutes: number;
  exitAfterMinutes?: number;
}): AdcaDecision {
  const against = input.direction === "long" ? "TREND_DOWN" : "TREND_UP";
  if (input.regime === against)
    return input.againstMinutes >= (input.exitAfterMinutes ?? ADCA.exitAfterMinutes)
      ? "exit"
      : "reduce";
  if (
    input.regime === "HIGH_VOLATILITY" &&
    input.safetiesFilled >= Math.ceil(input.maxSafetyOrders * ADCA.reduceShare)
  )
    return "reduce";
  return "continue";
}

/** Giá lệnh DCA thứ k: từ giá khớp gần nhất đi ngược ATR × hệ số × 1.2^(k−1), tối thiểu `minStepPct`. */
export function adcaSafetyPrice(
  direction: "long" | "short",
  from: string,
  atrValue: string,
  atrMultiplier: string,
  k: number,
): Decimal {
  const step = Decimal.max(
    dec(atrValue)
      .mul(atrMultiplier)
      .mul(dec(ADCA.stepGrowth).pow(k - 1)),
    dec(from).mul(ADCA.minStepPct).div(100),
  );
  return direction === "long" ? dec(from).sub(step) : dec(from).add(step);
}

const entrySide = (c: AdaptiveDcaConfig) => (c.direction === "long" ? "buy" : "sell");
const exitSide = (c: AdaptiveDcaConfig) => (c.direction === "long" ? "sell" : "buy");
const exposure = (s: AdaptiveDcaState) => dec(s.ledger.position).abs().mul(s.ledger.avgCost);

function intent(
  c: AdaptiveDcaConfig,
  ctx: StepContext,
  tag: string,
  side: "buy" | "sell",
  qty: string,
  price?: string,
  reduceOnly = false,
): OrderIntent {
  return {
    clOrdID: clOrdId(ctx.botId, ctx.version, tag),
    market: c.market,
    engine: "perps",
    side,
    type: price === undefined ? "market" : "limit",
    ...(price === undefined ? {} : { price }),
    quantity: qty,
    timeInForce: price === undefined ? "IOC" : "GTC",
    reduceOnly,
    tag,
  };
}

function skip(s: AdaptiveDcaState, why: string): StepResult<AdaptiveDcaState> {
  const code = why.split(":")[0] ?? why;
  return s.lastSkip === code
    ? none(s)
    : {
        actions: [{ type: "log", decision: "Waiting", why }],
        state: { ...s, lastSkip: code },
      };
}

function tryEnter(
  c: AdaptiveDcaConfig,
  s: AdaptiveDcaState,
  ctx: StepContext,
  at: number,
): StepResult<AdaptiveDcaState> {
  const rules = ctx.rules[c.market];
  const price = s.lastPrice;
  if (rules === undefined || price === null) return none(s);
  if (at < s.cooldownUntil) return none(s);
  if (s.atr === null || s.rsi === null || s.regime === "UNKNOWN")
    return skip(s, "NOT_ENOUGH_DATA: waiting for 5-minute candles");
  if (!regimeAllows(c.direction, s.regime))
    return skip(s, `REGIME: ${s.regime} does not suit a ${c.direction} DCA`);
  const limit = Number(c.entryRsi);
  const ok = c.direction === "long" ? s.rsi <= limit : s.rsi >= 100 - limit;
  if (!ok)
    return skip(
      s,
      `RSI: ${s.rsi.toFixed(1)} ${c.direction === "long" ? `above ${c.entryRsi}` : `below ${String(100 - limit)}`}`,
    );
  const qty = roundQty(dec(c.baseOrder).div(price), rules);
  if (!meetsMinimum(price, qty, rules))
    return {
      actions: [
        { type: "log", decision: "Cycle not started", why: "First order is below SoDEX minimum." },
        { type: "pause", reason: ReasonCode.orderRejected },
      ],
      state: { ...s, phase: "halted" },
    };
  const cycle = s.cycle + 1;
  const o = intent(c, ctx, `adca:${String(cycle)}:base`, entrySide(c), qty);
  return {
    actions: [
      { type: "place", order: o },
      {
        type: "log",
        decision: `Cycle ${String(cycle)} started`,
        why: `${s.regime}, RSI ${s.rsi.toFixed(1)}, ATR ${s.atr}.`,
      },
    ],
    state: {
      ...track(s, o, "entry"),
      phase: "entering",
      cycle,
      baseId: o.clOrdID,
      tpId: null,
      tpAttempt: 0,
      safetyId: null,
      nextSafety: 1,
      safetiesFilled: 0,
      reduced: false,
      decision: "continue",
      lastSkip: null,
      cycleFeesStart: s.ledger.fees,
      cycleFundingStart: s.ledger.funding,
    },
  };
}

/**
 * Giá hoà vốn của chu kỳ: đóng toàn bộ vị thế ở giá này thì lãi giao dịch bù đủ phí đã trả, funding của chu kỳ và phí
 * của chính lệnh đóng (maker + builder, `ctx.feeRate`). Long: P = (avg·q + chi phí) / (q·(1 − f)); short: P = (avg·q −
 * chi phí) / (q·(1 + f)).
 */
export function adcaBreakEven(
  direction: "long" | "short",
  ledger: Ledger,
  feesStart: string,
  fundingStart: string,
  feeRate: string,
): Decimal {
  const q = dec(ledger.position).abs();
  const avg = dec(ledger.avgCost);
  const cost = dec(ledger.fees).sub(feesStart).add(dec(ledger.funding).sub(fundingStart));
  const f = dec(feeRate);
  return direction === "long"
    ? avg
        .mul(q)
        .add(cost)
        .div(q.mul(new Decimal(1).sub(f)))
    : avg
        .mul(q)
        .sub(cost)
        .div(q.mul(new Decimal(1).add(f)));
}

function placeTp(
  c: AdaptiveDcaConfig,
  s: AdaptiveDcaState,
  ctx: StepContext,
): StepResult<AdaptiveDcaState> {
  const rules = ctx.rules[c.market];
  if (rules === undefined) return none(s);
  const avg = dec(s.ledger.avgCost);
  const tp = dec(c.takeProfitPct).div(100);
  // Reduce: chốt ở giá hoà vốn thật của chu kỳ (đã gồm phí, funding và phí lệnh đóng), làm tròn về phía an toàn.
  const price = s.reduced
    ? roundPrice(
        adcaBreakEven(
          c.direction,
          s.ledger,
          s.cycleFeesStart ?? s.ledger.fees,
          s.cycleFundingStart ?? s.ledger.funding,
          ctx.feeRate,
        ),
        rules,
        c.direction === "long" ? RoundMode.up : RoundMode.down,
      )
    : roundPrice(
        c.direction === "long" ? avg.mul(new Decimal(1).add(tp)) : avg.mul(new Decimal(1).sub(tp)),
        rules,
      );
  const qty = roundQty(dec(s.ledger.position).abs(), rules);
  const c0 = cancelAll(s, [{ id: s.tpId, side: "exit" }]);
  const actions = c0.actions;
  if (!dec(qty).gt(0)) return { actions, state: { ...s, tpId: null, cancelled: c0.cancelled } };
  const o = intent(
    c,
    ctx,
    `adca:${String(s.cycle)}:tp:${String(s.tpAttempt)}`,
    exitSide(c),
    qty,
    price,
    true,
  );
  actions.push({ type: "place", order: o });
  return {
    actions,
    state: {
      ...track(s, o, "exit"),
      tpId: o.clOrdID,
      tpAttempt: s.tpAttempt + 1,
      cancelled: c0.cancelled,
    },
  };
}

/** Đặt lệnh DCA kế tiếp nếu còn lượt, còn chỗ trong maxExposure, có ATR và đang Continue. */
function placeSafety(
  c: AdaptiveDcaConfig,
  s: AdaptiveDcaState,
  ctx: StepContext,
): StepResult<AdaptiveDcaState> {
  const rules = ctx.rules[c.market];
  const k = s.nextSafety;
  if (
    rules === undefined ||
    s.safetyId !== null ||
    s.reduced ||
    s.decision !== "continue" ||
    k > c.maxSafetyOrders ||
    s.atr === null ||
    s.lastFillPrice === null
  )
    return none(s);
  const notional = dec(c.safetyOrder).mul(dec(c.sizeMultiplier).pow(k - 1));
  if (exposure(s).add(notional).gt(c.maxExposure)) {
    const why = `Next order of ${notional.toDecimalPlaces(2).toString()} would pass the ${c.maxExposure} exposure cap.`;
    return s.lastSkip === "CAP"
      ? none(s)
      : { actions: [{ type: "log", decision: "Holding", why }], state: { ...s, lastSkip: "CAP" } };
  }
  const raw = adcaSafetyPrice(c.direction, s.lastFillPrice, s.atr, c.atrMultiplier, k);
  if (!raw.gt(0)) return none(s);
  const price = roundPrice(raw, rules);
  const qty = roundQty(notional.div(price), rules);
  if (!meetsMinimum(price, qty, rules)) return none(s);
  const r = s.resumes ?? 0;
  const tag = `adca:${String(s.cycle)}:so${String(k)}${r > 0 ? `:r${String(r)}` : ""}`;
  const o = intent(c, ctx, tag, entrySide(c), qty, price);
  return {
    actions: [{ type: "place", order: o }],
    state: { ...track(s, o, "entry"), safetyId: o.clOrdID },
  };
}

function startExit(
  c: AdaptiveDcaConfig,
  s: AdaptiveDcaState,
  ctx: StepContext,
  decision: string,
  why: string,
): StepResult<AdaptiveDcaState> {
  const rules = ctx.rules[c.market];
  const cx = cancelAll(s, [
    { id: s.safetyId, side: "entry" },
    { id: s.tpId, side: "exit" },
  ]);
  const cancels = cx.actions;
  const qty = rules === undefined ? "0" : roundQty(dec(s.ledger.position).abs(), rules);
  if (!dec(qty).gt(0))
    return {
      actions: cancels,
      state: { ...s, phase: "idle", safetyId: null, tpId: null, cancelled: cx.cancelled },
    };
  const o = intent(
    c,
    ctx,
    `adca:${String(s.cycle)}:exit:${String(s.exitAttempt)}`,
    exitSide(c),
    qty,
    undefined,
    true,
  );
  return {
    actions: [...cancels, { type: "place", order: o }, { type: "log", decision, why }],
    state: {
      ...track(s, o, "exit"),
      phase: "exiting",
      safetyId: null,
      tpId: null,
      cancelled: cx.cancelled,
      exitId: o.clOrdID,
      exitAttempt: s.exitAttempt + 1,
      decision: "exit",
    },
  };
}

function guards(
  c: AdaptiveDcaConfig,
  s: AdaptiveDcaState,
  ctx: StepContext,
): StepResult<AdaptiveDcaState> | null {
  const price = s.lastPrice;
  if (price === null) return null;
  if (netPnl(s.ledger, price).lte(dec(c.maxLoss).neg())) {
    const cx = cancelAll(s, [
      { id: s.safetyId, side: "entry" },
      { id: s.tpId, side: "exit" },
      { id: s.baseId, side: "entry" },
    ]);
    return {
      actions: [
        ...cx.actions,
        {
          type: "log",
          decision: "AI DCA stopped",
          why: `Net loss reached the max loss of ${c.maxLoss}.`,
        },
        { type: "stop", reason: ReasonCode.botMaxLoss, close: true },
      ],
      state: { ...s, phase: "halted", safetyId: null, tpId: null, cancelled: cx.cancelled },
    };
  }
  if (s.phase !== "in_cycle") return null;
  const pos = dec(s.ledger.position);
  if (pos.isZero()) return null;
  const move = dec(price).sub(s.ledger.avgCost).div(s.ledger.avgCost).mul(100);
  const adverse = c.direction === "long" ? move.neg() : move;
  if (adverse.gte(c.hardStopLossPct))
    return startExit(
      c,
      s,
      ctx,
      "Hard stop",
      `Price moved ${adverse.toDecimalPlaces(2).toString()}% against the average price.`,
    );
  return null;
}

function onTimer(
  c: AdaptiveDcaConfig,
  s0: AdaptiveDcaState,
  ctx: StepContext,
  e: Extract<StrategyEvent, { type: "timer" }>,
): StepResult<AdaptiveDcaState> {
  const snap = e.market?.market === c.market ? e.market : undefined;
  const m = snap === undefined ? null : adcaMarket(snap.candles, e.at);
  const s: AdaptiveDcaState =
    m === null ? s0 : { ...s0, regime: m.regime, atr: m.atr ?? s0.atr, rsi: m.rsi };
  const g = guards(c, s, ctx);
  if (g !== null) return g;
  if (s.phase === "idle") return m === null ? none(s) : tryEnter(c, s, ctx, e.at);
  if (s.phase !== "in_cycle" || m === null) return none(s);
  const againstRegime = c.direction === "long" ? "TREND_DOWN" : "TREND_UP";
  const againstSince = s.regime === againstRegime ? (s.againstSince ?? e.at) : null;
  const decision = adcaDecision({
    direction: c.direction,
    regime: s.regime,
    safetiesFilled: s.safetiesFilled,
    maxSafetyOrders: c.maxSafetyOrders,
    againstMinutes: againstSince === null ? 0 : (e.at - againstSince) / 60_000,
  });
  const st: AdaptiveDcaState = { ...s, againstSince };
  if (decision === "exit")
    return startExit(
      c,
      st,
      ctx,
      "Exit",
      `Market stayed ${s.regime}, against this ${c.direction} DCA, for ${String(ADCA.exitAfterMinutes / 60)} hours.`,
    );
  if (decision === "reduce" && !s.reduced) {
    const cx = cancelAll(st, [{ id: s.safetyId, side: "entry" }]);
    const tp = placeTp(
      c,
      { ...st, reduced: true, decision, safetyId: null, cancelled: cx.cancelled },
      ctx,
    );
    return {
      actions: [
        ...cx.actions,
        ...tp.actions,
        {
          type: "log",
          decision: "Reduce",
          why:
            s.regime === againstRegime
              ? `Market turned ${s.regime}: no more orders for now, take profit moved to break-even.`
              : "High volatility after most extra buys: no more orders, take profit moved to break-even.",
        },
      ],
      state: tp.state,
    };
  }
  if (decision === "continue" && s.reduced) {
    // Thị trường bình thường lại: trả take profit về mức đầy đủ và tiếp tục thêm lệnh.
    const tp = placeTp(c, { ...st, reduced: false, decision }, ctx);
    const so = placeSafety(c, tp.state, ctx);
    return {
      actions: [
        ...tp.actions,
        ...so.actions,
        {
          type: "log",
          decision: "Continue",
          why: `Market is ${s.regime} again: back to the full plan.`,
        },
      ],
      state: so.state,
    };
  }
  const next = { ...st, decision };
  return decision === "continue" ? placeSafety(c, next, ctx) : none(next);
}

const isFlat = (s: AdaptiveDcaState, ctx: StepContext, c: AdaptiveDcaConfig) =>
  dec(s.ledger.position).isZero() ||
  dec(s.ledger.position)
    .abs()
    .lt(ctx.rules[c.market]?.minQuantity ?? "0");

function onFill(
  c: AdaptiveDcaConfig,
  s: AdaptiveDcaState,
  ctx: StepContext,
  e: Extract<StrategyEvent, { type: "fill" }>,
): StepResult<AdaptiveDcaState> {
  const id = e.clOrdID;
  const current =
    id === s.baseId
      ? "base"
      : id === s.safetyId
        ? "safety"
        : id === s.tpId
          ? "tp"
          : id === s.exitId
            ? "exit"
            : null;
  const rec = s.orders?.[id];
  const kind =
    current === "base" || current === "safety"
      ? "entry"
      : current !== null
        ? "exit"
        : (s.cancelled?.[id] ?? rec?.kind);
  if (kind === undefined) return none(s);
  // Chỉ tính tới đủ khối lượng lệnh: fill phát lại / khớp trễ không cộng trùng.
  const room = rec === undefined ? dec(e.quantity) : dec(rec.qty).sub(rec.filled);
  const q = Decimal.min(room, e.quantity);
  if (!q.gt(0)) return none(s);
  const fee = q.lt(e.quantity) ? dec(e.fee).mul(q).div(e.quantity).toString() : e.fee;
  const filledQty = dec(rec?.filled ?? "0").add(q);
  const next: AdcaOrder | undefined =
    rec === undefined
      ? undefined
      : {
          ...rec,
          filled: filledQty.toString(),
          cost: dec(rec.cost).add(dec(e.price).mul(q)).toString(),
        };
  const state: AdaptiveDcaState = {
    ...s,
    ledger: applyFill(s.ledger, kind === "entry" ? entrySide(c) : exitSide(c), e.price, q, fee),
    ...(next === undefined ? {} : { orders: { ...s.orders, [id]: next } }),
  };
  // Bot đã dừng (max loss) hoặc lệnh đã huỷ / đã xong nhưng khớp trễ: chỉ ghi sổ cái, không đặt lệnh mới từ trạng
  // thái dừng.
  if (s.phase === "halted" || current === null) {
    if (state.phase !== "in_cycle") return none(state);
    // Lệnh chốt cũ khớp trễ làm vị thế về 0: chu kỳ kết thúc.
    if (isFlat(state, ctx, c))
      return none({ ...state, phase: "idle", tpId: null, safetyId: null, reduced: false });
    // Còn vị thế: khối lượng đổi thì đặt lại take profit cho đúng.
    return placeTp(c, state, ctx);
  }
  if (current === "base" || current === "safety") {
    // Lệnh vào chưa khớp đủ: chờ phần còn lại hoặc `orderDone`.
    if (next !== undefined && filledQty.lt(next.qty)) return none(state);
    return entryDone(c, state, ctx, current, next === undefined ? e.price : avgOf(next));
  }
  if (!isFlat(state, ctx, c)) return none(state);
  return cycleClosed(c, state, current === "tp", e.price, e.at);
}

const avgOf = (o: AdcaOrder) => dec(o.cost).div(o.filled).toString();

/** Lệnh vào (base / DCA) đã xong với phần đã khớp: đặt take profit và lệnh DCA kế tiếp. */
function entryDone(
  c: AdaptiveDcaConfig,
  s: AdaptiveDcaState,
  ctx: StepContext,
  which: "base" | "safety",
  price: string,
): StepResult<AdaptiveDcaState> {
  const base = which === "base";
  const filled: AdaptiveDcaState = {
    ...s,
    phase: s.phase === "exiting" ? "exiting" : "in_cycle",
    lastFillPrice: price,
    ...(base
      ? { baseId: null, baseRejects: 0 }
      : { safetyId: null, safetiesFilled: s.safetiesFilled + 1, nextSafety: s.nextSafety + 1 }),
  };
  filled.peakExposure = Decimal.max(dec(s.peakExposure ?? "0"), exposure(filled)).toString();
  if (filled.phase === "exiting") return none(filled);
  const g = guards(c, filled, ctx);
  if (g !== null) return g;
  const tp = placeTp(c, filled, ctx);
  const so = placeSafety(c, tp.state, ctx);
  const log: StrategyAction[] = base
    ? []
    : [
        {
          type: "log",
          decision: `Extra order ${String(s.nextSafety)} filled`,
          why: `New average ${dec(filled.ledger.avgCost).toDecimalPlaces(8).toString()}.`,
        },
      ];
  return { actions: [...tp.actions, ...so.actions, ...log], state: so.state };
}

/** Vị thế đã đóng hết (take profit hoặc lệnh đóng): kết thúc chu kỳ. */
function cycleClosed(
  c: AdaptiveDcaConfig,
  state: AdaptiveDcaState,
  tp: boolean,
  price: string,
  at: number,
): StepResult<AdaptiveDcaState> {
  const cx = cancelAll(state, [{ id: state.safetyId, side: "entry" }]);
  return {
    actions: [
      ...cx.actions,
      {
        type: "log",
        decision: tp
          ? `Cycle ${String(state.cycle)} took profit`
          : `Cycle ${String(state.cycle)} closed`,
        why: `Closed at ${price}.`,
      },
    ],
    state: {
      ...state,
      phase: "idle",
      tpId: null,
      exitId: null,
      safetyId: null,
      cancelled: cx.cancelled,
      completedCycles: state.completedCycles + (tp ? 1 : 0),
      exits: state.exits + (tp ? 0 : 1),
      cooldownUntil: tp ? state.cooldownUntil : at + c.cooldownMinutes * 60_000,
      decision: "continue",
      reduced: false,
      againstSince: null,
    },
  };
}

/** Lệnh đã kết thúc trên SoDEX (`orderDone`), kể cả khi mới khớp một phần hoặc không khớp gì. */
function onOrderDone(
  c: AdaptiveDcaConfig,
  s0: AdaptiveDcaState,
  ctx: StepContext,
  id: string,
  at: number,
): StepResult<AdaptiveDcaState> {
  const s: AdaptiveDcaState =
    s0.cancelled?.[id] === undefined
      ? s0
      : {
          ...s0,
          cancelled: Object.fromEntries(Object.entries(s0.cancelled).filter(([k]) => k !== id)),
        };
  if (s.phase === "halted") return none(s);
  const rec = s.orders?.[id];
  const filled = rec !== undefined && dec(rec.filled).gt(0);
  if (id === s.baseId) {
    if (filled) return entryDone(c, s, ctx, "base", avgOf(rec));
    // Lệnh vào không khớp gì: về chờ, thử lại ở nhịp sau.
    return none({ ...s, phase: "idle", baseId: null });
  }
  if (id === s.safetyId) {
    if (filled) return entryDone(c, s, ctx, "safety", avgOf(rec));
    return none({ ...s, safetyId: null });
  }
  if (id === s.tpId && s.phase === "in_cycle") {
    // Take profit kết thúc mà vị thế chưa đóng hết: đặt lại cho phần còn lại.
    if (isFlat(s, ctx, c)) return cycleClosed(c, s, true, s.lastPrice ?? "0", at);
    return placeTp(c, { ...s, tpId: null }, ctx);
  }
  if (id === s.exitId) {
    if (isFlat(s, ctx, c)) return cycleClosed(c, s, false, s.lastPrice ?? "0", at);
    // Lệnh đóng hết hạn khi vị thế còn: gửi lại lệnh đóng cho phần còn lại ngay (không để vị thế không có TP / stop).
    return retryExit(c, { ...s, exitId: null }, ctx);
  }
  return none(s);
}

/**
 * Resume sau khi bot tự pause (DEC-240): giữ sổ cái và vị thế thật. Không có vị thế thì về chờ chu kỳ mới; có vị
 * thế thì chạy tiếp chu kỳ: đặt lại take profit theo vị thế và lệnh DCA kế tiếp (nếu còn được phép).
 */
function resumeAdca(
  c: AdaptiveDcaConfig,
  s: AdaptiveDcaState,
  ctx: StepContext,
): StepResult<AdaptiveDcaState> {
  const flat = dec(s.ledger.position).isZero();
  const cx = cancelAll(s, [
    { id: s.safetyId, side: "entry" },
    ...(flat ? [{ id: s.tpId, side: "exit" as const }] : []),
  ]);
  const base: AdaptiveDcaState = {
    ...s,
    baseId: null,
    exitId: null,
    safetyId: null,
    baseRejects: 0,
    cancelled: cx.cancelled,
    resumes: (s.resumes ?? 0) + 1,
  };
  if (flat)
    return { actions: cx.actions, state: { ...base, phase: "idle", tpId: null, reduced: false } };
  const tp = placeTp(c, { ...base, phase: "in_cycle" }, ctx);
  const so = placeSafety(c, tp.state, ctx);
  return {
    actions: [
      ...cx.actions,
      ...tp.actions,
      ...so.actions,
      {
        type: "log",
        decision: `Cycle ${String(s.cycle)} resumed`,
        why: "Take profit and the next order placed from the current position.",
      },
    ],
    state: so.state,
  };
}

function retryExit(
  c: AdaptiveDcaConfig,
  s: AdaptiveDcaState,
  ctx: StepContext,
): StepResult<AdaptiveDcaState> {
  const rules = ctx.rules[c.market];
  const qty = rules === undefined ? "0" : roundQty(dec(s.ledger.position).abs(), rules);
  if (!dec(qty).gt(0)) return none({ ...s, phase: "in_cycle" });
  const o = intent(
    c,
    ctx,
    `adca:${String(s.cycle)}:exit:${String(s.exitAttempt)}`,
    exitSide(c),
    qty,
    undefined,
    true,
  );
  return {
    actions: [{ type: "place", order: o }],
    state: {
      ...track(s, o, "exit"),
      phase: "exiting",
      exitId: o.clOrdID,
      exitAttempt: s.exitAttempt + 1,
    },
  };
}

export function stepAdaptiveDca(
  c: AdaptiveDcaConfig,
  s: AdaptiveDcaState,
  e: StrategyEvent,
  ctx: StepContext,
): StepResult<AdaptiveDcaState> {
  if (e.type === "resumed")
    return s.phase === "halted"
      ? resumeAdca(c, { ...s, lastPrice: e.prices[c.market] ?? s.lastPrice }, ctx)
      : none(s);
  if (s.phase === "halted" && e.type !== "fill" && e.type !== "orderDone") return none(s);
  switch (e.type) {
    case "tick": {
      if (e.market !== c.market) return none(s);
      const state = { ...s, lastPrice: e.price };
      return guards(c, state, ctx) ?? none(state);
    }
    case "timer":
      return onTimer(c, s, ctx, e);
    case "fill":
      return onFill(c, s, ctx, e);
    case "orderReject": {
      // Lệnh đóng bị từ chối: thử lại bằng market ở nhịp sau; lệnh khác bị từ chối thì pause (quy tắc 1.7).
      if (e.clOrdID === s.exitId) return none({ ...s, phase: "in_cycle", exitId: null });
      if (e.clOrdID === s.baseId) {
        const n = (s.baseRejects ?? 0) + 1;
        if (n >= ADCA.maxBaseRejects)
          return {
            actions: [
              {
                type: "log",
                decision: "Paused",
                why: `SoDEX rejected the first order ${String(n)} times in a row.`,
              },
              { type: "pause", reason: ReasonCode.orderRejected },
            ],
            state: { ...s, phase: "halted", baseId: null, baseRejects: n },
          };
        return none({ ...s, phase: "idle", baseId: null, baseRejects: n });
      }
      return {
        actions: [{ type: "pause", reason: ReasonCode.orderRejected }],
        state: { ...s, phase: "halted" },
      };
    }
    case "fundingPaid":
      return e.market === c.market
        ? none({ ...s, ledger: applyFunding(s.ledger, e.amount) })
        : none(s);
    case "orderDone":
      return onOrderDone(c, s, ctx, e.clOrdID, e.at);
    case "orderAck":
    case "fundingRate":
    case "marginRatio":
    case "positionSync":
    case "leaderFill":
    case "leaderPosition":
      return none(s);
  }
}

export const adaptiveDca: StrategyModule<AdaptiveDcaConfig, AdaptiveDcaState> = {
  initialState: initial,
  step: stepAdaptiveDca,
};

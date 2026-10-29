import { formatDecimal } from "../format";
import { Decimal, dec, roundToStep, RoundMode, toDecimalString, type DecimalInput } from "../money";

import { RECO_CONFIG as C } from "./config";
import type { RecoMarket, RecoStrategy } from "./types";

// Tham số "✦ AI parameters" (RECO_ENGINE.md mục 10.5). Hàm thuần: cùng đầu vào → cùng output.
// Giá làm tròn theo tick, tiền quote làm tròn xuống 0.01. Không dự báo lợi nhuận.

export interface ParamContext {
  market: RecoMarket;
  capital: string;
  /** Max drop d (%). */
  maxDropPct: number;
  /** fee_rt (%) = 2 × (maker fee + builder fee). */
  feeRtPct: Decimal;
  /** Quy tắc loại trừ đòn bẩy (≥ 8×) đã kích hoạt → mọi bot perp 1×. */
  forceOneX: boolean;
  accountLeverageCap: number | null;
  timeZone: string;
  /** Rebalancing: market Spot của các tài sản đã chọn và tỷ trọng volume lịch sử. */
  basket?: readonly {
    asset: string;
    market: string;
    volumeShare: string;
    sigma30: number | null;
  }[];
  /** Funding Arb: market Spot cùng tài sản. */
  spotMarket?: RecoMarket;
}

export interface Params {
  values: Record<string, unknown>;
  /** Câu lý do có số thật (template, tiếng Anh). */
  reasons: string[];
  basis: string;
  /** Lỗ ở mức stop theo % vốn (đã nhân đòn bẩy); null với chiến lược không có stop giá. */
  lossAtStopPct: number | null;
}

const q = (v: DecimalInput) => toDecimalString(roundToStep(v, "0.01", RoundMode.down));
const tick = (v: DecimalInput, m: RecoMarket, mode: RoundMode = RoundMode.nearest) =>
  toDecimalString(roundToStep(v, m.rules.tickSize, mode));
const fmt = (v: DecimalInput | number, digits = 2) =>
  formatDecimal(
    (typeof v === "number" ? new Decimal(v) : dec(v)).toDecimalPlaces(
      digits,
      Decimal.ROUND_HALF_UP,
    ),
    { locale: "en-US", maximumFractionDigits: digits },
  ) ?? "";
const pct = (v: DecimalInput | number, digits = 2) => `${fmt(v, digits)}%`;

/** Notional tối thiểu của một lệnh ở giá hiện tại: max(minNotional, minQuantity × giá). */
export function minOrderNotional(m: RecoMarket): Decimal {
  return Decimal.max(dec(m.rules.minNotional), dec(m.rules.minQuantity).mul(m.lastPrice));
}

function dailyReturnsPct(closes: readonly string[]): Decimal[] {
  const out: Decimal[] = [];
  for (let i = 1; i < closes.length; i += 1) {
    const prev = dec(closes[i - 1] ?? "0");
    if (prev.isZero()) continue;
    out.push(
      dec(closes[i] ?? "0")
        .div(prev)
        .sub(1)
        .mul(100),
    );
  }
  return out;
}

export function medianAbsReturnPct(closes: readonly string[]): Decimal | null {
  const r = dailyReturnsPct(closes.slice(-31)).map((x) => x.abs());
  if (r.length === 0) return null;
  r.sort((a, b) => a.comparedTo(b));
  const mid = Math.floor(r.length / 2);
  return r.length % 2 === 1
    ? (r[mid] ?? null)
    : (r[mid - 1] ?? new Decimal(0)).add(r[mid] ?? 0).div(2);
}

/** Mức giảm lớn nhất từ đỉnh (%) trong 31 giá đóng cửa gần nhất. */
export function maxDrawdown30Pct(closes: readonly string[]): Decimal | null {
  const c = closes.slice(-31).map((x) => dec(x));
  if (c.length < 2) return null;
  let peak = c[0] ?? new Decimal(0);
  let worst = new Decimal(0);
  for (const x of c) {
    peak = Decimal.max(peak, x);
    if (peak.gt(0)) worst = Decimal.max(worst, peak.sub(x).div(peak).mul(100));
  }
  return worst;
}

export function leverageFor(ctx: ParamContext): number {
  if (ctx.forceOneX) return 1;
  const caps = [
    C.futures.maxLeverage,
    ctx.accountLeverageCap ?? C.futures.maxLeverage,
    ctx.market.maxLeverage ?? C.futures.maxLeverage,
  ];
  return Math.max(1, Math.min(...caps));
}

// ---------- Grid ----------

export function gridParams(
  strategy: "spot_grid" | "futures_grid",
  ctx: ParamContext,
): Params | null {
  const m = ctx.market;
  if (m.p5 === null || m.p95 === null || m.sigma30 === null) return null;
  const lower = dec(tick(m.p5, m, RoundMode.up));
  const upper = dec(tick(m.p95, m, RoundMode.down));
  if (!upper.gt(lower)) return null;
  const stepPct = Decimal.max(ctx.feeRtPct.mul(C.grid.stepFeeMultiple), dec(C.grid.stepMinPct));
  const raw =
    Math.floor(
      Decimal.ln(upper.div(lower))
        .div(Decimal.ln(stepPct.div(100).add(1)))
        .toNumber(),
    ) + 1;
  let levels = Math.min(C.grid.levelsMax, Math.max(C.grid.levelsMin, raw));
  const leverage = strategy === "futures_grid" ? leverageFor(ctx) : 1;
  // Bỏ bớt level cho tới khi mỗi lệnh ≥ notional tối thiểu (mục 10.5).
  const notional = dec(ctx.capital).mul(leverage);
  const minOrder = minOrderNotional(m);
  while (levels > C.grid.levelsMin && notional.div(levels).lt(minOrder)) levels -= 1;
  if (notional.div(levels).lt(minOrder)) return null;
  const spacing = upper.sub(lower).div(lower).lt(C.grid.arithmeticMaxSpan)
    ? "arithmetic"
    : "geometric";
  const stopGap = Decimal.max(new Decimal(C.grid.stopMinPct), new Decimal(m.sigma30 * 100)).div(
    100,
  );
  const stop = tick(lower.mul(new Decimal(1).sub(stopGap)), m, RoundMode.down);
  const maxLoss = q(dec(ctx.capital).mul(ctx.maxDropPct).div(100));
  const mid = upper.add(lower).div(2);
  const lossAtStopPct = mid.sub(stop).div(mid).mul(100).mul(leverage).toNumber();
  const realStep =
    spacing === "arithmetic"
      ? upper
          .sub(lower)
          .div(levels - 1)
          .div(mid)
          .mul(100)
      : upper
          .div(lower)
          .pow(new Decimal(1).div(levels - 1))
          .sub(1)
          .mul(100);

  const reasons = [
    `Range ${fmt(lower, 8)}–${fmt(upper, 8)} covers 90% of ${m.asset} daily closes over the last 30 days (P5–P95).`,
    `Step ≈ ${pct(realStep)} is at least ${String(C.grid.stepFeeMultiple)}× the round-trip fee of ${pct(ctx.feeRtPct, 3)}.`,
    `Stop at ${fmt(stop, 8)} sits ${pct(stopGap.mul(100))} below the range; max loss ${fmt(maxLoss)} ${m.quote} = ${String(ctx.maxDropPct)}% of capital.`,
  ];
  const basis = `Over the last 180 days, ${m.asset} stayed range-bound on ${pct((m.rangeScore ?? 0) * 100, 0)} of days. This describes price, not profit.`;
  if (strategy === "spot_grid") {
    return {
      values: {
        market: m.market,
        lowerPrice: toDecimalString(lower),
        upperPrice: toDecimalString(upper),
        gridLevels: levels,
        spacing,
        investment: q(ctx.capital),
        stopPrice: stop,
        maxLoss,
        onStop: "keep_base",
      },
      reasons,
      basis,
      lossAtStopPct,
    };
  }
  const trend = m.trend ?? 0;
  const direction =
    trend > C.futures.trendLong ? "long" : trend < C.futures.trendShort ? "short" : "neutral";
  const stopAbove = tick(upper.mul(new Decimal(1).add(stopGap)), m, RoundMode.up);
  return {
    values: {
      market: m.market,
      leverage,
      marginMode: "isolated",
      direction,
      lowerPrice: toDecimalString(lower),
      upperPrice: toDecimalString(upper),
      gridLevels: levels,
      spacing,
      margin: q(ctx.capital),
      stopBelow: stop,
      ...(direction === "short" ? { stopAbove } : {}),
      maxLoss,
      onStop: "close_at_market",
    },
    reasons: [
      ...reasons.slice(0, 2),
      `${String(leverage)}× leverage, direction ${direction} from the 30-day trend (${fmt(trend, 2)}).`,
    ],
    basis,
    lossAtStopPct,
  };
}

// ---------- DCA ----------

export function dcaLadder(capital: DecimalInput, n: number): Decimal {
  let units = new Decimal(1);
  for (let i = 0; i < n; i += 1) units = units.add(dec(C.dca.sizeMultiplier).pow(i));
  return dec(capital).div(units);
}

function offsetPct(first: Decimal, k: number): Decimal {
  let total = new Decimal(0);
  for (let i = 0; i < k; i += 1) total = total.add(dec(C.dca.stepMultiplier).pow(i));
  return first.mul(total);
}

export function dcaParams(strategy: "spot_dca" | "futures_dca", ctx: ParamContext): Params | null {
  const m = ctx.market;
  const med = medianAbsReturnPct(m.closes);
  const dd = maxDrawdown30Pct(m.closes);
  if (med === null || dd === null) return null;
  const first = Decimal.max(dec(C.dca.firstMinPct), med).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  let n = 1;
  while (n < C.dca.maxSafety && offsetPct(first, n).lt(dd)) n += 1;
  const leverage = strategy === "futures_dca" ? leverageFor(ctx) : 1;
  const unit = dcaLadder(ctx.capital, n);
  if (unit.mul(leverage).lt(minOrderNotional(m))) return null;
  const size = q(unit);
  const tp = Decimal.max(
    dec(C.dca.tpMinPct),
    ctx.feeRtPct.mul(C.dca.tpFeeMultiple),
  ).toDecimalPlaces(2, Decimal.ROUND_UP);
  const cover = offsetPct(first, n);
  const maxLoss = q(dec(ctx.capital).mul(ctx.maxDropPct).div(100));
  const reasons = [
    `First safety at −${pct(first)}, the median daily move of ${m.asset} over 30 days.`,
    `${String(n)} safety orders cover a ${pct(cover)} drop; the largest 30-day drop was ${pct(dd)}.`,
    `Take profit ${pct(tp)} is above the round-trip fee of ${pct(ctx.feeRtPct, 3)}.`,
  ];
  const basis = `${m.market}: largest drop over the last 30 days ${pct(dd)}, median daily move ${pct(med)}.`;
  const common = {
    market: m.market,
    baseOrder: size,
    safetyOrder: size,
    maxSafetyOrders: n,
    firstStepPct: toDecimalString(first),
    stepMultiplier: C.dca.stepMultiplier,
    sizeMultiplier: C.dca.sizeMultiplier,
    takeProfitPct: toDecimalString(tp),
    maxLoss,
  };
  if (strategy === "spot_dca") {
    return { values: { ...common, start: "immediately" }, reasons, basis, lossAtStopPct: null };
  }
  const stopLoss = cover.add(C.dca.stopBufferPct).toDecimalPlaces(2, Decimal.ROUND_UP);
  return {
    values: {
      ...common,
      leverage,
      marginMode: "isolated",
      direction: "long",
      stopLossPct: toDecimalString(stopLoss),
    },
    reasons: [
      ...reasons.slice(0, 2),
      `Stop loss −${pct(stopLoss)} sits 2% past the last safety order; ${String(leverage)}× leverage.`,
    ],
    basis,
    lossAtStopPct: stopLoss.mul(leverage).toNumber(),
  };
}

// ---------- Recurring Buy ----------

export function recurringParams(ctx: ParamContext): Params | null {
  const m = ctx.market;
  const amount = dec(q(dec(ctx.capital).div(C.recurring.buys)));
  if (amount.lt(minOrderNotional(m))) return null;
  return {
    values: {
      market: m.market,
      amountPerBuy: toDecimalString(amount),
      frequency: "weekly",
      dayOfWeek: C.recurring.dayOfWeek,
      time: C.recurring.time,
      timeZone: ctx.timeZone,
      ends: "after_n_buys",
      buyCount: C.recurring.buys,
      onLowBalance: "skip_and_notify",
    },
    reasons: [
      `You chose ${m.asset}; ${String(C.recurring.buys)} weekly buys of ${fmt(amount)} ${m.quote}.`,
      "Spot, no leverage, no funding costs.",
      "No selling: the value follows the market.",
    ],
    basis: `${m.market}: market buys every Monday ${C.recurring.time}, ${ctx.timeZone}.`,
    lossAtStopPct: null,
  };
}

// ---------- Rebalancing ----------

export function rebalancingParams(ctx: ParamContext): Params | null {
  const basket = ctx.basket ?? [];
  if (basket.length < 1) return null;
  const stable = C.rebalancing.stableMinPct;
  const shares = basket.map((b) => dec(b.volumeShare));
  const total = shares.reduce((a, b) => a.add(b), new Decimal(0));
  const room = 100 - stable;
  const raw = basket.map((_, i) =>
    total.isZero()
      ? new Decimal(room).div(basket.length)
      : (shares[i] ?? new Decimal(0)).div(total).mul(room),
  );
  const weights = raw.map((w) => w.floor().toNumber());
  let left = room - weights.reduce((a, b) => a + b, 0);
  // Phần dư chia cho tài sản có phần lẻ lớn nhất (thứ tự tất định).
  const order = raw
    .map((w, i) => ({ i, frac: w.sub(w.floor()) }))
    .sort((a, b) => b.frac.comparedTo(a.frac) || a.i - b.i);
  for (const o of order) {
    if (left <= 0) break;
    weights[o.i] = (weights[o.i] ?? 0) + 1;
    left -= 1;
  }
  if (weights.some((w) => w <= 0)) return null;
  const minWeight = Math.min(stable, ...weights);
  if (dec(ctx.capital).mul(minWeight).div(100).lt(minOrderNotional(ctx.market))) return null;
  const sigmas = basket.map((b) => b.sigma30).filter((s): s is number => s !== null);
  const avgSigmaPct =
    sigmas.length === 0 ? null : (sigmas.reduce((a, b) => a + b, 0) / sigmas.length) * 100;
  const threshold =
    avgSigmaPct !== null && avgSigmaPct < C.rebalancing.sigmaSplitPct
      ? C.rebalancing.thresholdLowPct
      : C.rebalancing.thresholdHighPct;
  const quote = ctx.market.quote;
  return {
    values: {
      quoteAsset: quote.replace(/^v/, ""),
      assets: [
        ...basket.map((b, i) => ({
          asset: b.asset,
          market: b.market,
          weightPct: String(weights[i] ?? 0),
        })),
        { asset: quote.replace(/^v/, ""), weightPct: String(stable) },
      ],
      rebalanceWhen: "threshold",
      thresholdPct: threshold,
      investment: q(ctx.capital),
      maxTradePct: C.rebalancing.maxTradePct,
    },
    reasons: [
      total.isZero()
        ? "Equal weights: no trading history on these assets."
        : "Weights follow your trading volume on these assets.",
      `${quote} kept at ${String(stable)}% or more.`,
      `Rebalances when an asset drifts more than ${threshold}% from its target.`,
    ],
    basis:
      avgSigmaPct === null
        ? "Volatility not available."
        : `Average daily volatility of the basket: ${pct(avgSigmaPct)}.`,
    lossAtStopPct: null,
  };
}

// ---------- Funding Arbitrage ----------

export function fundingArbParams(ctx: ParamContext): Params | null {
  const perp = ctx.market;
  const spot = ctx.spotMarket;
  if (spot === undefined || perp.fundingAvg7d === null || perp.fundingPos21 === null) return null;
  const half = dec(ctx.capital).div(2);
  if (half.lt(minOrderNotional(spot)) || half.lt(minOrderNotional(perp))) return null;
  return {
    values: {
      asset: perp.asset,
      spotMarket: spot.market,
      perpMarket: perp.market,
      leverage: 1,
      investment: q(ctx.capital),
      enterFundingPct: C.fundingArb.enterPct,
      exitFundingPct: C.fundingArb.exitPct,
      maxGapPct: C.fundingArb.maxGapPct,
      minMarginRatioPct: C.fundingArb.minMarginRatioPct,
      maxLoss: q(dec(ctx.capital).mul(ctx.maxDropPct).div(100)),
    },
    reasons: [
      `Funding averaged ${pct(dec(perp.fundingAvg7d), 4)} per period over 7 days.`,
      `Funding was positive in ${pct(perp.fundingPos21 * 100, 0)} of the last 21 periods.`,
      "Spot leg and an equal 1× perp short: price exposure ≈ 0.",
    ],
    basis: `${perp.market}: funding history from SoDEX. This describes funding, not profit.`,
    lossAtStopPct: null,
  };
}

export function paramsFor(strategy: RecoStrategy, ctx: ParamContext): Params | null {
  switch (strategy) {
    case "spot_grid":
    case "futures_grid":
      return gridParams(strategy, ctx);
    case "spot_dca":
    case "futures_dca":
      return dcaParams(strategy, ctx);
    case "recurring_buy":
      return recurringParams(ctx);
    case "rebalancing":
      return rebalancingParams(ctx);
    case "funding_arb":
      return fundingArbParams(ctx);
  }
}

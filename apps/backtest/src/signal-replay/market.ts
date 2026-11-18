import { Decimal } from "@drift/shared";

import { roundTripCostBp, spreadAt, type SpreadHour } from "./costs";
import { PAPER_SIZE_USDC, type Direction, type ExitReason, type SignalTrade } from "./types";

// Giá và mô phỏng lệnh replay (#274), thuần (không I/O). Một market một lần: nến 1 phút của market đó nằm trong bộ nhớ
// (bộ nạp giới hạn số nến), các evaluator A / B / C dùng chung.

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

export interface Candle {
  /** Đầu phút (ms). Nến đóng lúc ts + 60 s. */
  ts: number;
  open: Decimal;
  high: Decimal;
  low: Decimal;
  close: Decimal;
  /** Khối lượng (base), chỉ dùng để phát hiện tín hiệu, không phải tiền. */
  volume: number;
}

/** Luật chung cho TP / SL / vào lệnh (giống tín hiệu news của #269). */
export const TRADE_RULES_V1 = {
  /** TP = 1.5 × và SL = 0.75 × biến động thường gặp trong thời gian giữ tối đa. */
  tpMultiple: new Decimal("1.5"),
  slMultiple: new Decimal("0.75"),
  /** Bỏ tín hiệu khi TP < 2 × chi phí khứ hồi ("Too thin to trade"). */
  minTpCostMultiple: new Decimal(2),
  /** Biến động thường gặp đo trên 30 ngày trước lúc vào (theo giá đóng mỗi giờ). */
  volLookbackMs: 30 * DAY,
  /** Ít hơn chừng này mẫu theo giờ thì không tính biến động (5 ngày). */
  volMinSamples: 120,
  /** Dưới 30 ngày lịch sử thì gắn cờ `vol_history_short`. */
  volFullSamples: 30 * 24 - 24,
  /** Giá vào phải có trong chừng này sau lúc thấy tín hiệu. */
  maxEntryWaitMs: 5 * MIN,
  /** Một khoảng trống nến dài hơn chừng này trong lúc giữ: dữ liệu thiếu (máy thu dừng), bỏ lệnh. */
  maxGapMs: 30 * MIN,
} as const;

/** Market có nến ở ít hơn chừng này phần số phút được coi là ít giao dịch (khoảng trống là do không có trade). */
export const ILLIQUID_COVERAGE = 0.9;

export class Series {
  /** Phần số phút có nến trong khoảng đã nạp (0–1). */
  readonly minuteCoverage: number;

  constructor(
    readonly market: string,
    readonly candles: readonly Candle[],
  ) {
    const first = candles[0]?.ts;
    const last = candles.at(-1)?.ts;
    this.minuteCoverage =
      first === undefined || last === undefined ? 0 : candles.length / ((last - first) / MIN + 1);
  }

  /** Chỉ số nến đầu tiên có ts ≥ t; không có → length. */
  firstAtOrAfter(t: number): number {
    let lo = 0;
    let hi = this.candles.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((this.candles[mid]?.ts ?? Infinity) < t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** Giá đóng của nến cuối cùng đã đóng tại / trước `t` (ts + 60 s ≤ t), không cũ quá `maxAgeMs`. */
  closeAt(t: number, maxAgeMs = 10 * MIN): Decimal | null {
    const i = this.firstAtOrAfter(t - MIN + 1) - 1;
    const c = this.candles[i];
    if (c === undefined || t - (c.ts + MIN) > maxAgeMs) return null;
    return c.close;
  }

  /** Giá đóng theo giờ (đầu giờ → close nến đã đóng gần nhất trong 10 phút), cho biến động thường gặp. */
  hourlyCloses(): Map<number, Decimal> {
    const out = new Map<number, Decimal>();
    const first = this.candles[0];
    const last = this.candles.at(-1);
    if (first === undefined || last === undefined) return out;
    for (let h = Math.ceil(first.ts / HOUR) * HOUR; h <= last.ts + MIN; h += HOUR) {
      const c = this.closeAt(h);
      if (c !== null) out.set(h, c);
    }
    return out;
  }
}

/** Trung vị của một mảng Decimal; rỗng → null. */
export function medianDec(values: readonly Decimal[]): Decimal | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a.cmp(b));
  const mid = Math.floor(s.length / 2);
  const hi = s[mid];
  const lo = s[mid - 1];
  if (hi === undefined) return null;
  return s.length % 2 === 1 || lo === undefined ? hi : lo.add(hi).div(2);
}

/**
 * Biến động thường gặp trong `holdMs` tại `at`: trung vị |close(h + hold) ÷ close(h) − 1| với mọi giờ h mà cả hai mốc nằm
 * trong `volLookbackMs` TRƯỚC `at` (không nhìn tương lai). Trả tỷ lệ và số mẫu; thiếu mẫu → null.
 */
export function typicalMove(
  hourly: ReadonlyMap<number, Decimal>,
  at: number,
  holdMs: number,
  rules = TRADE_RULES_V1,
): { move: Decimal; samples: number } | null {
  const steps = Math.max(1, Math.round(holdMs / HOUR));
  const end = Math.floor(at / HOUR) * HOUR;
  const moves: Decimal[] = [];
  for (let h = end - rules.volLookbackMs; h + steps * HOUR <= end; h += HOUR) {
    const a = hourly.get(h);
    const b = hourly.get(h + steps * HOUR);
    if (a === undefined || b === undefined || a.isZero()) continue;
    moves.push(b.div(a).sub(1).abs());
  }
  if (moves.length < rules.volMinSamples) return null;
  const m = medianDec(moves);
  return m === null || m.isZero() ? null : { move: m, samples: moves.length };
}

export interface PathResult {
  exitAt: number;
  exit: Decimal;
  reason: ExitReason;
  mfeBp: Decimal;
  maeBp: Decimal;
}

/** Kết quả theo chiều lệnh (bp). */
export function directedBp(direction: Direction, entry: Decimal, exit: Decimal): Decimal {
  const r = exit.sub(entry).div(entry).mul(10_000);
  return direction === "long" ? r : r.neg();
}

/**
 * Dữ liệu giá có phủ trọn thời gian giữ không, xét TRƯỚC khi biết kết quả (không phụ thuộc lệnh chạm TP / SL hay chưa):
 * `"gap"` khi có khoảng trống nến dài hơn `maxGapMs` ở bất kỳ đâu trong [entryAt, entryAt + hold) (kể cả từ lúc vào tới nến
 * đầu và từ nến cuối tới hết giờ), `"no_data"` khi dữ liệu dừng trước khi hết giờ.
 */
export function holdCoverage(
  series: Series,
  entryAt: number,
  holdMs: number,
  rules = TRADE_RULES_V1,
): "ok" | "gap" | "no_data" {
  const end = entryAt + holdMs;
  const lastTs = series.candles.at(-1)?.ts ?? -Infinity;
  if (lastTs + MIN < end) return "no_data";
  let prev = entryAt;
  for (let i = series.firstAtOrAfter(entryAt); i < series.candles.length; i++) {
    const c = series.candles[i];
    if (c === undefined || c.ts >= end) break;
    if (c.ts - prev > rules.maxGapMs) return "gap";
    prev = c.ts + MIN;
  }
  return end - prev > rules.maxGapMs ? "gap" : "ok";
}

/**
 * Đi theo nến 1 phút từ `startIdx` (nến vào lệnh, giá vào = open của nó) tới `entryAt + holdMs`. Long: chạm SL khi low ≤ SL,
 * chạm TP khi high ≥ TP; Short ngược lại. Cùng một nến chạm cả hai → tính SL (thận trọng). Giá mở đã vượt SL (nhảy giá) →
 * thoát ở giá mở (tệ hơn SL); giá mở đã vượt TP → thoát đúng ở TP (không lấy phần nhảy có lợi). `partial` = nến chứa lúc vào
 * khi vào giữa phút bằng `mid_1s`: chỉ kiểm SL trên nó (thận trọng, high / low gồm cả phần trước lúc vào). Hết giờ → close
 * của nến cuối kết thúc trước / đúng mốc. Khoảng trống dữ liệu xét riêng ở `holdCoverage` (trước khi biết kết quả).
 */
export function walkPath(
  series: Series,
  startIdx: number,
  direction: Direction,
  entry: Decimal,
  tp: Decimal,
  sl: Decimal,
  entryAt: number,
  holdMs: number,
  partial: Candle | null = null,
): PathResult | "no_data" {
  const end = entryAt + holdMs;
  const long = direction === "long";
  let mfe = new Decimal(0);
  let mae = new Decimal(0);
  let last: Candle | null = null;
  const out = (exitAt: number, exit: Decimal, reason: ExitReason): PathResult => ({
    exitAt,
    exit,
    reason,
    mfeBp: mfe,
    maeBp: mae,
  });
  if (partial !== null) {
    const adv = directedBp(direction, entry, long ? partial.low : partial.high);
    if (adv.lt(mae)) mae = adv;
    if (long ? partial.low.lte(sl) : partial.high.gte(sl)) return out(entryAt, sl, "stop_loss");
  }
  for (let i = startIdx; i < series.candles.length; i++) {
    const c = series.candles[i];
    if (c === undefined || c.ts >= end) break;
    last = c;
    const fav = directedBp(direction, entry, long ? c.high : c.low);
    const adv = directedBp(direction, entry, long ? c.low : c.high);
    if (fav.gt(mfe)) mfe = fav;
    if (adv.lt(mae)) mae = adv;
    const slHit = long ? c.low.lte(sl) : c.high.gte(sl);
    const tpHit = long ? c.high.gte(tp) : c.low.lte(tp);
    if (slHit) {
      const gapped = long ? c.open.lt(sl) : c.open.gt(sl);
      return out(c.ts, gapped ? c.open : sl, "stop_loss");
    }
    if (tpHit) return out(c.ts, tp, "take_profit");
  }
  if (last === null) return "no_data";
  return out(end, last.close, "max_hold");
}

/** TP / SL theo chiều lệnh từ khoảng cách tỷ lệ. */
export function levels(
  direction: Direction,
  entry: Decimal,
  tpDist: Decimal,
  slDist: Decimal,
): { tp: Decimal; sl: Decimal } {
  return direction === "long"
    ? { tp: entry.mul(new Decimal(1).add(tpDist)), sl: entry.mul(new Decimal(1).sub(slDist)) }
    : { tp: entry.mul(new Decimal(1).sub(tpDist)), sl: entry.mul(new Decimal(1).add(slDist)) };
}

export interface MarketContext {
  series: Series;
  hourly: ReadonlyMap<number, Decimal>;
  spreadHours: readonly SpreadHour[];
  tick: Decimal | null;
  /** Giá ngay sau lúc thấy tín hiệu từ `mid_1s` (nếu có), theo seenAt. */
  midAfter?: ReadonlyMap<number, Decimal>;
  /**
   * Market tham chiếu luôn có giao dịch (BTC-USD): khi market này có khoảng trống mà tham chiếu thì không, khoảng trống là
   * do market ít giao dịch; cả hai cùng trống là do máy thu dừng. Không có → xét theo phần số phút có nến.
   */
  reference?: Series;
}

/**
 * Vào một lệnh replay cho tín hiệu `t` (đã có chiều, eventAt, seenAt, maxHold): giá vào = mid_1s ngay sau seenAt nếu có,
 * không thì open của nến phút đầu tiên bắt đầu tại / sau seenAt; TP / SL từ biến động thường gặp; chi phí; bỏ nếu TP < 2 ×
 * chi phí; mô phỏng cả Long lẫn Short cùng TP / SL / max hold (cho random baseline). Sửa `t` tại chỗ và trả về nó.
 */
export function enterAndWalk(
  t: SignalTrade,
  ctx: MarketContext,
  rules = TRADE_RULES_V1,
): SignalTrade {
  const { series } = ctx;
  const idx = series.firstAtOrAfter(t.seenAt);
  const candle = series.candles[idx];
  if (candle === undefined || candle.ts - t.seenAt > rules.maxEntryWaitMs) {
    t.skipReason = "No SoDEX price after the signal";
    return t;
  }
  const mid = ctx.midAfter?.get(t.seenAt);
  const entry = mid ?? candle.open;
  const entryAt = mid === undefined ? candle.ts : t.seenAt;
  if (mid !== undefined) t.flags.push("entry_mid_1s");
  const before = series.closeAt(t.eventAt);
  t.movedBeforeEntryBp = before === null ? null : entry.sub(before).div(before).mul(10_000);
  const vol = typicalMove(ctx.hourly, entryAt, t.maxHoldMs, rules);
  if (vol === null) {
    t.skipReason = "Not enough price history for the typical move";
    return t;
  }
  if (vol.samples < rules.volFullSamples) t.flags.push("vol_history_short");
  const spread = spreadAt(t.asset, entryAt, entry, ctx.spreadHours, ctx.tick);
  if (spread.source === "default") t.flags.push("spread_default");
  else t.flags.push("tick_inferred");
  const cost = roundTripCostBp(spread.spreadBp);
  const tpDist = vol.move.mul(rules.tpMultiple);
  const slDist = vol.move.mul(rules.slMultiple);
  const lv = levels(t.direction, entry, tpDist, slDist);
  t.entry = entry;
  t.entryAt = entryAt;
  t.tp = lv.tp;
  t.sl = lv.sl;
  t.costBp = cost;
  t.detail.typicalMoveBp = vol.move.mul(10_000).toDecimalPlaces(2).toNumber();
  t.detail.spreadBp = spread.spreadBp.toDecimalPlaces(2).toNumber();
  const tpBp = tpDist.mul(10_000);
  if (tpBp.lt(cost.mul(rules.minTpCostMultiple))) {
    t.skipReason = `Too thin to trade: take profit ${tpBp.toDecimalPlaces(1).toString()} bp under 2× cost (${cost.mul(rules.minTpCostMultiple).toDecimalPlaces(1).toString()} bp)`;
    return t;
  }
  // Khoảng trống dữ liệu xét trên cả thời gian giữ, trước khi biết kết quả. Market ít giao dịch (market tham chiếu có giao
  // dịch suốt thời gian đó) đếm riêng với lý do "Illiquid market".
  const cover = holdCoverage(series, entryAt, t.maxHoldMs, rules);
  if (cover === "gap") {
    const ref = ctx.reference;
    const illiquid =
      ref !== undefined && ref !== series
        ? holdCoverage(ref, entryAt, t.maxHoldMs, rules) === "ok"
        : series.minuteCoverage < ILLIQUID_COVERAGE;
    t.skipReason = illiquid
      ? "Illiquid market: no trades for over 30 min during the hold"
      : "Price data gap during the hold (collector down)";
    t.detail.marketMinuteCoverage = Math.round(series.minuteCoverage * 1000) / 1000;
    return t;
  }
  if (cover === "no_data") {
    t.skipReason = "Not closed: price data ends before max hold";
    return t;
  }
  // Nến vào: nến bắt đầu tại / sau entryAt. Vào bằng mid_1s giữa phút: phần còn lại của phút đó chỉ kiểm SL, rồi từ nến
  // phút kế tiếp.
  const start = series.firstAtOrAfter(entryAt);
  const partial =
    mid === undefined ? null : (series.candles[series.firstAtOrAfter(entryAt - MIN + 1)] ?? null);
  const partialCandle = partial !== null && partial.ts < entryAt ? partial : null;
  const sims: Record<Direction, PathResult | "no_data"> = { long: "no_data", short: "no_data" };
  for (const d of ["long", "short"] as const) {
    const l = levels(d, entry, tpDist, slDist);
    sims[d] = walkPath(series, start, d, entry, l.tp, l.sl, entryAt, t.maxHoldMs, partialCandle);
  }
  const mine = sims[t.direction];
  if (mine === "no_data") {
    t.skipReason = "Not closed: price data ends before max hold";
    return t;
  }
  const net = (r: PathResult | "no_data", d: Direction) =>
    typeof r === "string" ? null : directedBp(d, entry, r.exit).sub(cost);
  t.status = "entered";
  t.exitAt = mine.exitAt;
  t.exit = mine.exit;
  t.exitReason = mine.reason;
  t.grossBp = directedBp(t.direction, entry, mine.exit);
  t.resultAfterFeesBp = t.grossBp.sub(cost);
  t.resultAfterFeesUsd = t.resultAfterFeesBp.div(10_000).mul(PAPER_SIZE_USDC);
  t.mfeBp = mine.mfeBp;
  t.maeBp = mine.maeBp;
  t.longAfterFeesBp = net(sims.long, "long");
  t.shortAfterFeesBp = net(sims.short, "short");
  return t;
}

/**
 * Một lệnh mở mỗi (loại, biến thể, market): tín hiệu tới khi lệnh trước chưa đóng thì bỏ ("already open"), kể cả tín
 * hiệu ngược chiều (lệnh cũ giữ TP / SL, #263). `openUntil` là exitAt của lệnh đang mở.
 */
export function alreadyOpen(openUntil: number | null, at: number): boolean {
  return openUntil !== null && at < openUntil;
}

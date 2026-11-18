import { dec, Decimal, type DecimalInput } from "../money";

import { TradeDirection } from "./rules";

// Phần thuần của báo cáo lane tin tức (#271): phát lại TP / SL / giữ tối đa trên nến 1 phút và so với lệnh vào ngẫu
// nhiên. Lệnh ngẫu nhiên = cùng thời điểm, cùng market, cùng TP / SL / giữ, chiều long với xác suất bằng tỉ lệ long của
// mẫu (cùng tỉ lệ Long / Short). Kỳ vọng của lệnh ngẫu nhiên tính đúng: p × kết quả long + (1 − p) × kết quả short, nên
// không cần gieo số ngẫu nhiên.

const HUNDRED = new Decimal(100);

export interface Candle {
  ts: number;
  high: DecimalInput;
  low: DecimalInput;
  close: DecimalInput;
}

/**
 * Phát lại một lệnh trên nến 1 phút (giá giữa xấp xỉ): long chạm SL khi low ≤ SL, TP khi high ≥ TP; cùng một nến chạm cả
 * hai thì tính SL trước (thận trọng). Hết giữ → giá đóng của nến cuối trước hạn. Trả % thô theo chiều (chưa trừ chi phí);
 * không có nến nào → null.
 */
export function replayOnCandles(input: {
  direction: TradeDirection;
  entry: DecimalInput;
  tpPct: DecimalInput;
  slPct: DecimalInput;
  candles: readonly Candle[];
  /** Nến có `ts` từ mốc này (phút sau lúc vào) tới trước `until` được xét. */
  from: number;
  until: number;
}): Decimal | null {
  const entry = dec(input.entry);
  if (entry.lte(0)) return null;
  const long = input.direction === TradeDirection.long;
  const tp = dec(input.tpPct);
  const sl = dec(input.slPct);
  const tpPx = long
    ? entry.mul(HUNDRED.add(tp)).div(HUNDRED)
    : entry.mul(HUNDRED.sub(tp)).div(HUNDRED);
  const slPx = long
    ? entry.mul(HUNDRED.sub(sl)).div(HUNDRED)
    : entry.mul(HUNDRED.add(sl)).div(HUNDRED);
  let last: Decimal | null = null;
  for (const c of input.candles) {
    if (c.ts < input.from || c.ts >= input.until) continue;
    const hi = dec(c.high);
    const lo = dec(c.low);
    if (long ? lo.lte(slPx) : hi.gte(slPx)) return sl.neg();
    if (long ? hi.gte(tpPx) : lo.lte(tpPx)) return tp;
    last = dec(c.close);
  }
  if (last === null) return null;
  const move = last.sub(entry).div(entry).mul(HUNDRED);
  return long ? move : move.neg();
}

export interface MeanRange {
  n: number;
  mean: Decimal;
  /** Độ lệch chuẩn mẫu; null khi n < 2. */
  sd: Decimal | null;
  /** Khoảng 95% của trung bình (mean ± 1.96 × sd ÷ √n); null khi n < 2. */
  low: Decimal | null;
  high: Decimal | null;
}

export function meanRange(values: readonly Decimal[]): MeanRange | null {
  const n = values.length;
  if (n === 0) return null;
  const mean = values.reduce((s, v) => s.add(v), new Decimal(0)).div(n);
  if (n < 2) return { n, mean, sd: null, low: null, high: null };
  const variance = values.reduce((s, v) => s.add(v.sub(mean).pow(2)), new Decimal(0)).div(n - 1);
  const sd = variance.sqrt();
  const half = sd.div(new Decimal(n).sqrt()).mul("1.96");
  return { n, mean, sd, low: mean.sub(half), high: mean.add(half) };
}

export interface BaselineTrade {
  direction: TradeDirection;
  /** Kết quả sau chi phí (%) khi phát lại theo chiều long / short trên cùng nến; null khi không có nến. */
  longPct: Decimal | null;
  shortPct: Decimal | null;
}

export interface Baseline {
  n: number;
  /** Lệnh bị bỏ vì thiếu nến. */
  skipped: number;
  longShare: Decimal | null;
  news: MeanRange | null;
  random: MeanRange | null;
  /** Chênh lệch từng lệnh (tin − ngẫu nhiên). */
  difference: MeanRange | null;
}

export function baselineOf(trades: readonly BaselineTrade[]): Baseline {
  const usable = trades.filter(
    (t): t is BaselineTrade & { longPct: Decimal; shortPct: Decimal } =>
      t.longPct !== null && t.shortPct !== null,
  );
  const n = usable.length;
  if (n === 0)
    return {
      n,
      skipped: trades.length,
      longShare: null,
      news: null,
      random: null,
      difference: null,
    };
  const p = new Decimal(usable.filter((t) => t.direction === TradeDirection.long).length).div(n);
  const news: Decimal[] = [];
  const random: Decimal[] = [];
  const diff: Decimal[] = [];
  for (const t of usable) {
    const own = t.direction === TradeDirection.long ? t.longPct : t.shortPct;
    const rnd = p.mul(t.longPct).add(new Decimal(1).sub(p).mul(t.shortPct));
    news.push(own);
    random.push(rnd);
    diff.push(own.sub(rnd));
  }
  return {
    n,
    skipped: trades.length - n,
    longShare: p,
    news: meanRange(news),
    random: meanRange(random),
    difference: meanRange(diff),
  };
}

// ── Cổng (#263, chốt lại ở #269 v3.4) ────────────────────────────────────────────────────────────────────────────

/** Mức sàn số lệnh đã đóng của cổng. */
export const GATE_MIN_CLOSED = 100;

export type GateStatus = "collecting" | "failing" | "passing";

/**
 * Cổng: ≥ 100 lệnh đã đóng; trung bình sau phí ≥ 2 × chi phí và khoảng 95% trên 0; thắng lệnh ngẫu nhiên (khoảng 95% của
 * phần chênh trên 0); cùng dấu ở hai nửa giai đoạn (theo thứ tự thời gian). Chưa đủ 100 → collecting.
 */
export function gateStatus(input: {
  results: readonly Decimal[];
  avgCostPct: Decimal | null;
  difference: MeanRange | null;
}): GateStatus {
  const r = meanRange(input.results);
  if (r === null || r.n < GATE_MIN_CLOSED) return "collecting";
  const half = Math.floor(input.results.length / 2);
  const first = meanRange(input.results.slice(0, half));
  const second = meanRange(input.results.slice(half));
  const sameSign =
    first !== null && second !== null && first.mean.isPositive() === second.mean.isPositive();
  const pass =
    input.avgCostPct !== null &&
    r.mean.gte(input.avgCostPct.mul(2)) &&
    r.low !== null &&
    r.low.gt(0) &&
    input.difference?.low != null &&
    input.difference.low.gt(0) &&
    sameSign;
  return pass ? "passing" : "failing";
}

/**
 * Số lệnh cần để khoảng 95% của phần chênh so với ngẫu nhiên không chạm 0: n ≈ (1.96 × sd ÷ trung bình)², không dưới
 * mức sàn. Trung bình ≤ 0 hoặc chưa có độ phân tán → null (không ước được).
 */
export function tradesNeeded(difference: MeanRange | null): number | null {
  if (difference?.sd == null || difference.mean.lte(0)) return null;
  const n = new Decimal("1.96").mul(difference.sd).div(difference.mean).pow(2).ceil().toNumber();
  return Math.max(GATE_MIN_CLOSED, n);
}

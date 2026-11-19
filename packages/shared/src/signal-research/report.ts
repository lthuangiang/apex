import { dec, Decimal, type DecimalInput } from "../money";
import {
  summarizeByDay,
  tradesNeededByDay,
  type DayObs,
  type DaySummary,
} from "../stats/day-bootstrap";

import { TradeDirection } from "./rules";

// Phần thuần của báo cáo lane tin tức (#271): phát lại TP / SL / giữ tối đa trên nến 1 phút và so với lệnh vào ngẫu
// nhiên. Lệnh ngẫu nhiên = cùng thời điểm, cùng market, cùng TP / SL / giữ, chiều long với xác suất bằng tỉ lệ long của
// mẫu (cùng tỉ lệ Long / Short). Kỳ vọng của lệnh ngẫu nhiên tính đúng: p × kết quả long + (1 − p) × kết quả short, nên
// không cần gieo số ngẫu nhiên. Scheduler tính và lưu một lần cho mỗi lệnh (khi cửa sổ giữ đã xong); báo cáo chỉ đọc.
// Khoảng 95% và cổng dùng block bootstrap theo ngày vào lệnh (DEC-321, `summarizeByDay`).

const HUNDRED = new Decimal(100);

export interface Candle {
  ts: number;
  high: DecimalInput;
  low: DecimalInput;
  close: DecimalInput;
}

/**
 * Phát lại một lệnh trên nến 1 phút (giá giữa xấp xỉ): long chạm SL khi low ≤ SL, TP khi high ≥ TP; cùng một nến chạm cả
 * hai thì tính SL trước (thận trọng); nhảy qua TP vẫn thoát đúng ở TP (như DEC-321). Không chạm gì → giá đóng của nến cuối
 * trong cửa sổ (`hit = false`; chỉ là kết quả cuối khi cửa sổ giữ đã xong). Trả % thô theo chiều (chưa trừ chi phí); không
 * có nến nào → null.
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
}): { pct: Decimal; hit: boolean } | null {
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
    if (long ? lo.lte(slPx) : hi.gte(slPx)) return { pct: sl.neg(), hit: true };
    if (long ? hi.gte(tpPx) : lo.lte(tpPx)) return { pct: tp, hit: true };
    last = dec(c.close);
  }
  if (last === null) return null;
  const move = last.sub(entry).div(entry).mul(HUNDRED);
  return { pct: long ? move : move.neg(), hit: false };
}

/** Kết quả kỳ vọng của lệnh vào ngẫu nhiên: p × long + (1 − p) × short (cùng chi phí đã trừ ở hai vế). */
export function randomResult(longPct: Decimal, shortPct: Decimal, longShare: Decimal): Decimal {
  return longShare.mul(longPct).add(new Decimal(1).sub(longShare).mul(shortPct));
}

// ── Cổng (#263, chốt lại ở #269 v3.4) ────────────────────────────────────────────────────────────────────────────

/** Mức sàn số lệnh đã đóng của cổng. */
export const GATE_MIN_CLOSED = 100;

/**
 * #344: trang "Is it working?" chỉ hiện trung bình sau phí (và so với ngẫu nhiên) của một loại tín hiệu khi đã có ngần này
 * lệnh đóng được tính ("Average shows at 30 closed"); ít hơn thì một hai lệnh may / rủi trông như kết quả.
 */
export const AVG_SHOWN_AT_CLOSED = 30;

export type GateStatus = "collecting" | "failing" | "passing";

/**
 * Cổng: ≥ 100 lệnh đã đóng; trung bình sau phí ≥ 2 × chi phí và khoảng 95% (bootstrap theo ngày) trên 0; thắng lệnh ngẫu
 * nhiên (khoảng 95% của phần chênh trên 0); cùng dấu ở hai nửa giai đoạn (theo giờ vào lệnh). Chưa đủ 100 → collecting.
 */
export function gateStatus(input: {
  results: readonly DayObs[];
  avgCostPct: Decimal | null;
  difference: DaySummary | null;
}): GateStatus {
  if (input.results.length < GATE_MIN_CLOSED) return "collecting";
  const sorted = [...input.results].sort((a, b) => a.at - b.at);
  const r = summarizeByDay(sorted);
  const half = Math.floor(sorted.length / 2);
  const first = summarizeByDay(sorted.slice(0, half)).mean;
  const second = summarizeByDay(sorted.slice(half)).mean;
  const sameSign =
    first !== null &&
    second !== null &&
    !first.isZero() &&
    first.isPositive() === second.isPositive();
  const pass =
    r.mean !== null &&
    input.avgCostPct !== null &&
    r.mean.gte(input.avgCostPct.mul(2)) &&
    r.ciLow?.gt(0) === true &&
    input.difference?.ciLow?.gt(0) === true &&
    sameSign;
  return pass ? "passing" : "failing";
}

/**
 * Số lệnh cần để khoảng 95% của phần chênh so với ngẫu nhiên không chạm 0 (power 80%, sd hiệu dụng theo bootstrap ngày,
 * như DEC-321), không dưới mức sàn. Chưa ước được → null.
 */
export function tradesNeeded(difference: DaySummary | null): number | null {
  const n = difference === null ? null : tradesNeededByDay(difference);
  return n === null ? null : Math.max(GATE_MIN_CLOSED, n);
}

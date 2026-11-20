import { dec, Decimal, type DecimalInput } from "../money";
import type { DayObs } from "../stats/day-bootstrap";

import { midRankPercentile } from "./context";
import { NEWS_RULES } from "./rules";

// Trạng thái thị trường lúc quyết định (Catalyst P0, #376, DEC-TBD-catalyst-p0 mục 1). Chỉ ghi lại để tách kết quả, không
// bao giờ đổi quyết định. Hàm thuần, không I/O; nơi gọi chỉ đưa vào giá của nến 1 phút đã ĐÓNG trước thời điểm quyết định.

/** Version của cách tính trạng thái thị trường; đổi ngưỡng / định nghĩa = version mới, snapshot cũ giữ nguyên. */
export const MARKET_STATE_VERSION = "market-v1";

export const MARKET_STATE_RULES = {
  /** BTC trend: % đổi giá BTC-USD trong ngần này giờ. */
  btcMarket: "BTC-USD",
  btcHours: 24,
  /** Trên mức này là `up` (đúng bằng là `flat`). */
  btcUpPct: 1.5,
  /** Dưới mức này là `down` (đúng bằng là `flat`). */
  btcDownPct: -1.5,
  /** Volatility: biến động của chính tài sản trong ngần này giờ. */
  volHours: 4,
  /** Xếp phân vị so với ngần này ngày trước (cùng cửa sổ với biến động thường gặp của Decide). */
  volLookbackDays: NEWS_RULES.volatilityLookbackDays,
  /** Ít hơn ngần này cặp giờ trong cửa sổ → không xếp được (null), như biến động thường gặp của Decide. */
  volMinSamples: NEWS_RULES.volatilityMinSamples,
  /**
   * Thiếu nến trong cửa sổ 4 h (PM chốt ở review #381): cửa sổ = các nến 1 phút đóng trong 4 h trước quyết định (kỳ vọng
   * 240 nến). Thiếu khi có ít hơn ngần này phần số nến kỳ vọng (nến bị hổng / thiếu mẫu), hoặc tổng khối lượng của cửa sổ
   * = 0 (không có giao dịch). Thiếu → volatility null ("Not available"), không bao giờ "0%".
   */
  volMinCoverage: 0.9,
  /** Dưới phân vị này là `low`, trên phân vị kia là `high` (đúng bằng là `normal`). */
  volLowPercentile: 33,
  volHighPercentile: 67,
  /** Giá "lúc t" = giá đóng nến 1 phút cuối cùng đóng trước t, tìm lùi tối đa ngần này phút; không có → null. */
  priceMaxAgeMinutes: 10,
  /** Tách kết quả theo trạng thái: mỗi nhóm cần ≥ ngần này lệnh đóng mới hiện trung bình. */
  minClosedPerGroup: 30,
} as const;

export const BTC_TRENDS = ["up", "flat", "down"] as const;
export type BtcTrend = (typeof BTC_TRENDS)[number];
export const VOLATILITY_STATES = ["low", "normal", "high"] as const;
export type VolatilityState = (typeof VOLATILITY_STATES)[number];

const HUNDRED = new Decimal(100);
const HOUR_MS = 3_600_000;

/** % đổi giá có dấu (after ÷ before − 1) × 100; giá trước ≤ 0 hoặc thiếu → null. */
export function pctChange(before: DecimalInput | null, after: DecimalInput | null): Decimal | null {
  if (before === null || after === null) return null;
  const b = dec(before);
  if (b.lte(0)) return null;
  return dec(after).div(b).sub(1).mul(HUNDRED);
}

/** BTC trend từ % đổi 24 h: > +1.5 → up, < −1.5 → down, còn lại (gồm đúng ±1.5) → flat; thiếu → null. */
export function btcTrendOf(changePct: Decimal | null): BtcTrend | null {
  if (changePct === null) return null;
  if (changePct.gt(MARKET_STATE_RULES.btcUpPct)) return "up";
  if (changePct.lt(MARKET_STATE_RULES.btcDownPct)) return "down";
  return "flat";
}

/**
 * Các biến động `hours` giờ (%, trị tuyệt đối) từ giá đóng mỗi giờ: |close(h + H) ÷ close(h) − 1| × 100, chỉ ghép đúng cặp h
 * và h + H (cùng cách ghép với biến động thường gặp của Decide, `typicalMovePct`).
 */
export function hourlyMovesPct(
  closes: readonly { hour: number; close: DecimalInput }[],
  hours: number,
): Decimal[] {
  const byHour = new Map<number, Decimal>();
  for (const c of closes) byHour.set(c.hour, dec(c.close));
  const moves: Decimal[] = [];
  for (const [hour, close] of byHour) {
    const later = byHour.get(hour + hours * HOUR_MS);
    if (later === undefined || close.lte(0)) continue;
    moves.push(later.sub(close).abs().div(close).mul(HUNDRED));
  }
  return moves;
}

/**
 * Cửa sổ 4 h có đủ nến để đo biến động: ≥ 90% số nến 1 phút kỳ vọng và có giao dịch (tổng khối lượng > 0). Chỉ khi đủ, biến
 * động 0% mới là giá thật sự đứng yên.
 */
export function volWindowComplete(input: {
  candles: number;
  volume: DecimalInput | null;
}): boolean {
  const r = MARKET_STATE_RULES;
  const expected = r.volHours * 60;
  if (input.candles < Math.ceil(expected * r.volMinCoverage)) return false;
  return input.volume !== null && dec(input.volume).gt(0);
}

export interface VolatilityResult {
  /** Biến động 4 h hiện tại (%, trị tuyệt đối). */
  movePct: Decimal;
  /** Phân vị (0–100, hạng giữa) trong các biến động 4 h của 30 ngày (gồm cả giá trị hiện tại). */
  percentile: number;
  state: VolatilityState;
}

/**
 * Volatility: biến động 4 h hiện tại xếp phân vị (hạng giữa) trong `history` (biến động 4 h mỗi giờ của 30 ngày trước, gồm
 * cả giá trị hiện tại). < 33 → low, > 67 → high, còn lại (gồm đúng 33 / 67) → normal. Thiếu giá trị hiện tại hoặc ít hơn
 * `volMinSamples` mẫu → null.
 */
export function volatilityOf(
  currentMovePct: Decimal | null,
  history: readonly Decimal[],
): VolatilityResult | null {
  if (currentMovePct === null || history.length < MARKET_STATE_RULES.volMinSamples) return null;
  const all = [...history, currentMovePct];
  const percentile = midRankPercentile(currentMovePct, all);
  if (percentile === null) return null;
  const r = MARKET_STATE_RULES;
  const state: VolatilityState =
    percentile < r.volLowPercentile ? "low" : percentile > r.volHighPercentile ? "high" : "normal";
  return { movePct: currentMovePct, percentile, state };
}

export interface MarketGroup<K extends string> {
  key: K;
  closed: number;
  /** Trung bình sau phí (%); null khi nhóm < 30 lệnh đóng. */
  avgPct: Decimal | null;
  /** Còn thiếu bao nhiêu lệnh đóng (0 khi đủ). */
  need: number;
}

/** Nhóm kết quả theo một chiều trạng thái; nhóm < 30 lệnh đóng không có trung bình. */
export function marketGroupsOf<K extends string>(
  keys: readonly K[],
  obs: readonly { key: K; obs: DayObs }[],
): MarketGroup<K>[] {
  const min = MARKET_STATE_RULES.minClosedPerGroup;
  return keys.map((key) => {
    const xs = obs.filter((o) => o.key === key).map((o) => o.obs.v);
    const closed = xs.length;
    const avgPct = closed < min ? null : xs.reduce((s, v) => s.add(v), new Decimal(0)).div(closed);
    return { key, closed, avgPct, need: Math.max(0, min - closed) };
  });
}

import { Decimal } from "@drift/shared";

import { alreadyOpen, enterAndWalk, type MarketContext } from "./market";
import { blankTrade, type SignalTrade } from "./types";

// B · Funding (#274, #265). Sự kiện từ `funding_rates` (SoDEX, do marketdata ghi; SoDEX không có lịch sử funding nên chỉ có
// từ lúc DeskLabs bắt đầu ghi). Luật v1 chốt trước khi xem kết quả: funding của một kỳ cao hơn hẳn phân vị 99% hoặc thấp
// hơn hẳn phân vị 1% của 90 ngày trước đó (cùng market, không gồm kỳ hiện tại) → đi ngược chiều (funding cao → Short,
// thấp → Long); giữ tối đa 8 giờ; vào ở giá ngay sau giờ funding. Cần ≥ 100 kỳ lịch sử; ít hơn 90 ngày thì gắn cờ.

const DAY = 86_400_000;

export const FUNDING_RULES_V1 = {
  version: "B-v1",
  lookbackMs: 90 * DAY,
  /** Phân vị trên / dưới. */
  tail: 0.01,
  minHistory: 100,
  maxHoldMs: 8 * 3_600_000,
} as const;

export interface FundingPoint {
  at: number;
  rate: Decimal;
}

/** Phân vị q (0–1) của mảng đã xếp tăng, nội suy tuyến tính. */
export function quantileSorted(sorted: readonly Decimal[], q: number): Decimal | null {
  if (sorted.length === 0) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const a = sorted[lo];
  const b = sorted[hi];
  if (a === undefined || b === undefined) return null;
  return a.add(b.sub(a).mul(pos - lo));
}

export interface FundingCoverage {
  market: string;
  points: number;
  first: number | null;
  last: number | null;
  days: number;
  /** Số kỳ có ÷ số giờ giữa kỳ đầu và kỳ cuối (funding SoDEX theo giờ). */
  hourlyCoverage: number | null;
}

/** Độ phủ funding của một market (bước đầu của B: có bao nhiêu ngày, đủ giờ không). */
export function fundingCoverage(market: string, points: readonly FundingPoint[]): FundingCoverage {
  const first = points[0]?.at ?? null;
  const last = points.at(-1)?.at ?? null;
  const hours = first === null || last === null ? 0 : Math.round((last - first) / 3_600_000) + 1;
  return {
    market,
    points: points.length,
    first,
    last,
    days: first === null || last === null ? 0 : Math.round(((last - first) / DAY) * 10) / 10,
    hourlyCoverage: hours === 0 ? null : Math.round((points.length / hours) * 1000) / 1000,
  };
}

export interface FundingFunnel {
  periods: number;
  shortHistory: number;
  notExtreme: number;
  signals: number;
}

export const emptyFundingFunnel = (): FundingFunnel => ({
  periods: 0,
  shortHistory: 0,
  notExtreme: 0,
  signals: 0,
});

/**
 * Chạy luật B v1 trên funding của MỘT market (xếp theo giờ, gồm cả 90 ngày trước `from` làm lịch sử). Chỉ kỳ trong
 * [from, to) tạo tín hiệu.
 */
export function evaluateFunding(
  market: string,
  points: readonly FundingPoint[],
  range: { from: number; to: number },
  ctx: MarketContext,
  funnel: FundingFunnel,
): SignalTrade[] {
  const rules = FUNDING_RULES_V1;
  const out: SignalTrade[] = [];
  let openUntil: number | null = null;
  let start = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (p === undefined || p.at < range.from || p.at >= range.to) continue;
    funnel.periods += 1;
    while ((points[start]?.at ?? Infinity) < p.at - rules.lookbackMs) start += 1;
    const window = points.slice(start, i);
    if (window.length < rules.minHistory) {
      funnel.shortHistory += 1;
      continue;
    }
    const sorted = window.map((x) => x.rate).sort((a, b) => a.cmp(b));
    const hi = quantileSorted(sorted, 1 - rules.tail);
    const lo = quantileSorted(sorted, rules.tail);
    if (hi === null || lo === null) continue;
    const direction = p.rate.gt(hi) ? "short" : p.rate.lt(lo) ? "long" : null;
    if (direction === null) {
      funnel.notExtreme += 1;
      continue;
    }
    funnel.signals += 1;
    const historyDays = (p.at - (window[0]?.at ?? p.at)) / DAY;
    const t = blankTrade({
      type: "funding",
      variant: "funding_extreme",
      ruleVersion: rules.version,
      asset: market,
      direction,
      eventAt: p.at,
      seenAt: p.at,
      maxHoldMs: rules.maxHoldMs,
      what: `Funding ${p.rate.mul(100).toSignificantDigits(3).toString()}% per hour, ${direction === "short" ? "highest" : "lowest"} 1% of the last ${String(Math.round(historyDays))} days`,
      detail: {
        rate: p.rate.toString(),
        p99: hi.toString(),
        p1: lo.toString(),
        historyPeriods: window.length,
        historyDays: Math.round(historyDays * 10) / 10,
      },
    });
    if (historyDays < rules.lookbackMs / DAY - 1) t.flags.push("funding_history_short");
    if (alreadyOpen(openUntil, p.at)) {
      t.skipReason = "A Funding trade on this asset is already open";
      out.push(t);
      continue;
    }
    enterAndWalk(t, ctx);
    if (t.status === "entered") openUntil = t.exitAt;
    out.push(t);
  }
  return out;
}

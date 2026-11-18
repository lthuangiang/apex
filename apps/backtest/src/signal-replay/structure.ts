import { alreadyOpen, enterAndWalk, type Candle, type MarketContext } from "./market";
import { blankTrade, type Direction, type SignalTrade } from "./types";

// C · Cấu trúc giá (#274, #266). Sự kiện từ `candles_1m` (SoDEX). Luật v1 chốt trước khi xem kết quả, hai biến thể, mỗi
// biến thể một "tài khoản" riêng (một lệnh mở mỗi market):
// - `range_breakout`: 60 nến 1 phút liền trước có đủ (không thiếu phút); close của nến hiện tại vượt high cao nhất (→ Long)
//   hoặc thủng low thấp nhất (→ Short) của 60 nến đó, và volume nến hiện tại ≥ 2 × trung vị volume 60 nến (trung vị > 0);
// - `squeeze_breakout`: cùng phá vỡ khoảng 60 phút (không xét volume), nhưng chỉ khi độ rộng khoảng (high − low) ÷ giá
//   giữa ≤ phân vị 20% của độ rộng đo mỗi 15 phút trong 24 giờ trước (≥ 80 mẫu).
// Tín hiệu lúc nến đóng; vào ở open của nến kế tiếp; giữ tối đa 1 giờ. Phát hiện tín hiệu dùng số thực (tỷ lệ, volume);
// giá vào / TP / SL / kết quả dùng Decimal (`enterAndWalk`).

const MIN = 60_000;

export const STRUCTURE_RULES_V1 = {
  version: "C-v1",
  rangeMinutes: 60,
  volumeMultiple: 2,
  squeezePercentile: 0.2,
  squeezeLookbackMs: 24 * 3_600_000,
  squeezeStepMs: 15 * MIN,
  squeezeMinSamples: 80,
  maxHoldMs: 3_600_000,
} as const;

export type StructureVariant = "range_breakout" | "squeeze_breakout";

export interface StructureFunnel {
  candles: number;
  breakouts: number;
  lowVolume: number;
  notSqueezed: number;
  signals: Record<StructureVariant, number>;
}

export const emptyStructureFunnel = (): StructureFunnel => ({
  candles: 0,
  breakouts: 0,
  lowVolume: 0,
  notSqueezed: 0,
  signals: { range_breakout: 0, squeeze_breakout: 0 },
});

interface Range {
  hi: number;
  lo: number;
  medianVolume: number;
}

/** Mảng số của nến một market (tính một lần), để phát hiện tín hiệu không phải đổi Decimal mỗi bước. */
export interface CandleNumbers {
  ts: Float64Array;
  hi: Float64Array;
  lo: Float64Array;
  vol: Float64Array;
}

export function candleNumbers(candles: readonly Candle[]): CandleNumbers {
  const n = candles.length;
  const out = {
    ts: new Float64Array(n),
    hi: new Float64Array(n),
    lo: new Float64Array(n),
    vol: new Float64Array(n),
  };
  candles.forEach((c, i) => {
    out.ts[i] = c.ts;
    out.hi[i] = c.high.toNumber();
    out.lo[i] = c.low.toNumber();
    out.vol[i] = c.volume;
  });
  return out;
}

/** Khoảng của `n` nến ngay trước chỉ số `i`, chỉ khi đủ n phút liền nhau; không thì null. */
export function rangeBefore(c: CandleNumbers, i: number, n: number): Range | null {
  if (i - n < 0 || i >= c.ts.length) return null;
  if ((c.ts[i] ?? 0) - (c.ts[i - n] ?? 0) !== n * MIN) return null;
  let hi = -Infinity;
  let lo = Infinity;
  const vols: number[] = [];
  for (let j = i - n; j < i; j++) {
    hi = Math.max(hi, c.hi[j] ?? -Infinity);
    lo = Math.min(lo, c.lo[j] ?? Infinity);
    vols.push(c.vol[j] ?? 0);
  }
  vols.sort((a, b) => a - b);
  const mid = n >> 1;
  const medianVolume =
    n % 2 === 1 ? (vols[mid] ?? 0) : ((vols[mid - 1] ?? 0) + (vols[mid] ?? 0)) / 2;
  return { hi, lo, medianVolume };
}

const widthOf = (r: Range) => (r.hi - r.lo) / ((r.hi + r.lo) / 2);

/**
 * Khoảng đang hẹp: độ rộng ≤ phân vị 20% của độ rộng đo mỗi 15 phút (mốc phút chia hết 15) trong 24 giờ trước. Thiếu
 * mẫu → null. `widthAt` có cache theo chỉ số nến.
 */
export function isSqueezed(
  at: number,
  width: number,
  widthAtTs: (t: number) => number | null,
): boolean | null {
  const rules = STRUCTURE_RULES_V1;
  const widths: number[] = [];
  const first =
    Math.ceil((at - rules.squeezeLookbackMs) / rules.squeezeStepMs) * rules.squeezeStepMs;
  for (let t = first; t < at; t += rules.squeezeStepMs) {
    const w = widthAtTs(t);
    if (w !== null) widths.push(w);
  }
  if (widths.length < rules.squeezeMinSamples) return null;
  widths.sort((a, b) => a - b);
  const cut = widths[Math.floor((widths.length - 1) * rules.squeezePercentile)];
  return cut !== undefined && width <= cut;
}

/** Chạy luật C v1 trên nến của MỘT market; chỉ nến đóng trong [from, to) tạo tín hiệu. */
export function evaluateStructure(
  ctx: MarketContext,
  range: { from: number; to: number },
  funnel: StructureFunnel,
): SignalTrade[] {
  const rules = STRUCTURE_RULES_V1;
  const { candles } = ctx.series;
  const out: SignalTrade[] = [];
  const openUntil: Record<StructureVariant, number | null> = {
    range_breakout: null,
    squeeze_breakout: null,
  };
  const nums = candleNumbers(candles);
  const widthCache = new Map<number, number | null>();
  const widthAtTs = (t: number): number | null => {
    const hit = widthCache.get(t);
    if (hit !== undefined) return hit;
    const j = ctx.series.firstAtOrAfter(t);
    const r = candles[j]?.ts === t ? rangeBefore(nums, j, rules.rangeMinutes) : null;
    const w = r === null || r.hi + r.lo <= 0 ? null : widthOf(r);
    widthCache.set(t, w);
    return w;
  };
  for (let i = ctx.series.firstAtOrAfter(range.from - MIN); i < candles.length; i++) {
    const c = candles[i];
    if (c === undefined) continue;
    const closeAt = c.ts + MIN;
    if (closeAt < range.from) continue;
    if (closeAt >= range.to) break;
    funnel.candles += 1;
    const r = rangeBefore(nums, i, rules.rangeMinutes);
    if (r === null) continue;
    const close = c.close.toNumber();
    const direction: Direction | null = close > r.hi ? "long" : close < r.lo ? "short" : null;
    if (direction === null) continue;
    funnel.breakouts += 1;
    const volMultiple = r.medianVolume > 0 ? c.volume / r.medianVolume : null;
    const width = widthOf(r);
    const variants: StructureVariant[] = [];
    if (volMultiple !== null && volMultiple >= rules.volumeMultiple)
      variants.push("range_breakout");
    else funnel.lowVolume += 1;
    const squeezed = isSqueezed(c.ts, width, widthAtTs);
    if (squeezed === true) variants.push("squeeze_breakout");
    else funnel.notSqueezed += 1;
    for (const variant of variants) {
      funnel.signals[variant] += 1;
      const t = blankTrade({
        type: "price_structure",
        variant,
        ruleVersion: rules.version,
        asset: ctx.series.market,
        direction,
        eventAt: closeAt,
        seenAt: closeAt,
        maxHoldMs: rules.maxHoldMs,
        what:
          variant === "range_breakout"
            ? `Broke 60-min range ${direction === "long" ? "up" : "down"}, volume ${String(Math.round((volMultiple ?? 0) * 10) / 10)}× usual`
            : `Broke a tight 60-min range ${direction === "long" ? "up" : "down"} (width ${String(Math.round(width * 100_000) / 10)} bp)`,
        detail: {
          rangeHigh: String(r.hi),
          rangeLow: String(r.lo),
          volumeMultiple: volMultiple === null ? null : Math.round(volMultiple * 100) / 100,
          rangeWidthBp: Math.round(width * 100_000) / 10,
        },
      });
      if (alreadyOpen(openUntil[variant], closeAt)) {
        t.skipReason = "A Price patterns trade on this asset is already open";
        out.push(t);
        continue;
      }
      enterAndWalk(t, ctx);
      if (t.status === "entered") openUntil[variant] = t.exitAt;
      out.push(t);
    }
  }
  return out;
}

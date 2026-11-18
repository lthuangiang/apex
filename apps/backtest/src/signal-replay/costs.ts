import {
  dec,
  Decimal,
  DRIFT_BUILDER_FEE_RATE,
  feeRateToPercent,
  SODEX_BASE_FEE_PCT,
} from "@drift/shared";

// Chi phí một lệnh replay (#274): vào và ra đều là lệnh taker, nên chịu phí taker SoDEX hai chiều + builder fee hai chiều
// (Perps thu cả hai chiều, SODEX.md mục 5.3) + một spread (nửa spread lúc vào, nửa lúc ra). Không gọi REST SoDEX: phí
// taker là `SODEX_BASE_FEE_PCT.perps.taker` (mức cơ bản đã tra trên mainnet, DEC-112), builder fee là mức trần 0.01%
// (chiến lược tín hiệu chưa có mức riêng; `builderFeeRateOf` mặc định = 10). Spread đo từ `mm_market_hourly` (số tick mỗi
// giây) khi có; không thì mặc định thận trọng theo market và gắn cờ `spread_default`.

const BP_PER_PCT = 100;
const HOUR = 3_600_000;

export const COSTS_V1 = {
  version: "costs-v1",
  /** Phí taker SoDEX mỗi chiều (bp). */
  takerBpPerLeg: dec(SODEX_BASE_FEE_PCT.perps.taker).mul(BP_PER_PCT),
  /** Builder fee mỗi chiều (bp): mức approve 10 = 1 bp. */
  builderBpPerLeg: feeRateToPercent(DRIFT_BUILDER_FEE_RATE).mul(BP_PER_PCT),
  /** Spread mặc định (bp) khi không đo được, cố ý cao hơn spread thường thấy. */
  defaultSpreadBp: { "BTC-USD": dec("3"), "ETH-USD": dec("3") } as Readonly<
    Record<string, Decimal>
  >,
  fallbackSpreadBp: dec("10"),
  /** Spread đo được trong chừng này trước lúc vào lệnh (không nhìn tương lai). */
  spreadLookbackMs: 24 * 3_600_000,
} as const;

/** Chi phí khứ hồi (bp) với một spread đã biết. */
export function roundTripCostBp(spreadBp: Decimal, costs = COSTS_V1): Decimal {
  return costs.takerBpPerLeg.mul(2).add(costs.builderBpPerLeg.mul(2)).add(spreadBp);
}

/** Spread mặc định của một market (bp). */
export function defaultSpreadBp(market: string, costs = COSTS_V1): Decimal {
  return costs.defaultSpreadBp[market] ?? costs.fallbackSpreadBp;
}

/** Trung vị có trọng số của histogram số tick `{ "1": 3400, "2": 120 }`; rỗng → null. */
export function medianTicks(hist: Readonly<Record<string, number>>): number | null {
  const entries = Object.entries(hist)
    .map(([k, n]) => [Number(k), n] as const)
    .filter(([k, n]) => Number.isFinite(k) && k > 0 && n > 0)
    .sort((a, b) => a[0] - b[0]);
  const total = entries.reduce((s, [, n]) => s + n, 0);
  if (total === 0) return null;
  let seen = 0;
  for (const [k, n] of entries) {
    seen += n;
    if (seen * 2 >= total) return k;
  }
  return null;
}

/** Cộng nhiều histogram. */
export function mergeHist(
  hists: readonly Readonly<Record<string, number>>[],
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const h of hists) for (const [k, n] of Object.entries(h)) out[k] = (out[k] ?? 0) + n;
  return out;
}

/** Spread (bp) từ số tick: ticks × tick ÷ giá × 10 000. */
export function spreadBpFromTicks(ticks: number, tick: Decimal, price: Decimal): Decimal {
  return new Decimal(ticks).mul(tick).div(price).mul(10_000);
}

/**
 * Tick size suy ra từ lưới giá của nến (không gọi REST): khoảng cách dương nhỏ nhất giữa các mức giá khác nhau. Nếu giá
 * chưa từng chạm hai mức liền nhau thì số suy ra là bội của tick thật, tức spread bị tính CAO hơn (hướng thận trọng).
 * Ít hơn 20 mức giá → null.
 */
export function inferTick(prices: readonly Decimal[]): Decimal | null {
  const uniq = [...new Set(prices.map((p) => p.toString()))].map((s) => new Decimal(s));
  if (uniq.length < 20) return null;
  uniq.sort((a, b) => a.cmp(b));
  let best: Decimal | null = null;
  for (let i = 1; i < uniq.length; i++) {
    const a = uniq[i - 1];
    const b = uniq[i];
    if (a === undefined || b === undefined) continue;
    const d = b.sub(a);
    if (d.gt(0) && (best === null || d.lt(best))) best = d;
  }
  return best;
}

export interface SpreadHour {
  hour: number;
  spreadTicks: Readonly<Record<string, number>>;
}

export interface SpreadQuote {
  spreadBp: Decimal;
  source: "mm_market_hourly" | "default";
}

/**
 * Spread lúc vào lệnh: trung vị số tick của các giờ ĐÃ TRỌN trong `spreadLookbackMs` trước `at` (bucket giờ kết thúc tại /
 * trước `at`; bucket của giờ đang chạy gồm cả các giây sau `at` nên không dùng),
 * nhân tick suy ra, chia giá vào. Không có giờ nào hoặc không suy ra được tick → mặc định.
 */
export function spreadAt(
  market: string,
  at: number,
  price: Decimal,
  hours: readonly SpreadHour[],
  tick: Decimal | null,
  costs = COSTS_V1,
): SpreadQuote {
  if (tick !== null) {
    const recent = hours.filter((h) => h.hour + HOUR <= at && h.hour > at - costs.spreadLookbackMs);
    const ticks = medianTicks(mergeHist(recent.map((h) => h.spreadTicks)));
    if (ticks !== null)
      return { spreadBp: spreadBpFromTicks(ticks, tick, price), source: "mm_market_hourly" };
  }
  return { spreadBp: defaultSpreadBp(market, costs), source: "default" };
}

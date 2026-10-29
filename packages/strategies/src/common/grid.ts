import { dec, Decimal, mul } from "@drift/shared";

import { roundPrice } from "../core/rounding";
import type { MarketRules } from "../core/types";

// Mức giá grid (STRATEGIES.md S1 bước 1): arithmetic = cách đều theo giá, geometric = cách đều theo %.
// Làm tròn theo tick; mức trùng nhau sau làm tròn bị gộp.

export function gridPrices(
  lower: string,
  upper: string,
  levels: number,
  spacing: "arithmetic" | "geometric",
  rules: MarketRules,
): string[] {
  const lo = dec(lower);
  const hi = dec(upper);
  const out: string[] = [];
  for (let i = 0; i < levels; i += 1) {
    const f = new Decimal(i).div(levels - 1);
    const raw = spacing === "arithmetic" ? lo.add(hi.sub(lo).mul(f)) : lo.mul(hi.div(lo).pow(f));
    const p = roundPrice(raw, rules);
    if (out.at(-1) !== p) out.push(p);
  }
  return out;
}

/** Bước nhỏ nhất giữa hai mức, tính theo % của mức thấp hơn. */
export function minStepFraction(prices: readonly string[]): Decimal {
  let min = new Decimal(Infinity);
  for (let i = 1; i < prices.length; i += 1) {
    const a = dec(prices[i - 1] ?? "0");
    const b = dec(prices[i] ?? "0");
    if (a.gt(0)) min = Decimal.min(min, b.sub(a).div(a));
  }
  return min;
}

/** Bước grid phải lớn hơn phí một vòng mua bán (2 × phí một chiều). */
export const stepCoversFees = (prices: readonly string[], feeRate: string): boolean =>
  minStepFraction(prices).gt(mul(feeRate, "2"));

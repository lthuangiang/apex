import { dec, Decimal, gte, RoundMode, roundToStep, type DecimalInput } from "@drift/shared";

import type { MarketRules } from "./types";

export const roundPrice = (
  price: DecimalInput,
  rules: MarketRules,
  mode: RoundMode = RoundMode.nearest,
): string => roundToStep(price, rules.tickSize, mode).toString();

export const roundQty = (qty: DecimalInput, rules: MarketRules): string =>
  roundToStep(qty, rules.stepSize, RoundMode.down).toString();

/** Lệnh hợp lệ theo min size SAU khi làm tròn (CODING_STANDARDS mục 12, Grid). */
export function meetsMinimum(price: DecimalInput, qty: DecimalInput, rules: MarketRules): boolean {
  return (
    gte(qty, rules.minQuantity) && gte(dec(price).mul(qty), rules.minNotional) && dec(qty).gt(0)
  );
}

/** Khối lượng mua được bằng `quote` ở `price`, làm tròn xuống theo lot. */
export const qtyForQuote = (quote: DecimalInput, price: DecimalInput, rules: MarketRules): string =>
  roundQty(dec(quote).div(price), rules);

export { Decimal };

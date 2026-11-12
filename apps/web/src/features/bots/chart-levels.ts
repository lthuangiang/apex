import { dec, Decimal, type Strategy } from "@drift/shared";
import { safetyOffsetPct } from "@drift/strategies";

import type { FormValues } from "./fields";
import { num } from "./preview";

// Mức của bot vẽ trên chart ở màn Create (IMPROVEMENTS IMP-05, DEC-91). Hàm thuần: chỉ đọc giá trị form
// và giá gần nhất; thiếu dữ liệu thì bỏ mức đó, không đoán (quy tắc 1.8). Dữ liệu thanh lý không đi qua đây.

/** Widget nào hiện cho chiến lược: Rebalancing không có chart; Funding Arb và bot khối lượng chỉ có Price. */
export type ChartMode = "none" | "price" | "price_and_map";

const CHART_MODE: Record<Strategy, ChartMode> = {
  spot_grid: "price_and_map",
  futures_grid: "price_and_map",
  spot_dca: "price_and_map",
  futures_dca: "price_and_map",
  recurring_buy: "price_and_map",
  twap: "price_and_map",
  rebalancing: "none",
  funding_arb: "price",
  volume_maker: "price",
  volume_farm: "price",
  adaptive_dca: "price",
  copy_trade: "price",
};

export function chartModeOf(strategy: Strategy): ChartMode {
  return CHART_MODE[strategy];
}

export interface ChartLevel {
  /** Key câu chữ trong `createBot.chart.levels`. */
  key: string;
  params?: Record<string, string>;
  price: string;
}

const level = (key: string, price: Decimal | null, params?: Record<string, string>) =>
  !price?.gt(0)
    ? []
    : [{ key, price: price.toString(), ...(params === undefined ? {} : { params }) }];

/** Mức First entry; với DCA trả thêm giá tham chiếu để tính safety, take profit, stop. */
function entryLevels(v: FormValues): ChartLevel[] {
  if (v.entry === "at_price") return level("entry", num(v.entryPrice));
  if (v.entry === "in_range")
    return [...level("entryLow", num(v.entryLow)), ...level("entryHigh", num(v.entryHigh))];
  return [];
}

function dcaLevels(strategy: Strategy, v: FormValues, last: Decimal | null): ChartLevel[] {
  const short = strategy === "futures_dca" && v.direction === "short";
  // Giá vào lệnh đầu dự kiến: At price = mức đó; In a range = cạnh vào đầu tiên (Long: high, Short: low);
  // Now = giá gần nhất.
  const ref =
    v.entry === "at_price"
      ? num(v.entryPrice)
      : v.entry === "in_range"
        ? num(short ? v.entryLow : v.entryHigh)
        : last;
  const out: ChartLevel[] =
    v.entry === "at_price" || v.entry === "in_range" ? entryLevels(v) : level("entryNow", last);
  if (!ref?.gt(0)) return out;
  const sign = short ? dec("-1") : dec("1");
  const count = Number(v.maxSafetyOrders);
  const first = num(v.firstStepPct);
  const stepMul = num(v.stepMultiplier) ?? dec("1");
  if (first !== null && Number.isInteger(count) && count > 0) {
    const cfg = { firstStepPct: first.toString(), stepMultiplier: stepMul.toString() };
    // Cùng công thức engine (`safetyOffsetPct`); quá 10 mức thì chart rối, chỉ vẽ 10 mức đầu.
    for (let k = 1; k <= Math.min(count, 10); k += 1) {
      const off = safetyOffsetPct(cfg, k);
      out.push(...level("safety", ref.mul(dec("1").sub(sign.mul(off).div(100))), { n: String(k) }));
    }
  }
  // Take profit và stop vẽ từ giá vào lệnh đầu, trước khi có safety nào khớp.
  const tp = num(v.takeProfitPct);
  if (tp !== null) out.push(...level("takeProfit", ref.mul(dec("1").add(sign.mul(tp).div(100)))));
  const sl = num(v.stopLossPct);
  if (sl !== null) out.push(...level("stop", ref.mul(dec("1").sub(sign.mul(sl).div(100)))));
  return out;
}

export function chartLevels(
  strategy: Strategy,
  v: FormValues,
  lastPrice: string | null,
): ChartLevel[] {
  const last = lastPrice === null ? null : num(lastPrice);
  switch (strategy) {
    case "spot_grid":
    case "futures_grid": {
      const futures = strategy === "futures_grid";
      return [
        ...level("upper", num(v.upperPrice)),
        ...level("lower", num(v.lowerPrice)),
        ...entryLevels(v),
        ...level("stop", num(futures ? v.stopBelow : v.stopPrice)),
        ...(futures ? level("stopAbove", num(v.stopAbove)) : []),
      ];
    }
    case "spot_dca":
    case "futures_dca":
      return dcaLevels(strategy, v, last);
    case "recurring_buy":
      return level("skipAbove", num(v.skipAbovePrice));
    case "twap":
      return level("priceLimit", num(v.priceLimit));
    case "rebalancing":
    case "funding_arb":
    case "volume_maker":
    case "volume_farm":
    case "adaptive_dca":
    case "copy_trade":
      return [];
  }
}

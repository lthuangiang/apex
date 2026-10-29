import type { FieldSpec, FormValues } from "./fields";
import { displayParts, type Market } from "./pickers";

// Bố cục form tạo/sửa bot (UI_REVIEW G2/G3, DEC-68): Market → Amount → Strategy → Risk, rồi Advanced
// settings (đóng mặc định). `group` gốc của STRATEGIES.md quyết định section khi field không đánh dấu
// `amount` / `advanced`.

export type Section = "market" | "amount" | "strategy" | "risk" | "advanced";
export const SECTIONS = ["market", "amount", "strategy", "risk"] as const;

export function sectionOf(f: Pick<FieldSpec, "advanced" | "amount" | "group">): Section {
  if (f.advanced === true) return "advanced";
  if (f.amount === true) return "amount";
  if (f.group === 2) return "market";
  if (f.group === 3) return "strategy";
  return "risk";
}

const empty = (v: FormValues[string] | undefined) =>
  v === undefined || (typeof v === "string" && v.trim() === "");

/**
 * Dòng tóm tắt khi Advanced settings đóng: nhãn các lựa chọn enum, số field tuỳ chọn chưa điền, và số
 * field cần giá trị (bắt buộc mà trống, hoặc đang có lỗi từ server).
 */
export function advancedSummary(
  fields: readonly FieldSpec[],
  values: FormValues,
  errors: Record<string, string[]>,
  optionLabel: (optionsKey: string, value: string) => string,
): { enums: string[]; optionalUnset: number; needValue: number } {
  const enums: string[] = [];
  let optionalUnset = 0;
  let needValue = 0;
  for (const f of fields) {
    const v = values[f.key];
    if ((errors[f.key]?.length ?? 0) > 0) needValue += 1;
    else if (f.type.kind === "enum") {
      const o = typeof v === "string" && v !== "" ? v : f.type.options[0];
      if (o !== undefined) enums.push(optionLabel(f.type.optionsKey, o));
    } else if (f.type.kind === "bool") continue;
    else if (empty(v)) {
      if (f.optional === true) optionalUnset += 1;
      else needValue += 1;
    }
  }
  return { enums, optionalUnset, needValue };
}

/**
 * Đơn vị quote khi chưa chọn market: Perps luôn USDC; Rebalancing theo quote asset; Spot chỉ khi mọi
 * market Spot đang giao dịch chung một quote (không đoán).
 */
export function fallbackQuote(
  strategy: string,
  values: FormValues,
  markets: readonly Market[],
): string | undefined {
  if (
    strategy === "futures_grid" ||
    strategy === "futures_dca" ||
    strategy === "volume_maker" ||
    (strategy === "twap" && values.engine === "perps")
  )
    return "USDC";
  if (strategy === "rebalancing") {
    const q = values.quoteAsset;
    return typeof q === "string" && q !== "" ? q : undefined;
  }
  const quotes = new Set(
    markets.filter((m) => m.engine === "spot" && m.trading).map((m) => displayParts(m).quote),
  );
  return quotes.size === 1 ? [...quotes][0] : undefined;
}

/**
 * Tên bot mặc định (UI_REVIEW J3, DEC-71): `<Base> <Strategy>`, ví dụ "BNB Futures Grid". Base lấy từ tên hiển
 * thị của market đã chọn (perps market đầu tiên khi có hai engine); chưa chọn market (hoặc Rebalancing nhiều
 * tài sản) thì chỉ là tên chiến lược.
 */
export function defaultBotName(
  strategyName: string,
  values: FormValues,
  markets: readonly Market[],
): string {
  const key = ["market", "perpMarket", "spotMarket"].find(
    (k) => typeof values[k] === "string" && values[k] !== "",
  );
  const m = key === undefined ? undefined : markets.find((x) => x.name === values[key]);
  return m === undefined ? strategyName : `${displayParts(m).base} ${strategyName}`;
}

import { dec, DECIMAL_STRING_PATTERN, type MarketDepth } from "@drift/shared";

// Gợi ý "Largest position" trong form tạo bot (bản phác màn 03, DEC-402 mục 5). Chỉ là gợi ý: server (#590) kiểm lại khi
// tạo và trả `VALIDATION_FAILED reason order_book_depth`. Công thức theo cùng quy tắc của server (vốn × đòn bẩy, hoặc tổng
// các lần mua của DCA), cho các chiến lược có một market cố định trong form; chiến lược khác không hiện dòng này.

export type LargestKind = "grid_perps" | "grid_spot" | "dca_perps" | "dca_spot";

const num = (c: Record<string, unknown>, k: string): string | null => {
  const v = c[k];
  const s = typeof v === "number" ? String(v) : typeof v === "string" ? v : "";
  return DECIMAL_STRING_PATTERN.test(s) ? s : null;
};

/** Tổng vị thế tối đa (USD) theo cấu hình; null khi thiếu / sai ô (chưa đủ để tính) hoặc chiến lược không áp dụng. */
export function largestPositionOf(
  strategy: string,
  config: Record<string, unknown>,
): { notional: string; kind: LargestKind } | null {
  const lev = num(config, "leverage") ?? "1";
  switch (strategy) {
    case "spot_grid": {
      const inv = num(config, "investment");
      return inv === null ? null : { notional: dec(inv).toString(), kind: "grid_spot" };
    }
    case "futures_grid": {
      const margin = num(config, "margin");
      return margin === null
        ? null
        : { notional: dec(margin).mul(lev).toString(), kind: "grid_perps" };
    }
    case "spot_dca":
    case "futures_dca": {
      const base = num(config, "baseOrder");
      const safety = num(config, "safetyOrder");
      const count = num(config, "maxSafetyOrders");
      const mult = num(config, "sizeMultiplier") ?? "1";
      if (base === null || safety === null || count === null) return null;
      let total = dec(base);
      for (let k = 1; k <= Number(count); k += 1)
        total = total.add(dec(safety).mul(dec(mult).pow(k - 1)));
      return strategy === "spot_dca"
        ? { notional: total.toString(), kind: "dca_spot" }
        : { notional: total.mul(lev).toString(), kind: "dca_perps" };
    }
    default:
      return null;
  }
}

export type DepthFit =
  | { kind: "fits"; limit: string }
  | { kind: "too_large"; limit: string }
  | { kind: "empty" }
  | { kind: "no_cap" };

/**
 * So vị thế với sổ lệnh: sổ một phía rỗng (hoặc ngừng giao dịch) → `empty`; nhãn mỏng → so với `maxPositionUsd` (phía mỏng
 * hơn); sổ đủ sâu → `no_cap`. Bằng giới hạn vẫn vừa (như server).
 */
export function depthFitOf(
  notional: string,
  bookStatus: "trading" | "empty" | "halted" | null,
  depth: MarketDepth | null,
): DepthFit | null {
  if (bookStatus === "empty" || bookStatus === "halted") return { kind: "empty" };
  if (depth === null) return null;
  if (depth.maxPositionUsd === null) return { kind: "no_cap" };
  return dec(notional).lte(depth.maxPositionUsd)
    ? { kind: "fits", limit: depth.maxPositionUsd }
    : { kind: "too_large", limit: depth.maxPositionUsd };
}

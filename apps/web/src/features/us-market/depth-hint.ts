import { dec, type MarketDepth } from "@drift/shared";

// Gợi ý "Largest position" trong form tạo bot (bản phác màn 03, DEC-402 mục 5). Chỉ là gợi ý: server (#590) kiểm lại khi
// tạo và trả `VALIDATION_FAILED reason order_book_depth`. Công thức tổng vị thế tối đa là `largestPositionOf` của
// `@drift/shared` (cùng `maxPositionsOf` mà api kiểm, #588); ở đây chỉ còn phần so với sổ lệnh của trang US Market.

export { largestPositionOf, type LargestKind } from "@drift/shared";

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

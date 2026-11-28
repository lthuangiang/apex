import { dec, ENTRY_DEPTH_SHARE } from "@drift/shared";

import { meetsMinimum, roundQty } from "../core/rounding";
import type { BookTop, MarketRules, OrderIntent } from "../core/types";

// Giới hạn theo sổ lệnh (DEC-402 mục 5, #590). Hàm thuần: engine đọc sổ lệnh 10 mức rồi gọi các hàm này.
//
// Ngưỡng, nhãn, phạm vi `DEPTH_CAP_MARKETS` và tổng vị thế tối đa nằm ở `@drift/shared` (một nguồn với trang US Market và
// form tạo bot của web, #588); xuất lại từ đây để engine và test cũ giữ nguyên chỗ import. Ở đây chỉ còn phần riêng của
// engine: trần 25% cho lệnh vào và câu Decisions.
export {
  DEFAULT_DEPTH_CAP_MARKETS,
  depthCapApplies,
  depthCapLabel,
  ENTRY_DEPTH_SHARE,
  inDepthCapScope,
  maxPositionsOf,
  parseDepthCapMarkets,
  positionDepthIssue,
  raisedPositions,
  type DepthCapLabel,
  type DepthCapScope,
  type MaxPosition,
  type PositionDepthIssue,
} from "@drift/shared";

/** Lệnh khớp ngay (market hoặc IOC). Lệnh limit GTC / GTX nằm chờ trên sổ (grid, safety DCA) không bao giờ bị cắt. */
export const isImmediateOrder = (o: Pick<OrderIntent, "type" | "timeInForce">): boolean =>
  o.type === "market" || o.timeInForce === "IOC";

/**
 * Lệnh có thể là lệnh VÀO vị thế mà quy tắc 25% xét: khớp ngay, không phải stop loss gốc, không reduce-only (Perps),
 * không phải lệnh bán Spot (Spot không mở được vị thế bán), không phải lệnh đóng engine tự dựng (`close`). Engine còn
 * loại thêm lệnh ngược chiều vị thế đang có (lệnh giảm, `opensPosition`).
 */
export function isEntryCandidate(
  o: Pick<OrderIntent, "type" | "timeInForce" | "reduceOnly" | "engine" | "side" | "tag" | "stop">,
): boolean {
  if (!isImmediateOrder(o)) return false;
  if (o.stop !== undefined) return false;
  if (o.reduceOnly) return false;
  if (o.engine === "spot" && o.side === "sell") return false;
  if (o.tag === "close" || o.tag.startsWith("close:")) return false;
  return true;
}

export type EntryCapResult =
  | { kind: "pass" }
  | {
      kind: "reduce";
      /** Khối lượng mới (đã làm tròn xuống theo lot). */
      quantity: string;
      from: string;
      /** Notional 10 mức của phía bị ăn, và mức trần (25%), USD. */
      sideNotional: string;
      capNotional: string;
    }
  | {
      kind: "wait";
      /** `empty`: phía bị ăn không có lệnh; `below_min`: trần 25% nhỏ hơn min size của SoDEX. */
      reason: "empty" | "below_min";
      sideNotional: string;
      capNotional: string;
    };

/**
 * Trần cho MỘT lệnh vào khớp ngay (DEC-402 mục 5). Gọi chỉ khi `isEntryCandidate` (và engine đã loại lệnh giảm) và market
 * có nhãn mỏng. Lệnh mua ăn phía ask, lệnh bán ăn phía bid. Notional của lệnh tính theo giá tốt nhất của phía đó (lệnh
 * market đi sâu hơn sẽ trả giá kém hơn một chút; trần vẫn tính trên notional 10 mức như nhãn).
 */
export function capEntryOrder(
  o: Pick<OrderIntent, "side" | "quantity">,
  book: BookTop | null,
  rules: MarketRules,
): EntryCapResult {
  const buy = o.side === "buy";
  const sideNotional = book === null ? dec("0") : dec(buy ? book.askNotional : book.bidNotional);
  const price = book === null ? dec("0") : dec(buy ? book.ask : book.bid);
  const cap = sideNotional.mul(ENTRY_DEPTH_SHARE);
  const sideText = sideNotional.toDecimalPlaces(2).toString();
  const capText = cap.toDecimalPlaces(2).toString();
  if (!sideNotional.gt(0) || !price.gt(0))
    return { kind: "wait", reason: "empty", sideNotional: "0", capNotional: "0" };
  if (dec(o.quantity).mul(price).lte(cap)) return { kind: "pass" };
  const qty = roundQty(cap.div(price), rules);
  if (!meetsMinimum(price, qty, rules))
    return { kind: "wait", reason: "below_min", sideNotional: sideText, capNotional: capText };
  return {
    kind: "reduce",
    quantity: qty,
    from: o.quantity,
    sideNotional: sideText,
    capNotional: capText,
  };
}

// ── Câu Decisions (câu chữ PM duyệt 2026-11-28, PR #597) ──────────────────────────────────────────────────

export const DEPTH_REDUCED_DECISION = "Order reduced";
export const DEPTH_EMPTY_DECISION = "Waiting: order book empty";
export const DEPTH_THIN_DECISION = "Waiting: order book too thin";

const sideWord = (side: "buy" | "sell") => (side === "buy" ? "ask" : "bid");

export function depthReducedWhy(
  market: string,
  side: "buy" | "sell",
  r: Extract<EntryCapResult, { kind: "reduce" }>,
): string {
  return `${market}: ${side} size cut from ${r.from} to ${r.quantity}. An order that fills at once can take at most 25% of the top 10 ${sideWord(side)} levels (${r.capNotional} of ${r.sideNotional} USD).`;
}

export function depthWaitWhy(
  market: string,
  side: "buy" | "sell",
  r: Extract<EntryCapResult, { kind: "wait" }>,
): string {
  return r.reason === "empty"
    ? `${market}: no ${sideWord(side)} orders in the order book. The bot won't open or add until there are. Closing orders still go.`
    : `${market}: 25% of the top 10 ${sideWord(side)} levels is ${r.capNotional} USD, below SoDEX's minimum order. The bot won't open or add until the book is deeper. Closing orders still go.`;
}

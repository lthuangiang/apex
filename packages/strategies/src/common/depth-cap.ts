import { dec, Decimal, Strategy } from "@drift/shared";

import { meetsMinimum, roundQty } from "../core/rounding";
import type { BookTop, MarketRules, OrderIntent } from "../core/types";
import { copyMarkets } from "../requirements";
import { VM_DEFAULTS } from "../volume-maker/schema";

// Giới hạn theo sổ lệnh (DEC-402 mục 5, #590). Hàm thuần: engine và api đọc sổ lệnh 10 mức rồi gọi các hàm này.
//
// Hằng ngưỡng và hàm phân loại ở đây trùng ý với nhãn độ sâu của trang US Market (#589, `packages/shared`). Giữ riêng ở
// đây để hai task không sửa chung file; PM nối về một chỗ sau khi cả hai merge.

/** Số mức giá mỗi phía được cộng notional (DEC-402 mục 4). */
export const DEPTH_CAP_LEVELS = 10;
/** Một phía dưới mức này (USD, notional 10 mức) thì market là `Thin`. */
export const DEPTH_CAP_THIN_USD = "10000";
/** Một phía dưới mức này thì market là `Very thin`. */
export const DEPTH_CAP_VERY_THIN_USD = "1000";
/** Lệnh khớp ngay để VÀO vị thế lấy tối đa phần này của notional 10 mức phía nó ăn. */
export const ENTRY_DEPTH_SHARE = "0.25";

export type DepthCapLabel = "deep" | "thin" | "very_thin" | "empty";

/**
 * Nhãn độ sâu của market theo sổ 10 mức. `null` = một phía không có lệnh nào (engine `orderbook()` trả null khi một
 * phía rỗng), hoặc notional một phía bằng 0.
 */
export function depthCapLabel(book: BookTop | null): DepthCapLabel {
  if (book === null) return "empty";
  const thinner = Decimal.min(dec(book.bidNotional), dec(book.askNotional));
  if (!thinner.gt(0)) return "empty";
  if (thinner.lt(DEPTH_CAP_VERY_THIN_USD)) return "very_thin";
  if (thinner.lt(DEPTH_CAP_THIN_USD)) return "thin";
  return "deep";
}

/** Giới hạn theo sổ chỉ áp cho market `Thin` / `Very thin` (và sổ rỗng); market đủ sâu giữ hành vi cũ (DEC-402 mục 5). */
export const depthCapApplies = (label: DepthCapLabel): boolean => label !== "deep";

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

// ── Câu Decisions (câu chữ mới, chờ PM duyệt: `_pendingReview`) ──────────────────────────────────────────────────

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

// ── Tổng vị thế tối đa lúc tạo / sửa bot ─────────────────────────────────────────────────────────────────────────

export interface MaxPosition {
  market: string;
  engine: "spot" | "perps";
  /** Notional tối đa (USD) bot có thể giữ trên market này theo cấu hình. */
  notional: string;
}

type Cfg = Record<string, unknown>;
const str = (c: Cfg, k: string): string => {
  const v = c[k];
  return typeof v === "string" || typeof v === "number" ? String(v) : "0";
};
const num = (c: Cfg, k: string): number => {
  const v = c[k];
  return typeof v === "number" ? v : Number(v ?? 0) || 0;
};
const market = (c: Cfg, k = "market"): string => (typeof c[k] === "string" ? c[k] : "");

/**
 * Tổng vị thế tối đa (notional USD) của bot theo từng market (DEC-402 mục 5): vốn × đòn bẩy, hoặc tổng các lần mua của
 * DCA. `price` chỉ cần cho TWAP (khối lượng tính theo base). Trả mảng rỗng khi chiến lược không có market cố định lúc tạo
 * (`news_signal`: market theo tín hiệu, engine vẫn áp trần 25% cho từng lệnh vào).
 *
 * Recurring Buy dùng một lần mua (`amountPerBuy`): các lần mua cách nhau theo ngày / tuần, không mua dồn vào một sổ.
 */
export function maxPositionsOf(strategy: string, c: Cfg, price?: string): MaxPosition[] {
  const lev = (k = "leverage") => num(c, k) || 1;
  switch (strategy) {
    case Strategy.spotGrid:
      return [{ market: market(c), engine: "spot", notional: str(c, "investment") }];
    case Strategy.futuresGrid:
      return [
        {
          market: market(c),
          engine: "perps",
          notional: dec(str(c, "margin")).mul(lev()).toString(),
        },
      ];
    case Strategy.spotDca:
    case Strategy.futuresDca: {
      let total = dec(str(c, "baseOrder"));
      for (let k = 1; k <= num(c, "maxSafetyOrders"); k += 1)
        total = total.add(dec(str(c, "safetyOrder")).mul(dec(str(c, "sizeMultiplier")).pow(k - 1)));
      return strategy === Strategy.spotDca
        ? [{ market: market(c), engine: "spot", notional: total.toString() }]
        : [{ market: market(c), engine: "perps", notional: total.mul(lev()).toString() }];
    }
    case Strategy.recurringBuy:
      return [{ market: market(c), engine: "spot", notional: str(c, "amountPerBuy") }];
    case Strategy.rebalancing: {
      const assets = Array.isArray(c.assets) ? (c.assets as Cfg[]) : [];
      return assets.flatMap((a) =>
        typeof a.market === "string"
          ? [
              {
                market: a.market,
                engine: "spot" as const,
                notional: dec(str(c, "investment")).mul(str(a, "weightPct")).div(100).toString(),
              },
            ]
          : [],
      );
    }
    case Strategy.fundingArb: {
      const leg = dec(str(c, "investment")).div(2).toString();
      return [
        { market: market(c, "spotMarket"), engine: "spot", notional: leg },
        { market: market(c, "perpMarket"), engine: "perps", notional: leg },
      ];
    }
    case Strategy.twap:
      return price === undefined
        ? []
        : [
            {
              market: market(c),
              engine: c.engine === "perps" ? "perps" : "spot",
              notional: dec(str(c, "totalSize")).mul(price).toString(),
            },
          ];
    case Strategy.volumeMaker: {
      const inv =
        c.maxInventory !== undefined && c.maxInventory !== ""
          ? dec(str(c, "maxInventory"))
          : dec(str(c, "orderSize")).mul(
              typeof c.maxOrders === "number" ? c.maxOrders : VM_DEFAULTS.maxInventoryMultiple,
            );
      return [{ market: market(c), engine: "perps", notional: inv.toString() }];
    }
    case Strategy.adaptiveDca:
      return [{ market: market(c), engine: "perps", notional: str(c, "maxExposure") }];
    case Strategy.copyTrade:
      // `maxExposure` là trần tổng; bot có thể dồn hết vào một market, nên mỗi market kiểm với cả mức này.
      return copyMarkets(c).map((m) => ({
        market: m,
        engine: "perps" as const,
        notional: str(c, "maxExposure"),
      }));
    case Strategy.volumeFarm:
      return [{ market: market(c), engine: "perps", notional: str(c, "orderSizeMaxUsd") }];
    default:
      return [];
  }
}

export type PositionDepthIssue =
  | { kind: "empty"; market: string }
  | { kind: "too_large"; market: string; limit: string; notional: string };

/**
 * So tổng vị thế tối đa với phía mỏng hơn của sổ 10 mức (DEC-402 mục 5). Market đủ sâu (cả hai phía ≥ 10.000 USD) không
 * bị kiểm. Sổ rỗng một phía → `empty`.
 */
export function positionDepthIssue(
  p: MaxPosition,
  book: BookTop | null,
): PositionDepthIssue | null {
  const label = depthCapLabel(book);
  if (!depthCapApplies(label)) return null;
  if (label === "empty" || book === null) return { kind: "empty", market: p.market };
  const thinner = Decimal.min(dec(book.bidNotional), dec(book.askNotional));
  if (dec(p.notional).lte(thinner)) return null;
  return {
    kind: "too_large",
    market: p.market,
    limit: thinner.toDecimalPlaces(0, Decimal.ROUND_DOWN).toString(),
    notional: dec(p.notional).toDecimalPlaces(2).toString(),
  };
}

/**
 * Bản sửa có làm tăng tổng vị thế tối đa ở market nào không (chỉ khi đó api kiểm lại theo sổ, DEC-402: bot đang chạy không
 * bị chặn khi sửa mà không tăng vốn). Market mới (không có ở bản cũ) tính là tăng.
 */
export function raisedPositions(
  before: readonly MaxPosition[],
  after: readonly MaxPosition[],
): MaxPosition[] {
  return after.filter((p) => {
    const old = before.find((b) => b.market === p.market && b.engine === p.engine);
    return old === undefined || dec(p.notional).gt(old.notional);
  });
}

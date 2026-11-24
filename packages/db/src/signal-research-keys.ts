import {
  dec,
  type ResearchDropReason,
  type ResearchNewsType,
  type ResearchTradeOpposite,
} from "@drift/shared";

import type { signalPaperTrades } from "./schema";

// Bảng đổi khoá nội bộ của lane tin tức → khoá API (#271, #291). Dùng chung cho tổng kết, danh sách lệnh và feed bài;
// không export ra ngoài package (index.ts không re-export file này).

const NEWS_TYPE = {
  hack_exploit: "hack",
  listing: "listing",
  delisting: "delisting",
  etf_approved: "etfApproved",
  etf_delayed_or_rejected: "etfDelayed",
  regulatory_action: "regulatorAgainst",
  favorable_ruling: "regulatorFavour",
  treasury_buy: "treasuryBuy",
  treasury_sell: "treasurySell",
  earnings_beat: "earningsBeat",
  earnings_miss: "earningsMiss",
  token_unlock: "unlock",
} as const satisfies Record<string, ResearchNewsType>;
const NEWS_TYPE_MAP: ReadonlyMap<string, ResearchNewsType> = new Map(Object.entries(NEWS_TYPE));

/** Loại tin của một lệnh / story (luôn là loại hợp lệ); khoá lạ → "hack" như bản cũ của danh sách lệnh. */
export const newsTypeOf = (c: string): ResearchNewsType => NEWS_TYPE_MAP.get(c) ?? "hack";
/** Loại tin của một bài (có thể "none" hoặc lạ) → null khi không phải loại trong danh sách. */
export const newsTypeOrNull = (c: string | null | undefined): ResearchNewsType | null =>
  c == null ? null : (NEWS_TYPE_MAP.get(c) ?? null);

/**
 * Mã lý do nội bộ (`signal_events.reason` của một event `drop`) → lý do API. `DUPLICATE` có lý do riêng từ #291 (feed
 * bài); tổng kết cũ (`drops`) vẫn không đếm nó là "bị loại". `noTaggedCurrency` không có mã nội bộ riêng: đó là
 * `NO_SODEX_MARKET` khi SoSoValue không gắn coin nào (`matched_currencies` rỗng), xem `signal-research-articles.ts`.
 */
export const DROP: ReadonlyMap<string, ResearchDropReason> = new Map<string, ResearchDropReason>([
  ["NO_SODEX_MARKET", "notOnSodex"],
  ["DUPLICATE", "duplicate"],
  ["NOT_A_SIGNAL_TYPE", "notCatalyst"],
  ["PASSING_MENTION", "notCatalyst"],
  ["CATALYST_ASSET_MISMATCH", "notCatalyst"],
  ["ASSET_NOT_IN_TEXT", "assetNotInText"],
  ["TREASURY_MAJOR_ASSET", "treasuryMajorAsset"],
  ["ETF_MAJOR_ASSET", "etfMajorAsset"],
  ["LISTING_MAJOR_ASSET", "listingMajorAsset"],
  ["PROMOTIONAL", "promotional"],
  ["NOT_UNDERSTOOD", "notUnderstood"],
  ["CLAUDE_BUDGET_REACHED", "notUnderstood"],
  ["EVENT_TOO_OLD", "eventTooOld"],
  ["STALE_NEWS", "eventTooOld"],
  ["CLASSIFIER_LATE", "sourceLate"],
  ["SOURCE_LATE", "sourceLate"],
  ["NO_SODEX_PRICE", "noPrice"],
  ["NO_BOOK_DATA", "noPrice"],
  ["NOT_ENOUGH_HISTORY", "noPrice"],
  ["TOO_THIN_TO_TRADE", "tooThin"],
  ["MOVE_TOO_SMALL_FOR_COST", "tpUnderCost"],
  ["NEWS_TRADE_ALREADY_OPEN", "alreadyOpen"],
  // #303 (DEC-331): Filter riêng từng News bot version; giới hạn / số dư → lệnh shadow (#304 thêm lý do API).
  ["NEWS_TYPE_OFF", "newsTypeOff"],
  ["ASSET_NOT_IN_VERSION", "assetNotInVersion"],
  ["LEVEL_TOO_LOW", "levelTooLow"],
  ["LIMIT_OPEN", "limitOpen"],
  ["LIMIT_DAY", "limitDay"],
  ["NO_BALANCE", "noBalance"],
  ["OPPOSITE_NEWS", "oppositeNews"],
]);

/**
 * #304: N của "Limit: N open" / "Limit: N per day" = giới hạn của version lưu trong detail của event Filter
 * (`maxOpenTrades` cho `LIMIT_OPEN`, `maxNewTradesPerDay` cho `LIMIT_DAY`). Mã khác, dòng cũ không lưu, hoặc giá trị
 * không phải số nguyên dương → null (web hiện câu không có số, không bao giờ 0).
 */
export function reasonLimitOf(code: string | null | undefined, detail: unknown): number | null {
  const key =
    code === "LIMIT_OPEN" ? "maxOpenTrades" : code === "LIMIT_DAY" ? "maxNewTradesPerDay" : null;
  if (key === null || typeof detail !== "object" || detail === null) return null;
  const v = (detail as Record<string, unknown>)[key];
  return typeof v === "number" && Number.isInteger(v) && v > 0 ? v : null;
}

/** Mã lý do bị loại TRƯỚC khi gọi Claude ở bước Understand (bài không được gửi cho Claude). */
export const PRE_CLAUDE_REASONS = [
  "STALE_NEWS",
  "CLASSIFIER_LATE",
  "CLAUDE_BUDGET_REACHED",
] as const;

/** Tin ngược chiều đầu tiên trên lệnh (#303): kết quả giả định nếu đóng lúc đó, và lệnh đã đóng vì nó hay vẫn giữ. */
export function oppositeOf(t: typeof signalPaperTrades.$inferSelect): ResearchTradeOpposite | null {
  if (
    t.oppositeAt === null ||
    t.oppositeExitPrice === null ||
    t.oppositeResultUsdc === null ||
    t.oppositeResultPct === null
  )
    return null;
  return {
    at: t.oppositeAt.toISOString(),
    storyId: t.oppositeStoryId,
    action: t.exitReason === "opposite_news" ? "closed" : "kept",
    exitPrice: dec(t.oppositeExitPrice).toFixed(),
    resultUsdc: dec(t.oppositeResultUsdc).toDecimalPlaces(6).toFixed(),
    resultPct: dec(t.oppositeResultPct).toDecimalPlaces(4).toNumber(),
  };
}

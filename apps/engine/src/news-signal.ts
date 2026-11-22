import type { NewsSignalRow, newsSignalTrades } from "@drift/db";
import { dec, NEWS_SIGNAL_LIVE_MAX_USDC } from "@drift/shared";
import type { NewsSignalInput, NewsTrade, OrderIntent } from "@drift/strategies";

// Phần thuần của engine cho bot `news_signal` mainnet (#419 engine A, DEC-360). Không I/O: engine.ts gọi các hàm này
// khi giao tín hiệu, ghi `news_signal_trades` và chặn lệnh mở trước khi gửi.

/** Sổ lệnh dùng để tính giá trần lệnh vào chỉ được cũ tối đa ngần này (PM review #435 điểm 8: đọc book mới nhất). */
export const NEWS_BOOK_MAX_AGE_MS = 1_000;
/** Đòn bẩy và margin mode cố định của bot mainnet (DEC-360 mục 6; isolated theo PM chốt). */
export const NEWS_LEVERAGE = { leverage: 1, marginMode: "isolated" } as const;

/** Khoá trong `Runner.leverageDone` của một market đã được SoDEX xác nhận 1× isolated. */
export const newsLeverageKey = (market: string): string =>
  `${market}:${String(NEWS_LEVERAGE.leverage)}:${NEWS_LEVERAGE.marginMode}`;

/** Một dòng `news_signals` → tín hiệu cho chiến lược (thời gian ms, giá chuỗi; báo giá thiếu = null, không bao giờ 0). */
export function newsSignalInput(row: NewsSignalRow): NewsSignalInput {
  const quote =
    row.quoteBid !== null && row.quoteAsk !== null && row.quoteMid !== null && row.quoteAt !== null
      ? {
          bid: dec(row.quoteBid).toString(),
          ask: dec(row.quoteAsk).toString(),
          mid: dec(row.quoteMid).toString(),
          at: row.quoteAt.getTime(),
        }
      : null;
  return {
    id: row.id,
    storyKey: row.storyKey,
    market: row.market,
    kind: row.kind === "stock" ? "stock" : "crypto",
    catalyst: row.catalyst,
    side: row.side === "short" ? "short" : "long",
    level: row.level === "high" ? "high" : row.level === "medium" ? "medium" : "low",
    firstPublishedAt: row.firstPublishedAt.getTime(),
    collectedAt: row.collectedAt.getTime(),
    decidedAt: row.decidedAt.getTime(),
    expiresAt: row.expiresAt.getTime(),
    quote,
    typicalByHoldHours: row.typicalByHoldHours,
  };
}

type TradeInsert = typeof newsSignalTrades.$inferInsert;

/** Trạng thái lệnh news của chiến lược → `news_signal_trades.status` (lệnh vào đang chạy vẫn giữ chỗ: `open`). */
const tradeStatus = (t: NewsTrade): "open" | "closing" | "closed" =>
  t.status === "closed" ? "closed" : t.status === "closing" ? "closing" : "open";

/**
 * Dòng `news_signal_trades` của một lệnh news (ghi cùng transaction với state, trước khi gửi lệnh). `at`: giờ của bước,
 * dùng cho `max_hold_off_at` khi Stop-Keep vừa tắt max hold (engine giữ giá trị cũ nếu đã có).
 */
export function newsTradeRow(
  botId: string,
  sodexAccountId: string,
  t: NewsTrade,
  at: number,
): TradeInsert {
  const filled = dec(t.filled);
  return {
    botId,
    sodexAccountId,
    signalId: t.signalId,
    seq: t.seq,
    market: t.market,
    side: t.side,
    status: tradeStatus(t),
    sizeUsdc: t.sizeUsdc,
    entryLimitPrice: t.entryLimit,
    qty: filled.toString(),
    // Không có khớp thì chưa có giá vào: null, không bao giờ 0 (quy tắc 1.8).
    entryAvgPrice: filled.gt(0) ? dec(t.filledNotional).div(filled).toString() : null,
    tpPrice: t.tp?.price ?? null,
    slPrice: t.sl?.price ?? null,
    tpslSeq: t.tpslSeq,
    maxHoldUntil: new Date(t.maxHoldUntil),
    maxHoldOffAt: t.maxHoldOff ? new Date(at) : null,
    openedAt: new Date(t.openedAt),
    closedAt: t.status === "closed" ? new Date(t.closedAt ?? t.openedAt) : null,
    closeReason: t.status === "closed" ? (t.closeReason ?? null) : null,
    // Chiến lược không giữ giá thoát trung bình: để trống ("Not provided"), không đoán.
    exitAvgPrice: null,
  };
}

/** Mã chặn một lệnh mở của bot news (lớp engine của trần DEC-360 mục 6). */
export const NEWS_CAP_EXCEEDED = "NEWS_CAP_EXCEEDED";

/**
 * Lệnh mở vị thế của bot news chỉ được là limit IOC trên Perps, có giá, và giá × khối lượng ≤ `NEWS_SIGNAL_LIVE_MAX_USDC`.
 * Trả mã chặn, hoặc null khi được gửi. Lệnh reduce-only (TP, SL, đóng) không qua kiểm tra này.
 */
export function newsOpenBlocked(o: OrderIntent): string | null {
  if (o.reduceOnly) return null;
  if (o.engine !== "perps" || o.type !== "limit" || o.timeInForce !== "IOC")
    return NEWS_CAP_EXCEEDED;
  if (o.price === undefined) return NEWS_CAP_EXCEEDED;
  const price = dec(o.price);
  const qty = dec(o.quantity);
  if (!price.gt(0) || !qty.gt(0)) return NEWS_CAP_EXCEEDED;
  return price.mul(qty).gt(NEWS_SIGNAL_LIVE_MAX_USDC) ? NEWS_CAP_EXCEEDED : null;
}

/** Một account × market chỉ một lệnh news `open` / `closing` (partial unique của migration 0059). */
export const NEWS_ACCOUNT_MARKET_UNIQUE = "news_signal_trades_account_market_open_uq";

/** Lỗi Postgres vi phạm unique (23505) của đúng `constraint`, kể cả khi bị bọc trong `cause`. */
export function isUniqueViolation(e: unknown, constraint: string): boolean {
  for (let x: unknown = e, i = 0; x !== null && typeof x === "object" && i < 5; i++) {
    const pg = x as { code?: unknown; constraint?: unknown };
    if (pg.code === "23505") return pg.constraint === constraint;
    x = (x as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Ghi tín hiệu / lệnh news cùng state không được (transaction đã hoàn tác): `delivered` = delivery của tín hiệu này đã
 * có (engine khác / lần giao trước); `market` = account × market đã có lệnh news đang mở (partial unique).
 */
export class NewsWriteConflict extends Error {
  constructor(readonly kind: "delivered" | "market") {
    super(`news signal write conflict: ${kind}`);
  }
}

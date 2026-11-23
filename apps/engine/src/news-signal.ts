import type { NewsSignalRow, newsSignalTrades } from "@drift/db";
import {
  dec,
  NEWS_SIGNAL_LEVERAGES,
  NEWS_SIGNAL_LIVE_MAX_USDC,
  NewsEntryBlock,
} from "@drift/shared";
import type { NewsSignalInput, NewsSignalState, NewsTrade, OrderIntent } from "@drift/strategies";

// Phần thuần của engine cho bot `news_signal` mainnet (#419 engine A, DEC-360). Không I/O: engine.ts gọi các hàm này
// khi giao tín hiệu, ghi `news_signal_trades` và chặn lệnh mở trước khi gửi.

/** Sổ lệnh dùng để tính giá trần lệnh vào chỉ được cũ tối đa ngần này (PM review #435 điểm 8: đọc book mới nhất). */
export const NEWS_BOOK_MAX_AGE_MS = 1_000;
/** Margin mode cố định của bot mainnet (DEC-360 mục 6; isolated theo PM chốt). */
export const NEWS_MARGIN_MODE = "isolated" as const;

/** Đòn bẩy của bot news theo config (#458: 1 / 5 / 10 / 20); bot cũ không có trường (hoặc giá trị lạ) là 1. */
export function newsLeverageOf(config: unknown): number {
  const l = (config as { leverage?: unknown } | null)?.leverage;
  return typeof l === "number" && (NEWS_SIGNAL_LEVERAGES as readonly number[]).includes(l) ? l : 1;
}

/** Khoá trong `Runner.leverageDone` của một market đã được SoDEX xác nhận ở `leverage`× isolated. */
export const newsLeverageKey = (market: string, leverage: number): string =>
  `${market}:${String(leverage)}:${NEWS_MARGIN_MODE}`;

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
  /** Đòn bẩy SoDEX đã xác nhận cho market của lệnh lúc vào (#458); null = chưa xác nhận. Chỉ ghi lúc tạo dòng. */
  leverage: number | null = null,
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
    leverage,
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

/**
 * Lệnh mở vị thế của bot news chỉ được là limit IOC trên Perps có giá dương và khối lượng dương (`NEWS_ORDER_INVALID`),
 * và giá × khối lượng ≤ `NEWS_SIGNAL_LIVE_MAX_USDC` (`NEWS_CAP_EXCEEDED`, PM chốt engine B: mã riêng cho từng lỗi). Trả mã
 * chặn, hoặc null khi được gửi. Lệnh reduce-only (TP, SL, đóng) không qua kiểm tra này.
 */
export function newsOpenBlocked(o: OrderIntent): NewsEntryBlock | null {
  if (o.reduceOnly) return null;
  if (o.engine !== "perps" || o.type !== "limit" || o.timeInForce !== "IOC")
    return NewsEntryBlock.orderInvalid;
  if (o.price === undefined) return NewsEntryBlock.orderInvalid;
  const price = dec(o.price);
  const qty = dec(o.quantity);
  if (!price.gt(0) || !qty.gt(0)) return NewsEntryBlock.orderInvalid;
  return price.mul(qty).gt(NEWS_SIGNAL_LIVE_MAX_USDC) ? NewsEntryBlock.capExceeded : null;
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
 * có (engine khác / lần giao trước); `market` = account × market đã có lệnh news đang mở (partial unique); `command` = lệnh
 * của người dùng không còn `queued` (đã chạy ở lần giao khác).
 */
export class NewsWriteConflict extends Error {
  constructor(readonly kind: "delivered" | "market" | "command") {
    super(`news signal write conflict: ${kind}`);
  }
}

/**
 * Bot `news_signal` còn việc phải quản lý: lệnh news chưa đóng, hoặc lệnh SoDEX chiến lược còn chờ kết thúc (#419 engine
 * B1). Hết thì runner của bot đã dừng được bỏ.
 */
export function newsHasOpen(state: unknown): boolean {
  const s = state as Partial<NewsSignalState> | null;
  if (s === null || typeof s !== "object") return false;
  return (
    Object.values(s.trades ?? {}).some((t) => t.status !== "closed") ||
    Object.keys(s.orders ?? {}).length > 0
  );
}

/** Market của các lệnh news chưa đóng trong state (so vị thế DEC-306 cho chính bot news, #419 B2). */
export function newsOpenMarkets(state: unknown): string[] {
  const s = state as Partial<NewsSignalState> | null;
  if (s === null || typeof s !== "object") return [];
  return [
    ...new Set(
      Object.values(s.trades ?? {})
        .filter((t) => t.status !== "closed")
        .map((t) => t.market),
    ),
  ];
}

/**
 * Lệnh của người dùng (`news_signal_commands.id`) mà lệnh SoDEX `clOrdID` thuộc về: chân TP / SL đang chờ của một lần Edit,
 * hoặc lệnh đóng của Close now. null = không thuộc lệnh nào.
 */
export function newsCommandOf(state: unknown, clOrdID: string): string | null {
  const s = state as Partial<NewsSignalState> | null;
  if (s === null || typeof s !== "object") return null;
  for (const t of Object.values(s.trades ?? {})) {
    const p = t.pending;
    if (p !== null && p.commandId !== null && (p.tp?.id === clOrdID || p.sl?.id === clOrdID))
      return p.commandId;
    if (t.close !== null && t.close.commandId !== null && t.close.id === clOrdID)
      return t.close.commandId;
  }
  return null;
}

/**
 * Câu Decisions khi bot `news_signal` áp version mới (#469, PM duyệt): lệnh đang mở giữ thiết lập lúc vào. Không còn lệnh
 * mở thì chỉ câu đầu.
 */
export function newsVersionAppliedWhy(version: number, open: number): string {
  const head = `New signals use v${String(version)}.`;
  if (open <= 0) return head;
  return open === 1
    ? `${head} 1 open trade keeps the settings it opened with.`
    : `${head} ${String(open)} open trades keep the settings they opened with.`;
}

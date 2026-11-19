import { z } from "zod";

import { dec, type Decimal } from "../money";

import type { Quote } from "./logic";
import { NEWS_RULES, type TradeDirection } from "./rules";

// Giá thoát cho lãi / lỗ chưa chốt của lệnh giấy Signal research (#308). Module Signal research của api không chạm SoDEX
// và không nghe NATS, nên watcher của scheduler (đã có bid / ask mỗi 1–2 s cho market có lệnh mở) ghi bản chụp vào Redis
// `sr:quotes`; api chỉ đọc. Long đóng theo bid, Short theo ask (giá đóng thật, như watcher). Giá cũ hơn ngưỡng fresh
// (`NEWS_RULES.bookFreshMs` cho sổ, `NEWS_RULES.lastPriceFreshMs` cho giá gần nhất ± nửa spread) → không có giá (null).
// Hàm ở đây thuần, không I/O.

export const SR_QUOTES_KEY = "sr:quotes";
/** TTL của key Redis: watcher ngừng ghi (không còn lệnh mở / mất lease) thì key tự hết; giá cũ vẫn bị bỏ theo `at`. */
export const SR_QUOTES_TTL_MS = 60_000;

const positiveDecimal = z
  .string()
  .regex(/^\d+(\.\d+)?$/)
  .refine((s) => dec(s).gt(0));

export const srQuoteSchema = z.object({
  bid: positiveDecimal,
  ask: positiveDecimal,
  source: z.enum(["book", "last_spread"]),
  /** Thời điểm (ms) của dữ liệu giá gốc, không phải lúc ghi. */
  at: z.number().int().nonnegative(),
});
export type SrQuote = z.infer<typeof srQuoteSchema>;

export const srQuotesSnapshotSchema = z.record(z.string().min(1), srQuoteSchema);
export type SrQuotesSnapshot = z.infer<typeof srQuotesSnapshotSchema>;

/** Bản chụp để watcher ghi, từ giá đã ghép; giá thiếu `at` bị bỏ (không biết tuổi thì không dùng). */
export function srQuotesSnapshot(quotes: ReadonlyMap<string, Quote>): SrQuotesSnapshot {
  const out: SrQuotesSnapshot = {};
  for (const [market, q] of quotes) {
    if (q.at === undefined) continue;
    out[market] = { bid: q.bid.toFixed(), ask: q.ask.toFixed(), source: q.source, at: q.at };
  }
  return out;
}

/** Giá trị Redis → bản chụp; thiếu, JSON hỏng hoặc sai dạng → bản chụp rỗng (không có giá nào). */
export function parseSrQuotes(raw: string | null | undefined): SrQuotesSnapshot {
  if (raw == null) return {};
  try {
    const p = srQuotesSnapshotSchema.safeParse(JSON.parse(raw));
    return p.success ? p.data : {};
  } catch {
    return {};
  }
}

/** Giá còn mới không, theo ngưỡng fresh của nguồn (dùng lại ngưỡng của `combineQuote`). */
export function srQuoteFresh(q: Pick<SrQuote, "source" | "at">, now: number): boolean {
  const maxAge = q.source === "book" ? NEWS_RULES.bookFreshMs : NEWS_RULES.lastPriceFreshMs;
  return now - q.at <= maxAge;
}

/**
 * Giá thoát nếu đóng lệnh NGAY: Long → bid, Short → ask. Không có giá, giá cũ hoặc sổ lỗi (bid ≤ 0, ask < bid) → null
 * (web hiện như lệnh mở chưa có giá, không bao giờ 0 hay giá cũ).
 */
export function exitPriceOf(
  direction: TradeDirection,
  q: SrQuote | null | undefined,
  now: number,
): Decimal | null {
  if (q == null || !srQuoteFresh(q, now)) return null;
  const bid = dec(q.bid);
  const ask = dec(q.ask);
  if (bid.lte(0) || ask.lt(bid)) return null;
  return direction === "short" ? ask : bid;
}

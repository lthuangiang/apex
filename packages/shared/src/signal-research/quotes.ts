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

/**
 * Số thập phân dương dạng chuỗi. Không gọi `dec` trong refine: zod v4 vẫn chạy refine khi regex đã fail, và `dec` ném
 * lỗi với chuỗi không phải số (làm hỏng cả bản chụp thay vì chỉ một mục).
 */
const DECIMAL_RE = /^\d+(\.\d+)?$/;
const positiveDecimal = z.string().refine((s) => DECIMAL_RE.test(s) && /[1-9]/.test(s));

export const srQuoteSchema = z.object({
  bid: positiveDecimal,
  ask: positiveDecimal,
  source: z.enum(["book", "last_spread", "rest_book"]),
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

export interface ParsedSrQuotes {
  quotes: SrQuotesSnapshot;
  /** Market có mục sai dạng: chỉ market đó không có giá, các market khác giữ nguyên. */
  invalid: string[];
  /** Cả giá trị hỏng (không parse được JSON / không phải object): không có giá nào. */
  broken: boolean;
}

/**
 * Giá trị Redis → bản chụp, parse TỪNG mục: mục sai dạng chỉ bỏ market đó (ghi vào `invalid`), các market khác vẫn có
 * giá. Chỉ khi cả giá trị không parse được hoặc không phải object mới coi như không có giá (`broken`). Thiếu key → rỗng,
 * không phải lỗi.
 */
export function parseSrQuotes(raw: string | null | undefined): ParsedSrQuotes {
  const none = (broken: boolean): ParsedSrQuotes => ({ quotes: {}, invalid: [], broken });
  if (raw == null) return none(false);
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return none(true);
  }
  if (typeof json !== "object" || json === null || Array.isArray(json)) return none(true);
  const out: ParsedSrQuotes = { quotes: {}, invalid: [], broken: false };
  for (const [market, entry] of Object.entries(json)) {
    const p = srQuoteSchema.safeParse(entry);
    if (market !== "" && p.success) out.quotes[market] = p.data;
    else out.invalid.push(market);
  }
  return out;
}

/** Giá còn mới không, theo ngưỡng fresh của nguồn (dùng lại ngưỡng của `combineQuote`). */
export function srQuoteFresh(q: Pick<SrQuote, "source" | "at">, now: number): boolean {
  // Sổ lệnh (WS hay REST) dùng ngưỡng của sổ; giá gần nhất ± spread dùng ngưỡng của giá gần nhất.
  const maxAge = q.source === "last_spread" ? NEWS_RULES.lastPriceFreshMs : NEWS_RULES.bookFreshMs;
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

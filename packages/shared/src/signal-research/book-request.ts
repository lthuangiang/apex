import { z } from "zod";

// #507 (DEC-TBD-sr-noprice): sổ lệnh REST một lần cho lane research khi thiếu sổ live hoặc thiếu mẫu spread theo giờ. Lane
// không gọi SoDEX (DEC-322): scheduler gửi NATS request, marketdata đọc `GET /perps/markets/{symbol}/orderbook` và trả giá
// mua / bán tốt nhất. Không có sổ thật (lỗi, rỗng, giá chéo) thì không có giá: lane giữ lý do bỏ như cũ.

/** Subject NATS request / reply (không khớp `md.*.book`). */
export const SR_BOOK_REQUEST_SUBJECT = "sr.book.request";
/** Thời gian chờ trả lời của lane. */
export const SR_BOOK_REQUEST_TIMEOUT_MS = 1_500;

export const srBookRequestSchema = z.object({ market: z.string().regex(/^[A-Z0-9]+-USD$/) });
export type SrBookRequest = z.infer<typeof srBookRequestSchema>;

export const srBookReplySchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    s: z.string(),
    /** Giá mua / bán tốt nhất (chuỗi thập phân như SoDEX trả). */
    b: z.string(),
    a: z.string(),
    /** Lúc marketdata nhận sổ (ms). */
    at: z.number().int().nonnegative(),
  }),
  z.object({
    ok: z.literal(false),
    /** `empty`: thiếu một phía; `unknown_market`: không phải perps đang giao dịch; `error`: SoDEX lỗi / hết hạn mức. */
    reason: z.enum(["empty", "unknown_market", "error"]),
  }),
]);
export type SrBookReply = z.infer<typeof srBookReplySchema>;

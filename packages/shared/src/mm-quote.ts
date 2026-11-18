import { z } from "zod";

// Snapshot báo giá của Market Making (`volume_maker`, #230, DEC-TBD-mm-quote-snapshot): engine ghi vào
// `bot_events.payload.quote` của các event quyết định về báo giá ("Order requests", "Smart quoting adjusted" / "Smart
// quoting back to normal", "Quotes paused on a fast move", "Quoting again after a fast move", "Closing at the best
// price", "Ask pulled" / "Bid pulled", "Position cut") để trang team "Signal Analysis › MM" (#220) phân tích sau.
// Chỉ dành cho server và trang team: KHÔNG export từ `@drift/shared` (barrel mà web import), import qua subpath
// `@drift/shared/mm-quote`; API không gửi field này cho trình duyệt.
// Số đã làm tròn để mỗi snapshot < 1 KB: bp 2 chữ số. Giá / khối lượng giữ chuỗi thập phân như mọi giá khác.

const decimal = z.string().regex(/^-?\d+(\.\d+)?$/);
const side = z.enum(["buy", "sell"]);
const ms = z.number().int().nonnegative();

/**
 * Vì sao bước này có báo giá / ghi event:
 * - `first`: báo giá đầu tiên khi có giá.
 * - `refresh`: chu kỳ thường (`refreshSeconds`).
 * - `requote`: báo giá lại sớm (sau fill, từ chối, lệnh bị rút, SoDEX xác nhận huỷ, vị thế đồng bộ lại).
 * - `book_moved`: giá tốt nhất SoDEX bỏ lại lệnh mở (DEC-248).
 * - `pulled`: giá Binance chạy qua lệnh mở, lệnh bị rút (DEC-242).
 * - `cut`: cắt vị thế bằng lệnh market (DEC-249).
 * - `fast_pause`: "Pause on fast moves" rút lệnh mở (DEC-227).
 * - `sample`: bước không báo giá (dòng "Order requests" mỗi phút): ảnh chụp lệnh đang nằm.
 */
export const MM_QUOTE_REASONS = [
  "first",
  "refresh",
  "requote",
  "book_moved",
  "pulled",
  "cut",
  "fast_pause",
  "sample",
] as const;

export const mmQuoteOrderSchema = z.object({
  id: z.string().max(64),
  side,
  /** close = lệnh giảm vị thế (reduce-only / lệnh cắt). */
  role: z.enum(["open", "close"]),
  /**
   * new = đặt trong bước này; cancel = huỷ trong bước này để báo giá lại (lệnh mở mới của phía đó chỉ được đặt sau khi
   * SoDEX xác nhận huỷ, DEC-257, nên thường nằm ở bước sau, không có dòng Decisions); live = đang nằm từ trước (giữ
   * nguyên); pulled = vừa bị rút theo giá Binance.
   */
  st: z.enum(["new", "cancel", "live", "pulled"]),
  /** null = lệnh market. */
  price: decimal.nullable(),
  size: decimal,
  /** (giá − mid SoDEX) ÷ mid × 10 000; âm = dưới mid. null khi lệnh market hoặc không có mid. */
  bp: z.number().nullable(),
  /** (giá − giá Binance quy đổi) ÷ giá Binance × 10 000; null khi không có giá Binance còn mới. */
  fairBp: z.number().nullable(),
});

export const mmQuoteSnapshotSchema = z.object({
  /** Phiên bản snapshot; đổi cấu trúc thì tăng. */
  v: z.literal(1),
  reason: z.enum(MM_QUOTE_REASONS),
  /** Phía được đặt / huỷ để báo giá lại / rút trong bước này (rỗng = không phía nào, ví dụ `sample`). */
  sides: z.array(side).max(2),
  /** Giá Binance quy đổi về SoDEX (Smart quoting, DEC-242). */
  fair: z.object({
    price: decimal.nullable(),
    /** Tuổi theo giờ Binance lúc quyết định (ms). */
    ageMs: ms.nullable(),
    /** Còn mới (≤ 1,5 s) và Smart quoting bật: lệnh mở bị kẹp theo giá này. */
    used: z.boolean(),
    /** Lề kẹp (bp) khi `used`: lệnh mở không vượt giá Binance ± lề này; null khi không kẹp. */
    clampBp: z.number().nonnegative().nullable(),
    /** Số lệnh mở bị kẹp lùi ra trong bước này. */
    clamps: z.number().int().nonnegative(),
  }),
  /** Sổ lệnh SoDEX bot đang dùng (WS bookTicker hoặc REST). */
  book: z.object({
    bid: decimal.nullable(),
    ask: decimal.nullable(),
    mid: decimal.nullable(),
    ageMs: ms.nullable(),
    /** Giá khớp gần nhất (tick) bot dùng làm mid khi không theo sổ. */
    last: decimal.nullable(),
  }),
  /** Cấu hình vị trí báo giá: theo sổ (`level`, DEC-135) hoặc theo khoảng cách bp (config cũ). */
  quote: z.object({
    level: z.number().int().nonnegative().nullable(),
    distanceBp: decimal.nullable(),
  }),
  inv: z.object({
    /** Vị thế theo sổ của bot (có dấu, âm = short). */
    position: decimal,
    /** Giá vào trung bình; null khi phẳng. */
    entry: decimal.nullable(),
    /** |vị thế| × giá (USDC, 2 chữ số). */
    notional: decimal,
    /** Max position thực dùng (USDC). */
    maxUsd: decimal,
    /** Max position tính bằng số lệnh (DEC-133); null khi config cũ dùng USDC. */
    maxOrders: z.number().int().positive().nullable(),
  }),
  smart: z.object({
    on: z.boolean(),
    /** Chữ ký điều chỉnh Smart quoting đang áp dụng (ví dụ "buy:2|sell:pull"); null = bình thường. */
    sig: z.string().max(40).nullable(),
    /** Đang tạm rút lệnh mở vì giá chạy nhanh. */
    fastPause: z.boolean(),
  }),
  /** Lệnh của bước (mới, huỷ, đang nằm, bị rút; theo thứ tự đó), tối đa 4. */
  orders: z.array(mmQuoteOrderSchema).max(4),
});

export type MmQuoteSnapshot = z.infer<typeof mmQuoteSnapshotSchema>;
export type MmQuoteOrder = z.infer<typeof mmQuoteOrderSchema>;
export type MmQuoteReason = (typeof MM_QUOTE_REASONS)[number];

/** Kích thước tối đa (byte, JSON) của một snapshot. */
export const MM_QUOTE_SNAPSHOT_MAX_BYTES = 1024;

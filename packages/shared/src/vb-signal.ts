import { z } from "zod";

// Snapshot tín hiệu của mỗi lượt vào Volume Farm / Volume Builder (#221, DEC-TBD-vb-signal-snapshot): engine ghi vào
// `bot_events.payload.signal` của event "Enter long" / "Enter short" để trang team "VB Signal Analysis" phân tích sau.
// Chỉ dành cho server và trang team: KHÔNG export từ `@drift/shared` (barrel mà web import), import qua subpath
// `@drift/shared/vb-signal`, để tên thành phần tín hiệu không lọt vào bundle trình duyệt (check:bundle). API không gửi
// field này cho trình duyệt.
// Số đã làm tròn để mỗi snapshot < 1 KB: điểm 4 chữ số, bp 1–2 chữ số. Giá giữ chuỗi thập phân như mọi giá khác.

const unit = z.number().min(0).max(1);
const decimal = z.string().regex(/^-?\d+(\.\d+)?$/);

export const vbSignalSnapshotSchema = z.object({
  /** Phiên bản snapshot; đổi cấu trúc thì tăng. */
  v: z.literal(1),
  /** Hướng của tín hiệu (trước Reverse / cân long-short). */
  direction: z.enum(["long", "short"]),
  /** Hướng bot thực sự vào. */
  side: z.enum(["long", "short"]),
  score: unit,
  confidence: unit,
  regime: z.enum(["SIDEWAY", "TREND_UP", "TREND_DOWN", "HIGH_VOLATILITY", "UNKNOWN"]),
  /** Các thành phần của điểm, mỗi cái trong [0, 1] (0.5 = trung tính). */
  components: z.object({
    candleMomentum: unit,
    wickRejection: unit,
    volumeAcceleration: unit,
    tradePressure: unit,
    orderbookImbalance: unit,
  }),
  /** Spread lúc quyết định (bp); null khi không có sổ, sổ chéo hoặc bằng giá (spread ≤ 0). */
  spreadBps: z.number().positive().nullable(),
  reason: z.string().max(200),
  /** "Reverse the signal" bật lúc vào. */
  reversed: z.boolean(),
  /** Hướng bị buộc bởi cân khối lượng long / short (DEC-80), không theo tín hiệu. */
  balanced: z.boolean(),
  /** Bối cảnh giá lúc quyết định. */
  price: z.object({
    bid: decimal.nullable(),
    ask: decimal.nullable(),
    mid: decimal.nullable(),
    /** Giá gần nhất engine gửi (đóng nến 1 phút đang chạy, `md.<market>.price`). */
    last: decimal.nullable(),
    /** Mark price: engine chưa gửi mark cho Volume Farm nên hiện luôn null (không đoán). */
    mark: decimal.nullable(),
    /** Tuổi sổ lệnh lúc quyết định (ms); null khi chưa có sổ. */
    bookAgeMs: z.number().int().nonnegative().nullable(),
    /**
     * Giá lúc quyết định so với giá đóng của nến 1 phút đã đóng gần nhất có giờ đóng ≤ lúc quyết định − k phút, tính bằng
     * bp: (giá quyết định − giá đóng) ÷ giá đóng × 10 000; dương = giá đã tăng. Giá quyết định = mid, không có thì last.
     * null khi không có nến phù hợp (thiếu nến hoặc nến cũ hơn k + 2 phút).
     */
    chg1mBps: z.number().nullable(),
    chg3mBps: z.number().nullable(),
    chg5mBps: z.number().nullable(),
  }),
  order: z.object({
    clOrdID: z.string().max(64),
    /** Giá đặt post-only; null = lệnh market. */
    price: decimal.nullable(),
    /** Khối lượng (đơn vị base). */
    size: decimal,
    /** Giá trị lệnh dự kiến (USDC). */
    usd: decimal,
    /** Thời gian giữ dự kiến (s). */
    holdSecs: z.number().int().nonnegative(),
    /** Lần thử thứ k trong lượt (`vf:<n>:in:<k>`, DEC-300 / DEC-307). */
    entryTry: z.number().int().nonnegative(),
    taker: z.boolean(),
  }),
});

export type VbSignalSnapshot = z.infer<typeof vbSignalSnapshotSchema>;

/** Kích thước tối đa (byte, JSON) của một snapshot. */
export const VB_SIGNAL_SNAPSHOT_MAX_BYTES = 1024;

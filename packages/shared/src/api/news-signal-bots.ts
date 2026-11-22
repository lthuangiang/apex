import { z } from "zod";

import { dec } from "../money";
import { decimalStringSchema } from "../schemas";
import { newsSignalConfigSchema } from "../signal-research/news-signal";

// API bot `news_signal` mainnet (#420, DEC-360, DEC-367): tạo bot từ một Signal research version, lệnh
// của bot (Mainnet trades), Close now / Edit TP/SL (ghi `news_signal_commands`, engine xử lý) và tín hiệu bot đã nhận.
// API không gọi SoDEX. Start / Pause / Resume / Stop dùng route chung `/api/v1/bots/:id/actions/*`.

/** Câu trả về khi `SIGNAL_NEWS_BOTS_ENABLED` tắt (409 `FEATURE_NOT_READY`). */
export const NEWS_BOTS_NOT_READY = "Mainnet bots are not available yet.";

const iso = z.iso.datetime({ offset: true });
const positivePrice = decimalStringSchema.refine((v) => dec(v).gt(0), "Must be above 0");

export const newsBotCreateBodySchema = z.object({
  /** Signal research version gốc (team hoặc My versions của người gọi). */
  versionId: z.uuid(),
  name: z.string().trim().min(1).max(60),
  /** Config đầy đủ: chép từ version, Markets chỉ thu hẹp, Min level chỉ nâng; size ≤ 200 USDC, đòn bẩy 1. */
  config: newsSignalConfigSchema,
});
export type NewsBotCreateBody = z.infer<typeof newsBotCreateBodySchema>;

/**
 * Sửa bot thành version mới (#469, DEC-TBD-news-version-apply): config đầy đủ; chỉ 5 field sửa được (`NEWS_EDITABLE_FIELDS`),
 * field khác phải giữ như version đang chạy. 2FA như Start.
 */
export const newsBotVersionBodySchema = z.object({
  config: newsSignalConfigSchema,
  twoFactorCode: z.string().min(6).max(11).optional(),
});
export type NewsBotVersionBody = z.infer<typeof newsBotVersionBodySchema>;

/** Field của bot news sửa được ở Edit (#469, PM chốt): Leverage, Position size, Max open trades, Markets, Min level. */
export const NEWS_EDITABLE_FIELDS = [
  "leverage",
  "sizeUsdc",
  "maxOpenTrades",
  "assets",
  "minLevel",
] as const;

/**
 * Kết quả lưu version: version mới (`pending` khi bot đang chạy / pause, engine áp rồi mới `active`; `active` ngay khi bot
 * draft / stopped) và kiểm margin isolated theo config mới (size × Max open ÷ đòn bẩy). Thiếu margin chỉ cảnh báo, không
 * chặn lưu. `available` null = không đọc được.
 */
export const newsBotVersionResultSchema = z.object({
  version: z.number().int().positive(),
  status: z.enum(["pending", "active"]),
  balance: z.object({
    ok: z.boolean(),
    available: decimalStringSchema.nullable(),
    needed: decimalStringSchema,
  }),
});
export type NewsBotVersionResult = z.infer<typeof newsBotVersionResultSchema>;

export const newsBotParamsSchema = z.object({ id: z.uuid() });
export const newsTradeParamsSchema = z.object({ id: z.uuid(), tradeId: z.uuid() });

/** Edit TP/SL: ít nhất một giá; null / thiếu = giữ nguyên. */
export const newsTpslBodySchema = z
  .object({
    tp: positivePrice.nullable().optional(),
    sl: positivePrice.nullable().optional(),
  })
  .refine((b) => (b.tp ?? null) !== null || (b.sl ?? null) !== null, {
    message: "Enter a take profit or a stop loss.",
    path: ["tp"],
  });
export type NewsTpslBody = z.infer<typeof newsTpslBodySchema>;

export const NEWS_COMMAND_STATUSES = [
  "queued",
  "applying",
  "applied",
  "rejected",
  "unknown",
] as const;

export const newsCommandSchema = z.object({
  id: z.uuid(),
  tradeId: z.uuid(),
  kind: z.enum(["edit_tpsl", "close"]),
  seq: z.number().int().positive(),
  tp: decimalStringSchema.nullable(),
  sl: decimalStringSchema.nullable(),
  /** Trạng thái lấy từ backend (quy tắc 1.6): mới tạo luôn `queued`, engine đổi tiếp. */
  status: z.enum(NEWS_COMMAND_STATUSES),
  createdAt: iso,
});
export type NewsCommand = z.infer<typeof newsCommandSchema>;

export const newsTradeSchema = z.object({
  id: z.uuid(),
  signalId: z.uuid(),
  market: z.string(),
  side: z.enum(["long", "short"]),
  status: z.enum(["open", "closing", "closed"]),
  sizeUsdc: decimalStringSchema,
  /** Đòn bẩy isolated SoDEX đã xác nhận lúc vào lệnh (#458); null = lệnh ghi trước khi có cột này. */
  leverage: z.number().int().positive().nullable(),
  qty: decimalStringSchema,
  /** null = lệnh vào chưa khớp ("Not available"). */
  entryAvgPrice: decimalStringSchema.nullable(),
  tpPrice: decimalStringSchema.nullable(),
  slPrice: decimalStringSchema.nullable(),
  /** null sau Stop "Keep open trades" (không áp max hold nữa). */
  maxHoldUntil: iso.nullable(),
  openedAt: iso,
  closedAt: iso.nullable(),
  closeReason: z.string().nullable(),
  exitAvgPrice: decimalStringSchema.nullable(),
  /** Lệnh Close now / Edit TP/SL chưa xong của trade này (queued / applying / unknown); null = không có. */
  pendingCommand: newsCommandSchema.nullable(),
});
export type NewsTrade = z.infer<typeof newsTradeSchema>;

export const newsTradesSchema = z.object({ items: z.array(newsTradeSchema) });

/** Một tín hiệu dùng chung và kết quả của nó trên bot này (null = bot chưa nhận). */
export const newsBotSignalSchema = z.object({
  id: z.uuid(),
  market: z.string(),
  catalyst: z.string(),
  side: z.enum(["long", "short"]),
  level: z.enum(["high", "medium", "low"]),
  decidedAt: iso,
  expiresAt: iso,
  outcome: z.enum(["accepted", "dropped"]).nullable(),
  reason: z.string().nullable(),
});
export const newsBotSignalsSchema = z.object({ items: z.array(newsBotSignalSchema) });
export type NewsBotSignal = z.infer<typeof newsBotSignalSchema>;

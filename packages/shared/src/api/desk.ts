import { z } from "zod";

import { decimalStringSchema, isoDateTimeSchema, uuidSchema } from "../schemas";

import { botSummarySchema } from "./bots";
import { suggestionViewSchema } from "./reco";

// AI Desk (DEC-105): Recommended → Try with fake money → Test results → Use real money; Your bots.

/** Bắt đầu thử bằng tiền giả từ một đề xuất đã lưu. Không cần 2FA: không có tiền thật. */
export const startPaperBodySchema = z.object({ suggestionId: uuidSchema });
export type StartPaperBody = z.infer<typeof startPaperBodySchema>;

export const lossLimitSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("limit"), amount: decimalStringSchema }),
  z.object({ kind: z.literal("none") }),
]);

export const paperReasonSchema = z.discriminatedUnion("key", [
  z.object({ key: z.literal("noFills") }),
  z.object({ key: z.literal("stopped") }),
  z.object({ key: z.literal("feeShareOfProfit"), pct: z.string() }),
  z.object({ key: z.literal("feeShareOfLoss"), pct: z.string() }),
  z.object({ key: z.literal("limitUsed"), pct: z.string() }),
  z.object({ key: z.literal("fills"), count: z.number().int() }),
]);

export const paperActivitySchema = z.object({
  at: isoDateTimeSchema,
  kind: z.enum(["fill", "event"]),
  side: z.enum(["buy", "sell"]).nullable(),
  market: z.string().nullable(),
  price: decimalStringSchema.nullable(),
  size: decimalStringSchema.nullable(),
  decision: z.string().nullable(),
  why: z.string().nullable(),
});

/** Trang Fake-money test và Test results. Mọi số là số mô phỏng ("Simulated"). */
export const paperViewSchema = z.object({
  bot: botSummarySchema,
  suggestionId: uuidSchema.nullable(),
  startedAt: isoDateTimeSchema,
  day: z.number().int(),
  capital: decimalStringSchema,
  /** Số dư giả = tiền giả + coin giả × giá hiện tại; null khi thiếu giá. */
  equity: decimalStringSchema.nullable(),
  net: decimalStringSchema.nullable(),
  fees: decimalStringSchema,
  funding: decimalStringSchema,
  fills: z.number().int(),
  maxDrawdown: decimalStringSchema,
  lossLimit: lossLimitSchema,
  stoppedByLossLimit: z.boolean(),
  verdict: z.enum(["loss_limit", "too_early", "lost", "made"]),
  minDays: z.number().int(),
  hold: z.object({
    asset: z.string(),
    amount: decimalStringSchema.nullable(),
    changePct: decimalStringSchema.nullable(),
  }),
  reasons: z.array(paperReasonSchema),
  /**
   * Số dư giả theo thời gian: vốn ban đầu, cuối mỗi giờ (2 ngày đầu) hoặc mỗi ngày (UTC), rồi số dư lúc này.
   */
  daily: z.array(z.object({ date: z.string(), equity: decimalStringSchema })),
  activity: z.array(paperActivitySchema),
});
export type PaperView = z.infer<typeof paperViewSchema>;

export const deskNoteSchema = z.object({
  kind: z.enum(["fees", "attention", "fine"]),
  fills: z.number().int(),
  fees: decimalStringSchema.nullable(),
  net: decimalStringSchema.nullable(),
  quote: z.string(),
  since: isoDateTimeSchema.nullable(),
});

export const deskBotsViewSchema = z.object({
  notes: z.array(z.object({ bot: botSummarySchema, note: deskNoteSchema })),
  paper: z.array(
    z.object({ bot: botSummarySchema, day: z.number().int(), net: decimalStringSchema.nullable() }),
  ),
});
export type DeskBotsView = z.infer<typeof deskBotsViewSchema>;

/** Use real money: cấu hình tính lại bằng `aiParameters()` với giá hiện tại, so với cấu hình đã thử. */
export const goLiveViewSchema = z.object({
  paperBotId: uuidSchema,
  strategy: z.string(),
  market: z.string(),
  name: z.string(),
  capital: decimalStringSchema,
  paperConfig: z.record(z.string(), z.unknown()),
  /** null khi không tính lại được (thiếu dữ liệu thị trường): khách sửa trong form. */
  live: suggestionViewSchema.nullable(),
  changes: z.array(
    z.object({ key: z.string(), from: z.string().nullable(), to: z.string().nullable() }),
  ),
});
export type GoLiveView = z.infer<typeof goLiveViewSchema>;

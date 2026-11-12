import { z } from "zod";

import { DESK_AI_FACT_KEYS } from "../desk/ai/facts";
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

/* AI Desk B+ (DEC-164, DEC-166): việc "Needs you" và sức khoẻ bot. Câu chữ ở messages của web. */
export const deskFactSchema = z.object({
  id: z.string(),
  name: z.string(),
  value: z.string(),
  unit: z.enum(["usdc", "pct", "x", "count", "per_million", "text", "ms"]),
  source: z.enum(["config", "sodex_symbol", "bot_state", "fills", "review", "estimate"]),
});
export const needsYouItemSchema = z.object({
  id: uuidSchema,
  botId: uuidSchema,
  botName: z.string(),
  strategy: z.string(),
  market: z.string(),
  rule: z.enum(["liquidation_before_stop", "max_loss_hit", "taker_costly", "better_review"]),
  severity: z.number().int(),
  facts: z.array(deskFactSchema),
});
export const needsYouViewSchema = z.object({
  checkedAt: isoDateTimeSchema,
  items: z.array(needsYouItemSchema),
  bots: z.array(
    z.object({
      botId: uuidSchema,
      name: z.string(),
      strategy: z.string(),
      market: z.string(),
      state: z.string(),
      health: z.enum(["healthy", "watch", "needs_you"]),
    }),
  ),
});
export type NeedsYouView = z.infer<typeof needsYouViewSchema>;
export const snoozeViewSchema = z.object({
  id: uuidSchema,
  rule: z.enum(["liquidation_before_stop", "max_loss_hit", "taker_costly", "better_review"]),
  snoozedUntil: isoDateTimeSchema,
});

/* AI Desk B+ M2 (DEC-166): so sánh phương án và Apply. Kết quả là 7 ngày đã qua, không phải dự báo. */
export const whatIfOutcomeSchema = z.object({
  trades: z.number().int(),
  net: decimalStringSchema,
  /** Lượt đóng bởi stop loss gốc trên SoDEX; null khi nguồn không đếm được. Không gồm thanh lý (chưa mô phỏng). */
  closedBySodex: z.number().int().nullable(),
  worstTrade: decimalStringSchema.nullable(),
  marginPerTrade: decimalStringSchema.nullable(),
});
export const whatIfOptionViewSchema = z.object({
  key: z.enum(["keep", "lower_leverage", "tighter_stop", "review_settings"]),
  patch: z.record(z.string(), z.union([z.string(), z.number(), z.null()])),
  outcome: whatIfOutcomeSchema.nullable(),
  unavailable: z.enum(["invalid_config", "not_enough_trades", "no_data"]).nullable(),
  /** Đòn bẩy và khoảng stop (% giá) của cấu hình sau patch, để ghi phương án bằng lời; null khi không tính được. */
  display: z
    .object({ leverage: z.number().nullable(), stopPct: decimalStringSchema.nullable() })
    .nullable(),
});
export const whatIfViewSchema = z.object({
  id: uuidSchema,
  itemId: uuidSchema,
  botId: uuidSchema,
  bot: z.object({ name: z.string(), strategy: z.string(), market: z.string(), state: z.string() }),
  rule: z.enum(["liquidation_before_stop", "max_loss_hit", "taker_costly", "better_review"]),
  status: z.enum(["queued", "running", "done", "failed", "unavailable"]),
  /** `replay`: "Replayed on your real trades"; `backtest`: "Backtest on 5-minute candles". */
  source: z.enum(["replay", "backtest"]).nullable(),
  windowFrom: isoDateTimeSchema,
  windowTo: isoDateTimeSchema,
  botVersion: z.number().int(),
  options: z.array(whatIfOptionViewSchema),
  pick: z
    .object({
      key: z.enum(["keep", "lower_leverage", "tighter_stop", "review_settings"]).nullable(),
      reason: z.enum(["safer_best_result", "better_result", "keep_is_better", "not_enough_trades"]),
    })
    .nullable(),
  /** Lý do khi `unavailable` / `failed` (ví dụ `version_changed`, `history_short`, `no_fix`). */
  error: z.string().nullable(),
});
export type WhatIfView = z.infer<typeof whatIfViewSchema>;
export const whatIfApplyBodySchema = z.object({
  option: z.enum(["lower_leverage", "tighter_stop", "review_settings"]),
});
export const whatIfApplyViewSchema = z.object({
  botId: uuidSchema,
  version: z.number().int(),
  /** `pending` khi bot đang chạy (engine áp: "Applying vN…"), `active` khi bot đã dừng / nháp. */
  status: z.enum(["pending", "active"]),
  option: z.enum(["lower_leverage", "tighter_stop", "review_settings"]),
});

/* AI Desk B+ M3 (DEC-166): trang chủ = việc "Needs you" kèm what-if mới nhất của việc đó + sức khoẻ bot. */
export const deskHomeItemSchema = needsYouItemSchema.extend({
  /** So sánh mới nhất cho đúng việc + version bot; null khi chưa có (web xếp so sánh). */
  whatif: whatIfViewSchema.nullable(),
});
export const deskHomeViewSchema = needsYouViewSchema.extend({
  items: z.array(deskHomeItemSchema),
  /** Thẻ Mục tiêu; null khi chưa lưu goals (chỉ hiện "Change goal"). `used` null = "Not available". */
  goal: z
    .object({
      goal: z.enum(["automate", "range", "accumulate", "steady"]),
      limit: decimalStringSchema,
      used: decimalStringSchema.nullable(),
    })
    .nullable(),
});
export type DeskHomeView = z.infer<typeof deskHomeViewSchema>;

/* AI Desk B+ M4 (DEC-166): thành tích, đo 7 ngày sau mỗi Apply. Kết quả là 7 ngày đã qua, không phải dự báo. */
export const deskRecordRowSchema = z.object({
  id: uuidSchema,
  botId: uuidSchema,
  botName: z.string(),
  rule: z.enum(["liquidation_before_stop", "max_loss_hit", "taker_costly", "better_review"]),
  option: z.enum(["lower_leverage", "tighter_stop", "review_settings"]),
  changes: z.array(
    z.object({ key: z.string(), from: z.string().nullable(), to: z.string().nullable() }),
  ),
  appliedAt: isoDateTimeSchema,
  /** Ngày có kết quả (7 ngày sau khi version được áp). */
  dueAt: isoDateTimeSchema,
  checkedAt: isoDateTimeSchema.nullable(),
  /** `measuring` gồm cả lúc job đang chạy; `unavailable` = không đo được (ví dụ ít lượt), không hiện 0. */
  status: z.enum(["measuring", "done", "unavailable"]),
  verdict: z.enum(["helped", "made_worse", "no_clear_effect"]).nullable(),
  /** Lãi / lỗ sau khi sửa và của cấu hình cũ trên cùng các ngày (USDC); null khi chưa đo. */
  after: decimalStringSchema.nullable(),
  old: decimalStringSchema.nullable(),
  source: z.enum(["replay", "backtest"]).nullable(),
  error: z.string().nullable(),
  /** Switch back: chỉ với "Made it worse" và khi bot vẫn ở version AI đã tạo. */
  canSwitchBack: z.boolean(),
  switchedBackVersion: z.number().int().nullable(),
});
export const deskRecordViewSchema = z.object({
  counts: z.object({
    helped: z.number().int(),
    madeWorse: z.number().int(),
    noClearEffect: z.number().int(),
    measuring: z.number().int(),
  }),
  rows: z.array(deskRecordRowSchema),
});
export type DeskRecordView = z.infer<typeof deskRecordViewSchema>;
export const switchBackViewSchema = z.object({
  botId: uuidSchema,
  version: z.number().int(),
  status: z.enum(["pending", "active"]),
});
/** `desk_applies.record` (jsonb) do worker ghi. */
export const deskRecordResultSchema = z.object({
  source: z.enum(["replay", "backtest"]),
  after: decimalStringSchema,
  old: decimalStringSchema,
  trades: z.number().int().nullable(),
  from: isoDateTimeSchema,
  to: isoDateTimeSchema,
});
export type DeskRecordResult = z.infer<typeof deskRecordResultSchema>;

/* AI Desk B+ M5 (DEC-164, DEC-165): Desk AI. Câu trả lời là lời LLM đã qua kiểm tra số, hoặc câu mẫu (web dịch). */
export const deskAiFactSchema = z.object({
  id: z.string(),
  key: z.enum(DESK_AI_FACT_KEYS),
  bot: z.string().nullable(),
  value: z.string(),
  unit: z.enum(["usdc", "pct", "x", "count", "text"]),
  source: z.string(),
});
export const deskAiTemplateKeys = [
  "out_of_scope",
  "quota",
  "safety",
  "fallback",
  "loss",
  "brief",
] as const;
export const deskAiAnswerSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text"), text: z.string(), facts: z.array(deskAiFactSchema) }),
  z.object({
    kind: z.literal("template"),
    key: z.enum(deskAiTemplateKeys),
    params: z.record(z.string(), z.union([z.string(), z.number()])),
    facts: z.array(deskAiFactSchema),
  }),
]);
export type DeskAiAnswer = z.infer<typeof deskAiAnswerSchema>;
export const deskAiTurnSchema = z.object({
  id: uuidSchema,
  kind: z.enum(["question", "brief"]),
  question: z.string().nullable(),
  answer: deskAiAnswerSchema,
  createdAt: isoDateTimeSchema,
});
/** ✦ "Ask about this" (M6): ngữ cảnh của câu hỏi. Server tự đọc dữ liệu, client chỉ gửi id. */
export const deskAiContextSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("bot"), botId: uuidSchema }),
  z.object({ kind: z.literal("decision"), botId: uuidSchema, eventId: uuidSchema }),
  z.object({ kind: z.literal("portfolio") }),
]);
export type DeskAiContext = z.infer<typeof deskAiContextSchema>;
export const deskAiAskBodySchema = z.object({
  question: z.string().trim().min(1).max(500),
  conversationId: uuidSchema.optional(),
  context: deskAiContextSchema.optional(),
});
export const deskAiAskViewSchema = z.object({
  conversationId: uuidSchema,
  turn: deskAiTurnSchema,
  questionsLeft: z.number().int(),
});
export type DeskAiAskView = z.infer<typeof deskAiAskViewSchema>;
export const deskAiBriefViewSchema = z.object({
  /** false trước 08:00 giờ địa phương (chưa có báo cáo hôm nay). */
  available: z.boolean(),
  conversationId: uuidSchema.nullable(),
  turn: deskAiTurnSchema.nullable(),
  questionsLeft: z.number().int(),
  /** false khi LLM tắt (không có key): mọi câu trả lời là câu mẫu. */
  llm: z.boolean(),
});
export type DeskAiBriefView = z.infer<typeof deskAiBriefViewSchema>;
export const deskAiHistoryViewSchema = z.object({
  questionsToday: z.number().int(),
  limit: z.number().int(),
  conversations: z.array(
    z.object({
      id: uuidSchema,
      kind: z.enum(["chat", "brief"]),
      title: z.string(),
      localDate: z.string(),
      createdAt: isoDateTimeSchema,
      turns: z.array(deskAiTurnSchema),
    }),
  ),
});
export type DeskAiHistoryView = z.infer<typeof deskAiHistoryViewSchema>;

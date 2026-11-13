import { z } from "zod";

import { decimalStringSchema, isoDateTimeSchema, uuidSchema } from "../schemas";

import { portfolioViewSchema, riskViewSchema } from "./account";
import { botDetailSchema, botSummarySchema, botVersionSchema } from "./bots";
import {
  traderAddressSchema,
  traderListQuerySchema,
  traderListSchema,
  traderProfileSchema,
} from "./copy";
import {
  deskHomeItemSchema,
  deskHomeViewSchema,
  deskRecordRowSchema,
  deskRecordViewSchema,
  whatIfViewSchema,
} from "./desk";

// Output của tool MCP nội bộ (docs/MCP.md mục 5A, DEC-167, DEC-219). api trả, apps/mcp parse lại bằng
// zod trước khi đưa cho client. Không bao giờ chứa key, secret, chữ ký hay payload đã ký. Thiếu dữ liệu → null kèm
// lý do, không bao giờ 0. Chữ do người dùng nhập (tên bot) bọc trong `userText` để client biết không phải lệnh.

/** Tối đa mỗi trang (docs/MCP.md mục 6). */
export const MCP_PAGE_MAX = 50;

/** Chữ do người dùng nhập: client MCP phải coi là dữ liệu, không phải chỉ dẫn. */
export const userTextSchema = z.object({ userText: z.string() });

const meta = { asOf: isoDateTimeSchema, source: z.string() };

export const teamFindUserInputSchema = z.object({
  /** Email, user id, hoặc 4 ký tự cuối địa chỉ ví. */
  query: z.string().trim().min(4).max(320),
});

export const teamUserSchema = z.object({
  id: uuidSchema,
  email: z.string(),
  role: z.enum(["user", "team"]),
  createdAt: isoDateTimeSchema,
  flags: z.object({ aiDesk: z.boolean(), volumeBots: z.boolean(), adaptiveDca: z.boolean() }),
  twoFactor: z.boolean(),
  sodex: z
    .object({
      address: z.string(),
      accountId: z.string(),
      network: z.string(),
      status: z.enum(["connecting", "connected", "disconnected"]),
    })
    .nullable(),
  /** Lý do khi `sodex` null. */
  sodexReason: z.literal("not_connected").nullable(),
});
export type TeamUser = z.infer<typeof teamUserSchema>;

export const teamFindUserSchema = z.object({
  ...meta,
  matchedBy: z.enum(["id", "email", "wallet_tail"]),
  users: z.array(teamUserSchema).max(20),
});
export type TeamFindUser = z.infer<typeof teamFindUserSchema>;

const rangeInput = {
  from: isoDateTimeSchema.optional(),
  to: isoDateTimeSchema.optional(),
};

export const teamConnectAttemptsInputSchema = z
  .object({
    userId: uuidSchema.optional(),
    attemptId: uuidSchema.optional(),
    ...rangeInput,
    limit: z.coerce.number().int().min(1).max(MCP_PAGE_MAX).default(10),
  })
  .refine((v) => v.userId !== undefined || v.attemptId !== undefined, {
    message: "userId or attemptId is required.",
  });

export const teamConnectAttemptsSchema = z.object({
  ...meta,
  attempts: z.array(
    z.object({
      attemptId: uuidSchema,
      userId: uuidSchema,
      startedAt: isoDateTimeSchema,
      lastAt: isoDateTimeSchema,
      /** `connected`, hoặc bước lỗi cuối cùng (`wallet_failed`, `sign_rejected`…), hoặc `abandoned`. */
      outcome: z.string(),
      /** Lấy từ `data.device` của bước đầu; không có → null. */
      device: z.string().nullable(),
      steps: z.array(
        z.object({
          type: z.string(),
          at: isoDateTimeSchema,
          data: z.record(z.string(), z.unknown()),
        }),
      ),
    }),
  ),
  /** Lỗi SoDEX gần nhất của các yêu cầu ký (không có chữ ký hay payload). */
  signatureRequests: z.array(
    z.object({
      action: z.string(),
      status: z.string(),
      sodexError: z.string().nullable(),
      at: isoDateTimeSchema,
    }),
  ),
});
export type TeamConnectAttempts = z.infer<typeof teamConnectAttemptsSchema>;

export const teamUserBotsInputSchema = z.object({ userId: uuidSchema });

export const teamUserBotsSchema = z.object({
  ...meta,
  userId: uuidSchema,
  bots: z.array(
    z.object({
      id: uuidSchema,
      name: userTextSchema,
      strategy: z.string(),
      market: z.string(),
      mode: z.enum(["live", "paper"]),
      state: z.string(),
      reasonCode: z.string().nullable(),
      needsAttention: z.boolean(),
      archived: z.boolean(),
      /** Số version đang chạy; null khi bot chưa có version active. */
      version: z.number().int().nullable(),
      lastError: z
        .object({
          at: isoDateTimeSchema,
          clOrdId: z.string(),
          status: z.string(),
          rejectCode: z.string().nullable(),
          rejectMessage: z.string().nullable(),
        })
        .nullable(),
      updatedAt: isoDateTimeSchema,
    }),
  ),
});
export type TeamUserBots = z.infer<typeof teamUserBotsSchema>;

export const teamBotTimelineInputSchema = z.object({
  botId: uuidSchema,
  ...rangeInput,
  /** `occurredAt` của mục cuối trang trước. */
  cursor: isoDateTimeSchema.optional(),
  limit: z.coerce.number().int().min(1).max(MCP_PAGE_MAX).default(30),
});

const orderView = z.object({
  id: uuidSchema,
  clOrdId: z.string(),
  market: z.string(),
  side: z.enum(["buy", "sell"]),
  type: z.string(),
  price: decimalStringSchema.nullable(),
  size: decimalStringSchema,
  filledSize: decimalStringSchema,
  avgPrice: decimalStringSchema.nullable(),
  status: z.string(),
  reduceOnly: z.boolean(),
  tag: z.string(),
  rejectCode: z.string().nullable(),
  rejectMessage: z.string().nullable(),
  submittedAt: isoDateTimeSchema.nullable(),
  reconciledAt: isoDateTimeSchema.nullable(),
});

export const teamBotTimelineSchema = z.object({
  ...meta,
  bot: z.object({
    id: uuidSchema,
    userId: uuidSchema,
    name: userTextSchema,
    strategy: z.string(),
    market: z.string(),
    mode: z.enum(["live", "paper"]),
    state: z.string(),
    reasonCode: z.string().nullable(),
  }),
  items: z.array(
    z.discriminatedUnion("kind", [
      z.object({
        kind: z.literal("event"),
        at: isoDateTimeSchema,
        type: z.string(),
        decision: z.string().nullable(),
        why: z.string().nullable(),
        result: z.string().nullable(),
      }),
      z.object({ kind: z.literal("order"), at: isoDateTimeSchema, order: orderView }),
    ]),
  ),
  nextCursor: isoDateTimeSchema.nullable(),
});
export type TeamBotTimeline = z.infer<typeof teamBotTimelineSchema>;

export const teamUnknownOrdersInputSchema = z.object({
  userId: uuidSchema.optional(),
  cursor: isoDateTimeSchema.optional(),
  limit: z.coerce.number().int().min(1).max(MCP_PAGE_MAX).default(30),
});

export const teamUnknownOrdersSchema = z.object({
  ...meta,
  orders: z.array(
    z.object({
      userId: uuidSchema,
      botId: uuidSchema,
      botName: userTextSchema,
      ageSeconds: z.number().int(),
      /** Chưa đối soát lần nào → `pending`; đã thử đối soát mà vẫn `unknown` → `retrying`. */
      reconcile: z.enum(["pending", "retrying"]),
      order: orderView,
      createdAt: isoDateTimeSchema,
    }),
  ),
  nextCursor: isoDateTimeSchema.nullable(),
});
export type TeamUnknownOrders = z.infer<typeof teamUnknownOrdersSchema>;

const dateSchema = z.iso.date();

export const teamBuilderRevenueInputSchema = z.object({
  from: dateSchema,
  to: dateSchema,
});

/** Tối đa số ngày mỗi lần đọc doanh thu builder. */
export const MCP_REVENUE_MAX_DAYS = 92;

export const teamBuilderRevenueSchema = z.object({
  ...meta,
  from: dateSchema,
  to: dateSchema,
  days: z.array(
    z.object({
      date: dateSchema,
      engine: z.enum(["spot", "perps"]),
      fromFills: decimalStringSchema,
      fills: z.number().int(),
      notional: decimalStringSchema,
      balanceDelta: decimalStringSchema.nullable(),
      difference: decimalStringSchema.nullable(),
      /** Lý do khi `balanceDelta` / `difference` null. */
      reason: z.literal("balance_not_reconciled").nullable(),
      status: z.enum(["matched", "pending"]),
    }),
  ),
  /** Ngày trong khoảng chưa có dòng nào (job chưa chạy): liệt kê, không điền 0. */
  missingDates: z.array(dateSchema),
});
export type TeamBuilderRevenue = z.infer<typeof teamBuilderRevenueSchema>;

// ---------- B1: tool đọc cho người dùng (DEC-TBD-mcp-user-tools) ----------
// Lấy đúng service mà màn hình đang dùng (Overview, Risk, Strategy Lab, Trading Agent, Copy Trading) để số khớp nhau.
// Chỉ dữ liệu của chính người gọi (lọc theo userId của token). Tiền thật và tiền giả (paper) tách riêng, paper không
// cộng vào tiền thật (quy tắc 1.2).

export const mcpBotSummarySchema = botSummarySchema
  .omit({ name: true })
  .extend({ name: userTextSchema });
export type McpBotSummary = z.infer<typeof mcpBotSummarySchema>;

export const MCP_PERIODS = ["1", "7", "30", "all"] as const;
export const mcpPortfolioInputSchema = z.object({ period: z.enum(MCP_PERIODS).default("30") });

export const mcpPortfolioSummarySchema = z.object({
  ...meta,
  period: z.enum(MCP_PERIODS),
  realMoney: z.object({
    /** null khi chưa kết nối SoDEX hoặc SoDEX không trả lời (xem `reason`). */
    portfolio: portfolioViewSchema.nullable(),
    reason: z.enum(["sodex_not_connected"]).nullable(),
    /** Lãi / lỗ đã chốt của bot tiền thật trong kỳ; null khi chưa có dữ liệu. */
    realizedPnl: decimalStringSchema.nullable(),
    realizedSince: isoDateTimeSchema,
    bots: z.array(mcpBotSummarySchema),
  }),
  paper: z.object({
    note: z.string(),
    bots: z.array(mcpBotSummarySchema),
  }),
});
export type McpPortfolioSummary = z.infer<typeof mcpPortfolioSummarySchema>;

export const mcpRiskStatusSchema = z.object({
  ...meta,
  risk: riskViewSchema.nullable(),
  reason: z.enum(["sodex_not_connected"]).nullable(),
});
export type McpRiskStatus = z.infer<typeof mcpRiskStatusSchema>;

export const mcpListBotsInputSchema = z.object({
  archived: z.enum(["true", "false"]).default("false"),
});
export const mcpListBotsSchema = z.object({ ...meta, bots: z.array(mcpBotSummarySchema) });
export type McpListBots = z.infer<typeof mcpListBotsSchema>;

export const mcpGetBotSchema = z.object({
  ...meta,
  bot: mcpBotSummarySchema,
  /** Cấu hình version đang chạy; null khi bot chưa có version active (xem `configReason`). */
  activeConfig: botVersionSchema
    .pick({ version: true, config: true, paramSource: true, appliedAt: true })
    .nullable(),
  configReason: z.enum(["no_active_version"]).nullable(),
  /** Version đang chờ áp dụng (sửa chưa Apply); null khi không có. */
  pendingVersion: z.number().int().nullable(),
  openOrders: z.number().int(),
  runningSince: isoDateTimeSchema.nullable(),
  volumeMaker: botDetailSchema.shape.volumeMaker,
  volumeFarm: botDetailSchema.shape.volumeFarm,
  adaptiveDca: botDetailSchema.shape.adaptiveDca,
});
export type McpGetBot = z.infer<typeof mcpGetBotSchema>;

export const mcpBotDecisionsInputSchema = teamBotTimelineInputSchema;
/** Cùng dạng timeline của team; `bot.userId` luôn là người gọi. */
export const mcpBotDecisionsSchema = teamBotTimelineSchema;
export type McpBotDecisions = TeamBotTimeline;

/** Thẻ trader: bỏ đường cong (nặng), tên hiển thị của Hyperliquid là chữ người khác đặt → `userText`. */
const mcpTraderCardSchema = traderListSchema.shape.items.element
  .omit({ displayName: true, curve: true })
  .extend({ displayName: userTextSchema.nullable() });

export const mcpFindTradersInputSchema = traderListQuerySchema;
export const mcpFindTradersSchema = z.object({
  ...meta,
  traders: traderListSchema
    .omit({ items: true })
    .extend({ items: z.array(mcpTraderCardSchema) })
    .nullable(),
  reason: z.enum(["copy_trading_not_enabled"]).nullable(),
});
export type McpFindTraders = z.infer<typeof mcpFindTradersSchema>;

export const mcpGetTraderInputSchema = z.object({ address: traderAddressSchema });
export const mcpGetTraderSchema = z.object({
  ...meta,
  trader: traderProfileSchema.omit({ card: true }).extend({ card: mcpTraderCardSchema }).nullable(),
  reason: z.enum(["copy_trading_not_enabled"]).nullable(),
});
export type McpGetTrader = z.infer<typeof mcpGetTraderSchema>;

// ---------- B2: tool AI Desk (DEC-TBD-mcp-desk-tools) ----------
// Lấy đúng service của màn AI Desk (`deskHome`, `whatifView`, `recordView`). Kết quả so sánh / thành tích là 7 ngày đã
// qua, **không phải dự báo**: mỗi output mang câu `notForecast` cố định. AI Desk tắt → null + lý do.

/** Câu cố định trong output what-if và thành tích (PM: phải giữ "not a forecast"). */
export const MCP_NOT_FORECAST =
  "Replayed on the past 7 days. This is not a forecast and does not predict future profit." as const;

const deskGateReason = z.enum(["ai_desk_not_enabled"]).nullable();

export const mcpWhatIfSchema = whatIfViewSchema.omit({ bot: true }).extend({
  bot: whatIfViewSchema.shape.bot.omit({ name: true }).extend({ name: userTextSchema }),
});

export const mcpNeedsYouSchema = z.object({
  ...meta,
  notForecast: z.literal(MCP_NOT_FORECAST),
  needsYou: deskHomeViewSchema
    .omit({ items: true, bots: true })
    .extend({
      items: z.array(
        deskHomeItemSchema
          .omit({ botName: true, whatif: true })
          .extend({ botName: userTextSchema, whatif: mcpWhatIfSchema.nullable() }),
      ),
      bots: z.array(
        deskHomeViewSchema.shape.bots.element.omit({ name: true }).extend({ name: userTextSchema }),
      ),
    })
    .nullable(),
  reason: deskGateReason,
});
export type McpNeedsYou = z.infer<typeof mcpNeedsYouSchema>;

export const mcpGetWhatIfInputSchema = z.object({ whatifId: uuidSchema });
export const mcpGetWhatIfSchema = z.object({
  ...meta,
  notForecast: z.literal(MCP_NOT_FORECAST),
  whatif: mcpWhatIfSchema.nullable(),
  reason: deskGateReason,
});
export type McpGetWhatIf = z.infer<typeof mcpGetWhatIfSchema>;

export const mcpTrackRecordSchema = z.object({
  ...meta,
  notForecast: z.literal(MCP_NOT_FORECAST),
  record: deskRecordViewSchema
    .omit({ rows: true })
    .extend({
      rows: z.array(
        deskRecordRowSchema.omit({ botName: true }).extend({ botName: userTextSchema }),
      ),
    })
    .nullable(),
  reason: deskGateReason,
});
export type McpTrackRecord = z.infer<typeof mcpTrackRecordSchema>;

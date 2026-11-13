import { z } from "zod";

import { decimalStringSchema, isoDateTimeSchema, uuidSchema } from "../schemas";

// Output của tool MCP nội bộ (docs/MCP.md mục 5A, DEC-167, DEC-TBD-mcp-team-tools). api trả, apps/mcp parse lại bằng
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
      /** Lấy từ `data.device` / `data.mobile` của bước đầu; không có → null. */
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

import { z } from "zod";

import { BotState, ReasonCode, Strategy } from "../enums";
import { decimalStringSchema, isoDateTimeSchema, uuidSchema } from "../schemas";

// API bot (SCREENS.md mục 8.2–8.4, CODING_STANDARDS C7). `config` được api parse bằng zod schema của
// chiến lược trong packages/strategies; ở đây chỉ là object.

export const LAUNCHED_STRATEGIES = [
  Strategy.spotGrid,
  Strategy.futuresGrid,
  Strategy.spotDca,
  Strategy.futuresDca,
  Strategy.recurringBuy,
  Strategy.rebalancing,
  Strategy.fundingArb,
  Strategy.twap,
] as const;

/** Volume Maker chỉ được tạo khi `VOLUME_MAKER_ENABLED` bật (VOLUME_MAKER.md mục 17.5); api kiểm tra cờ. */
export const BOT_STRATEGIES = [...LAUNCHED_STRATEGIES, Strategy.volumeMaker] as const;

export const featuresSchema = z.object({ volumeMaker: z.boolean() });

export const createBotBodySchema = z.object({
  strategy: z.enum(BOT_STRATEGIES),
  name: z.string().min(1).max(80),
  config: z.record(z.string(), z.unknown()),
  paramSource: z.enum(["ai", "ai_edited", "manual"]),
  aiSuggestionId: uuidSchema.optional(),
});
export type CreateBotBody = z.infer<typeof createBotBodySchema>;

export const botVersionSchema = z.object({
  id: uuidSchema,
  version: z.number().int(),
  config: z.record(z.string(), z.unknown()),
  paramSource: z.enum(["ai", "ai_edited", "manual"]),
  status: z.enum(["pending", "active", "superseded", "rejected"]),
  createdAt: isoDateTimeSchema,
  appliedAt: isoDateTimeSchema.nullable(),
});

export const botSummarySchema = z.object({
  id: uuidSchema,
  name: z.string(),
  strategy: z.enum(Strategy),
  market: z.string(),
  engine: z.enum(["spot", "perps", "spot+perps"]),
  state: z.enum(BotState),
  reasonCode: z.enum(ReasonCode).nullable(),
  needsAttention: z.boolean(),
  activeVersion: z.number().int().nullable(),
  /** Lãi ròng đã chốt + chưa chốt theo sổ cái của engine; null khi chưa có dữ liệu. */
  netPnl: decimalStringSchema.nullable(),
  /** Vốn theo cấu hình mới nhất (`requirementOf`: investment, margin, tổng tối đa của DCA…), đơn vị quote; null khi không áp dụng. */
  capital: decimalStringSchema.nullable().default(null),
  /** Số lệnh đã khớp (filled / partially_filled); 0 thì UI hiện "No fills yet" thay cho Profit (UI_REVIEW J1). */
  fills: z.number().int().nonnegative().default(0),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type BotSummary = z.infer<typeof botSummarySchema>;
export const botListSchema = z.object({ items: z.array(botSummarySchema) });

export const botEventSchema = z.object({
  id: uuidSchema,
  type: z.string(),
  decision: z.string().nullable(),
  why: z.string().nullable(),
  result: z.string().nullable(),
  occurredAt: isoDateTimeSchema,
});

export const orderViewSchema = z.object({
  id: uuidSchema,
  botId: uuidSchema,
  clOrdId: z.string(),
  market: z.string(),
  side: z.enum(["buy", "sell"]),
  type: z.enum(["limit", "market"]),
  price: decimalStringSchema.nullable(),
  size: decimalStringSchema,
  filledSize: decimalStringSchema,
  status: z.enum([
    "open",
    "partially_filled",
    "filled",
    "cancelled",
    "rejected",
    "unknown",
    "not_placed",
  ]),
  rejectCode: z.string().nullable(),
  submittedAt: isoDateTimeSchema.nullable(),
});
export type OrderView = z.infer<typeof orderViewSchema>;
export const orderListSchema = z.object({ items: z.array(orderViewSchema) });

export const botDetailSchema = z.object({
  bot: botSummarySchema,
  versions: z.array(botVersionSchema),
  events: z.array(botEventSchema),
  openOrders: z.number().int().nonnegative(),
  /** Chỉ số theo dõi của Volume Maker (VOLUME_MAKER.md mục 17.6); null với chiến lược khác hoặc chưa chạy. */
  volumeMaker: z
    .object({
      volume: decimalStringSchema,
      volumeTarget: decimalStringSchema,
      cost: decimalStringSchema,
      costBudget: decimalStringSchema,
      costPerMillion: decimalStringSchema.nullable(),
      makerSharePct: decimalStringSchema.nullable(),
      inventory: decimalStringSchema,
      selfTradeBlocked: z.number().int(),
    })
    .nullable()
    .default(null),
});
export type BotDetail = z.infer<typeof botDetailSchema>;

/** Hành động trạng thái: start / stop cần 2FA (CODING_STANDARDS C12). */
export const botActionBodySchema = z.object({
  twoFactorCode: z.string().min(6).max(11).optional(),
  /** Start: người dùng đã tick checkbox xác nhận. */
  acknowledged: z.boolean().optional(),
});

export const newVersionBodySchema = z.object({
  config: z.record(z.string(), z.unknown()),
  paramSource: z.enum(["ai", "ai_edited", "manual"]),
  aiSuggestionId: uuidSchema.optional(),
});

/** "Before it starts" (SCREENS.md mục 8.2): server tính, UI chỉ hiển thị. */
export const CheckKey = {
  apiKey: "api_key",
  builderFee: "builder_fee",
  balance: "balance",
  minSize: "min_size",
  twoFactor: "two_factor",
  riskLimits: "risk_limits",
  freshPrice: "fresh_price",
  /** Bot Perps: đòn bẩy / margin mode của symbol trên SoDEX (DEC-58). Chỉ có ở bot đặt đòn bẩy. */
  leverageConflict: "leverage_conflict",
} as const;
export type CheckKey = (typeof CheckKey)[keyof typeof CheckKey];

export const startCheckSchema = z.object({
  key: z.enum(CheckKey),
  ok: z.boolean(),
  /** Số liệu đi kèm (ví dụ số dư khả dụng); null khi không có. */
  detail: z.string().nullable(),
  /**
   * Số liệu để UI nói rõ con số (UI_REVIEW H2): `min_size` → smallest / required / capitalField /
   * suggestedCapital; `balance` → available / needed. Chỉ giá trị backend tính được; thiếu thì không có key.
   */
  data: z.record(z.string(), z.string().nullable()).optional(),
});
export const startChecksSchema = z.object({
  checks: z.array(startCheckSchema),
  allOk: z.boolean(),
});
export type StartChecks = z.infer<typeof startChecksSchema>;

/** Dry run "Before it starts" cho form chưa lưu (UI_REVIEW H2): không ghi DB. */
export const dryRunChecksBodySchema = z.object({
  strategy: z.enum(BOT_STRATEGIES),
  config: z.record(z.string(), z.unknown()),
});

/**
 * Market của SoDEX. `displayName` do SoDEX trả (`BTC/USDC`, `BTC-USD`); `base` / `quote` là mã coin SoDEX
 * (`vBTC`, `vUSDC`). Mọi market (kể cả HALT) để đổi tên hiển thị; ô chọn market chỉ dùng `TRADING`.
 */
export const marketListSchema = z.object({
  items: z.array(
    z.object({
      name: z.string(),
      engine: z.enum(["spot", "perps"]),
      displayName: z.string(),
      base: z.string().nullable(),
      quote: z.string().nullable(),
      tickSize: decimalStringSchema,
      stepSize: decimalStringSchema,
      trading: z.boolean(),
      /** Giá trị lệnh tối thiểu (quote) theo SoDEX. */
      minNotional: decimalStringSchema,
      /** Chỉ perps; null với spot. */
      maxLeverage: z.number().int().positive().nullable(),
      /** Giá gần nhất (`md:last:*`); null khi marketdata chưa có. */
      last: decimalStringSchema.nullable(),
    }),
  ),
});
export type MarketList = z.infer<typeof marketListSchema>;

/** Giá gần nhất của một market (marketdata, Redis `md:last:*`); null khi chưa có hoặc đã hết hạn. */
export const marketLastSchema = z.object({
  market: z.string(),
  price: decimalStringSchema.nullable(),
  /** ms UTC của nến cung cấp giá. */
  at: z.number().int().nullable(),
});
export type MarketLast = z.infer<typeof marketLastSchema>;

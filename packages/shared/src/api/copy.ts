import { z } from "zod";

import { HIDDEN_REASONS, TRADER_TABS } from "../leader-stats";
import { Decimal, dec } from "../money";
import { decimalStringSchema, isoDateTimeSchema } from "../schemas";

// Copy Trading v1 (DEC-163, STRATEGIES.md S12.1, SCREENS.md 8.x). Số trên thẻ trader là lịch sử từ fill thật
// ("Past results, not a forecast."); thiếu dữ liệu là null, không bao giờ 0 (quy tắc 1.8).

export const traderAddressSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/)
  .transform((v) => v.toLowerCase());

export const COPY_SLOT = ["open", "full", "copied"] as const;
export type CopySlot = (typeof COPY_SLOT)[number];

/** Nhãn trên thẻ trader (câu chữ ở messages của web). */
export const TRADER_TAGS = [
  "easy_to_copy",
  "holds_hours",
  "holds_days",
  "fast_trader",
  "all_on_sodex",
  "partly_on_sodex",
  "history_incomplete",
  "liquidated",
] as const;

export const traderStatsViewSchema = z.object({
  profit: decimalStringSchema,
  worstDip: decimalStringSchema,
  typicalHoldMs: z.number().int().nullable(),
  winRate: decimalStringSchema.nullable(),
  wins: z.number().int(),
  closedTrades: z.number().int(),
  topTradeShare: decimalStringSchema.nullable(),
  coverage: decimalStringSchema.nullable(),
  liquidations: z.number().int(),
  markets: z.array(z.string()),
  unlistedCoins: z.array(z.string()),
  historyIncomplete: z.boolean(),
  fills: z.number().int(),
});
export type TraderStatsView = z.infer<typeof traderStatsViewSchema>;

export const traderCardSchema = z.object({
  address: z.string(),
  displayName: z.string().nullable(),
  stats: traderStatsViewSchema,
  /** Lợi nhuận cộng dồn theo ngày cho sparkline: `[ms đầu ngày, USD]`. */
  curve: z.array(z.tuple([z.number().int(), decimalStringSchema])),
  tags: z.array(z.enum(TRADER_TAGS)),
  slot: z.enum(COPY_SLOT),
  following: z.boolean(),
});
export type TraderCard = z.infer<typeof traderCardSchema>;

export const traderListQuerySchema = z.object({ tab: z.enum(TRADER_TABS).default("steady") });

export const traderListSchema = z.object({
  tab: z.enum(TRADER_TABS),
  /** Ngày của lần tính leaderboard thành công gần nhất (UTC); null = chưa có lần nào. */
  updatedOn: z.string().nullable(),
  /** Số ứng viên đã xét và số bị ẩn theo lý do (một trader có thể có nhiều lý do). */
  candidates: z.number().int(),
  hidden: z.number().int(),
  hiddenBy: z.record(z.enum(HIDDEN_REASONS), z.number().int()),
  items: z.array(traderCardSchema),
  /**
   * Chưa có lượt nào xong mà lượt đầu đang chạy (DEC-171): danh sách là các ví đã tính xong của lượt
   * đó, `done` / `total` là tiến độ. null khi danh sách lấy từ lượt đã xong.
   */
  checking: z.object({ done: z.number().int(), total: z.number().int() }).nullable(),
});
export type TraderList = z.infer<typeof traderListSchema>;

export const LEADER_EVENT_KIND = ["open", "add", "reduce", "close", "flip", "liquidated"] as const;

export const leaderEventViewSchema = z.object({
  address: z.string(),
  coin: z.string(),
  /** Market SoDEX; null = SoDEX không có ("Not listed"). */
  market: z.string().nullable(),
  kind: z.enum(LEADER_EVENT_KIND),
  /** Chiều của vị thế sau sự kiện; đóng hết thì là chiều của vị thế vừa đóng. */
  side: z.enum(["long", "short"]).nullable(),
  positionAfter: decimalStringSchema,
  /** Notional thay đổi (USD, dương). */
  notional: decimalStringSchema,
  /** Notional vị thế sau sự kiện (USD) theo giá của sự kiện. */
  positionNotional: decimalStringSchema,
  price: decimalStringSchema,
  /** PnL đã chốt trừ phí của lần đóng / giảm (USD); null với mở / tăng. */
  realized: decimalStringSchema.nullable(),
  at: isoDateTimeSchema,
  /** Độ trễ DeskLabs thấy sự kiện (ms); null khi sự kiện đến từ lượt tính đêm. */
  seenAfterMs: z.number().int().nullable(),
});
export type LeaderEventView = z.infer<typeof leaderEventViewSchema>;

/** Mục checklist "Is this trader a good fit to copy?" (câu chữ ở messages của web). */
export const FIT_ITEMS = [
  "holds_long",
  "holds_short",
  "all_listed",
  "some_unlisted",
  "spread_profit",
  "concentrated_profit",
  "no_liquidations",
  "liquidations",
] as const;

export const traderProfileSchema = z.object({
  card: traderCardSchema,
  hidden: z.array(z.enum(HIDDEN_REASONS)),
  updatedOn: z.string().nullable(),
  computedAt: isoDateTimeSchema,
  fit: z.array(
    z.object({ item: z.enum(FIT_ITEMS), ok: z.boolean(), data: z.record(z.string(), z.string()) }),
  ),
  events: z.array(leaderEventViewSchema),
  /** Lệnh trader đang mở lúc này (sẽ không được copy). */
  openPositions: z.array(
    z.object({ market: z.string().nullable(), coin: z.string(), side: z.enum(["long", "short"]) }),
  ),
  copyable: z.object({
    ok: z.boolean(),
    reason: z.enum(["min_hold", "no_stats", "no_markets"]).nullable(),
  }),
  /** Mức cảnh báo khi đang follow trader này; null = chưa follow (DEC-TBD-follow-alerts). */
  followAlertLevel: z.enum(["big_moves", "positions", "off"]).nullable().optional(),
});
export type TraderProfile = z.infer<typeof traderProfileSchema>;

/**
 * Mức cảnh báo cho mỗi trader đang follow (DEC-TBD-follow-alerts): chỉ big move (mặc định); vị thế mới, đóng hẳn,
 * đảo chiều (kèm big move); hoặc tắt. Chỉ market SoDEX có; tối đa 1 tin / trader / market / 10 phút.
 */
export const FOLLOW_ALERT_LEVELS = ["big_moves", "positions", "off"] as const;
export type FollowAlertLevel = (typeof FOLLOW_ALERT_LEVELS)[number];
export const followAlertBodySchema = z.object({ level: z.enum(FOLLOW_ALERT_LEVELS) });
/** Sự kiện vị thế được báo ở mức `positions`: bỏ add / reduce. */
export const POSITION_ALERT_KINDS = ["open", "close", "flip", "liquidated"] as const;
export const FOLLOW_ALERT_GAP_MS = 10 * 60_000;

export const FOLLOW_LIMIT = 5;
/** Ví theo dõi tối đa toàn hệ thống (poll 2 phút, DEC-163 mục 10). */
export const FOLLOW_SYSTEM_LIMIT = 40;
export const FOLLOW_POLL_MS = 120_000;

export const followingSchema = z.object({
  limit: z.number().int(),
  checkedEveryMs: z.number().int(),
  traders: z.array(
    z.object({
      address: z.string(),
      displayName: z.string().nullable(),
      lastEventAt: isoDateTimeSchema.nullable(),
      copying: z.boolean(),
      /** Market mới trader giao dịch mà bot copy chưa theo (không tự thêm, DEC-163 mục 6). */
      newMarkets: z.array(z.string()),
      /** Mức cảnh báo của trader này (DEC-TBD-follow-alerts); thiếu = `big_moves` (api cũ). */
      alertLevel: z.enum(["big_moves", "positions", "off"]).default("big_moves"),
    }),
  ),
  events: z.array(leaderEventViewSchema),
  bigMoveAlerts: z.boolean(),
  /** Ngưỡng USD của big move (`COPY_BIG_MOVE_MIN_USD`); null = cảnh báo tắt. */
  bigMoveMinUsd: z.string().nullable().default(null),
});
export type Following = z.infer<typeof followingSchema>;

/* -------------------------------- Budget and safety → field S12 (S12.1) -------------------------------- */

export const COPY_PRESETS = {
  careful: { leverage: 1, share: "0.25", stopLossPct: "5", loss: "0.10" },
  balanced: { leverage: 2, share: "0.25", stopLossPct: "10", loss: "0.20" },
  bold: { leverage: 3, share: "0.4", stopLossPct: "15", loss: "0.30" },
} as const;
export type CopyPreset = keyof typeof COPY_PRESETS;
export const COPY_PRESET_KEYS = ["careful", "balanced", "bold"] as const;

export const copyRequestSchema = z.object({
  address: traderAddressSchema,
  budget: decimalStringSchema.refine((v) => dec(v).gt(0), { message: "Must be more than 0." }),
  preset: z.enum(COPY_PRESET_KEYS).default("balanced"),
  direction: z.enum(["follow", "inverse"]).default("follow"),
  maxSlippagePct: decimalStringSchema.optional(),
  marginMode: z.enum(["isolated", "cross"]).default("isolated"),
  takeProfitPct: decimalStringSchema.optional(),
});
export type CopyRequest = z.infer<typeof copyRequestSchema>;

/** Field S12 theo bảng S12.1 (`sizing = fixed`). Server tính, không tin client. */
export function presetFields(
  budget: string,
  preset: CopyPreset,
): {
  leverage: number;
  sizing: "fixed";
  fixedNotional: string;
  maxNotionalPerTrade: string;
  maxExposure: string;
  stopLossPct: string;
  maxLoss: string;
} {
  const p = COPY_PRESETS[preset];
  const exposure = dec(budget).mul(p.leverage);
  const perTrade = exposure.mul(p.share).toDecimalPlaces(2, Decimal.ROUND_DOWN);
  return {
    leverage: p.leverage,
    sizing: "fixed",
    fixedNotional: perTrade.toString(),
    maxNotionalPerTrade: perTrade.toString(),
    maxExposure: exposure.toDecimalPlaces(2, Decimal.ROUND_DOWN).toString(),
    stopLossPct: p.stopLossPct,
    maxLoss: dec(budget).mul(p.loss).toDecimalPlaces(2, Decimal.ROUND_DOWN).toString(),
  };
}

export const COPY_DROP_REASONS = ["bot", "unavailable", "leverage", "min_size"] as const;

export const copyPreviewSchema = z.object({
  address: z.string(),
  config: z.record(z.string(), z.unknown()),
  markets: z.array(z.string()),
  dropped: z.array(
    z.object({
      market: z.string(),
      reason: z.enum(COPY_DROP_REASONS),
      botId: z.string().nullable(),
      botName: z.string().nullable(),
    }),
  ),
  slot: z.enum(COPY_SLOT),
  copyable: z.object({
    ok: z.boolean(),
    reason: z.enum(["min_hold", "no_stats", "no_markets"]).nullable(),
  }),
  builderFeeMax: z.string(),
  available: decimalStringSchema.nullable(),
});
export type CopyPreview = z.infer<typeof copyPreviewSchema>;

export const copyStartSchema = copyRequestSchema.extend({
  acknowledged: z.literal(true),
  twoFactorCode: z.string().min(6).max(11).optional(),
});

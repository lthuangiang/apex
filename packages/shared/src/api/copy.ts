import { z } from "zod";

import { liquidationDistance, type MarginTier } from "../desk/needs-you";
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
  "recent_unlisted",
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
  /** Mức cảnh báo khi đang follow trader này; null = chưa follow (DEC-209). */
  followAlertLevel: z.enum(["big_moves", "positions", "off"]).nullable().optional(),
});
export type TraderProfile = z.infer<typeof traderProfileSchema>;

/**
 * Mức cảnh báo cho mỗi trader đang follow (DEC-209): chỉ big move (mặc định); vị thế mới, đóng hẳn,
 * đảo chiều (kèm big move); hoặc tắt. Chỉ market SoDEX có; tối đa 1 tin / trader / market / 10 phút.
 */
export const FOLLOW_ALERT_LEVELS = ["big_moves", "positions", "off"] as const;
export type FollowAlertLevel = (typeof FOLLOW_ALERT_LEVELS)[number];
export const followAlertBodySchema = z.object({ level: z.enum(FOLLOW_ALERT_LEVELS) });
/** Sự kiện vị thế được báo ở mức `positions`: bỏ add / reduce. */
export const POSITION_ALERT_KINDS = ["open", "close", "flip", "liquidated"] as const;
export const FOLLOW_ALERT_GAP_MS = 10 * 60_000;

/**
 * Cảnh báo của bot copy (DEC-212, W2b). `copy_bot_opened`: một lệnh mở / tăng / đảo chiều đã khớp
 * (mỗi lệnh một tin, khoá chống trùng theo clOrdID). `copy_bot_skipped`: chiến lược bỏ qua một tín hiệu, lý do lấy
 * từ câu log có sẵn; tối đa 1 tin / bot / market / `FOLLOW_ALERT_GAP_MS`. Không bao giờ có địa chỉ ví hay số dư.
 */
export const COPY_OPEN_MOVES = ["opened", "added", "flipped"] as const;
export type CopyOpenMove = (typeof COPY_OPEN_MOVES)[number];
export const COPY_SKIP_REASONS = [
  "signal_late",
  "signal_too_old",
  "price_moved",
  "below_minimum",
  "rejected",
  "no_fill",
  "min_hold",
  "low_liquidity",
  // Trader giao dịch ở market không có trong bot (bỏ tick lúc tạo, hoặc market mới): chỉ ghi nhật ký, không gửi tin
  // (DEC-226).
  "market_off",
  "other",
] as const;
export type CopySkipReason = (typeof COPY_SKIP_REASONS)[number];
export const copyBotOpenedDataSchema = z.object({
  botId: z.string(),
  clOrdID: z.string(),
  market: z.string(),
  move: z.enum(COPY_OPEN_MOVES),
  side: z.enum(["long", "short"]),
  /** Khối lượng đã khớp của lệnh (base). */
  size: z.string(),
  /** Giá vào trung bình của vị thế sau khi khớp. */
  avgEntry: z.string(),
  at: z.number(),
});
export type CopyBotOpenedData = z.infer<typeof copyBotOpenedDataSchema>;
export const copyBotSkippedDataSchema = z.object({
  botId: z.string(),
  /** Null khi không biết tín hiệu thuộc market nào (ví dụ bước theo nhịp đồng hồ của bot nhiều market). */
  market: z.string().nullable(),
  reason: z.enum(COPY_SKIP_REASONS),
  /** Câu log gốc của chiến lược (tiếng Anh). */
  why: z.string(),
  at: z.number(),
});
export type CopyBotSkippedData = z.infer<typeof copyBotSkippedDataSchema>;

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
      /** Mức cảnh báo của trader này (DEC-209); thiếu = `big_moves` (api cũ). */
      alertLevel: z.enum(["big_moves", "positions", "off"]).default("big_moves"),
    }),
  ),
  events: z.array(leaderEventViewSchema),
  bigMoveAlerts: z.boolean(),
  /** Ngưỡng USD của big move (`COPY_BIG_MOVE_MIN_USD`); null = cảnh báo tắt. */
  bigMoveMinUsd: z.string().nullable().default(null),
});
export type Following = z.infer<typeof followingSchema>;

/**
 * Bảng "Recent changes" ở Following, theo trang (W4): tối đa `FOLLOWING_EVENTS_PAGE` dòng một lần, mới nhất trước,
 * lọc theo một trader đang follow nếu có. `cursor` là chuỗi mờ do server trả (`nextCursor`); null = hết.
 */
export const FOLLOWING_EVENTS_PAGE = 50;
export const followingEventsQuerySchema = z.object({
  trader: traderAddressSchema.optional(),
  cursor: z
    .string()
    .regex(/^\d{1,15}\.[0-9a-f-]{36}$/)
    .optional(),
});
export const followingEventsSchema = z.object({
  events: z.array(leaderEventViewSchema),
  nextCursor: z.string().nullable(),
});
export type FollowingEvents = z.infer<typeof followingEventsSchema>;

/* -------------------------------- Budget and safety → field S12 (S12.1) -------------------------------- */

export const COPY_PRESETS = {
  careful: { leverage: 1, share: "0.25", stopLossPct: "5", loss: "0.10" },
  balanced: { leverage: 2, share: "0.25", stopLossPct: "10", loss: "0.20" },
  bold: { leverage: 3, share: "0.4", stopLossPct: "15", loss: "0.30" },
} as const;
export type CopyPreset = keyof typeof COPY_PRESETS;
export const COPY_PRESET_KEYS = ["careful", "balanced", "bold"] as const;

/** Trần đòn bẩy mỗi market khi người dùng tự đặt (CopyMarkets.md quy tắc 3). */
export const COPY_MAX_LEVERAGE = 5;

export const copyRequestSchema = z.object({
  address: traderAddressSchema,
  /** Tập con market của trader người dùng tick (DEC-226); thiếu = mọi market copy được. */
  markets: z.array(z.string().min(1).max(40)).min(1).max(20).optional(),
  /** "Set per market": đòn bẩy từng market; thiếu = theo mức an toàn (hạ về trần ở market cho thấp hơn). */
  leverageByMarket: z
    .record(z.string().min(1).max(40), z.number().int().min(1).max(COPY_MAX_LEVERAGE))
    .optional(),
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

/** Một market ứng viên khi tính kế hoạch copy. `maxLeverage` là của SoDEX; `tiers` là bậc margin (thiếu → null). */
export interface CopyCandidate {
  market: string;
  maxLeverage: number;
  tiers: readonly MarginTier[] | null;
  /** Episode đã đóng của trader ở market này trong 30 ngày; null = chưa có dữ liệu ("Not available"). */
  trades30d: number | null;
}

export interface CopyPlanRow {
  market: string;
  selected: boolean;
  /** Đòn bẩy sẽ đặt trên SoDEX. */
  leverage: number;
  /** Trần đã áp: min(SoDEX max, 5, trần đòn bẩy ở Risk Center). */
  maxLeverage: number;
  /** Ký quỹ mỗi vị thế = cỡ mỗi lệnh copy ÷ đòn bẩy (USD). */
  marginPerPosition: string;
  /** Khoảng giá tới thanh lý ước tính (%, chiều xấu hơn của long / short); null khi cross hoặc thiếu bậc margin. */
  liquidationPct: string | null;
  trades30d: number | null;
}

/**
 * Kế hoạch copy từ budget + mức an toàn + market đã chọn + đòn bẩy từng market (DEC-226). Hàm thuần:
 * api tính để tạo config, web tính lại để hiện ngay khi người dùng bấm.
 * - Đòn bẩy mỗi market: per-market thì giá trị người dùng (kẹp trong [1, trần]); không thì đòn bẩy preset hạ về trần.
 * - Cỡ mỗi lệnh copy không đổi theo đòn bẩy (budget × đòn bẩy preset × share), nhưng không vượt trần tổng.
 * - Trần tổng = budget × đòn bẩy THẤP NHẤT trong các market đã chọn, để ký quỹ không bao giờ vượt budget (PM chốt 1B).
 */
export function copyPlan(input: {
  budget: string;
  preset: CopyPreset;
  candidates: readonly CopyCandidate[];
  /** Market đã chọn; thiếu = tất cả. */
  selected?: readonly string[] | undefined;
  leverageByMarket?: Readonly<Record<string, number>> | undefined;
  /** Trần đòn bẩy người dùng đặt ở Risk Center; null = không đặt. */
  riskCap: number | null;
  marginMode: "isolated" | "cross";
}): {
  rows: CopyPlanRow[];
  fields: ReturnType<typeof presetFields>;
  /** Đòn bẩy thấp nhất trong các market đã chọn; null khi chưa chọn market nào. */
  lowestLeverage: number | null;
  /** Có market dùng đòn bẩy khác preset (per-market, hoặc bị hạ về trần). */
  mixed: boolean;
  leverageByMarket: Record<string, number>;
} {
  const base = presetFields(input.budget, input.preset);
  const p = COPY_PRESETS[input.preset];
  const chosen = new Set(input.selected ?? input.candidates.map((c) => c.market));
  const per = input.leverageByMarket;
  const lev: Record<string, number> = {};
  const caps: Record<string, number> = {};
  for (const c of input.candidates) {
    const cap = Math.max(
      1,
      Math.min(c.maxLeverage, COPY_MAX_LEVERAGE, input.riskCap ?? Number.POSITIVE_INFINITY),
    );
    caps[c.market] = cap;
    const want = per?.[c.market] ?? p.leverage;
    lev[c.market] = Math.min(Math.max(1, Math.floor(want)), cap);
  }
  const chosenLevs = input.candidates
    .filter((c) => chosen.has(c.market))
    .map((c) => lev[c.market] ?? 1);
  const lowest = chosenLevs.length === 0 ? null : Math.min(...chosenLevs);
  const exposure = dec(input.budget)
    .mul(lowest ?? p.leverage)
    .toDecimalPlaces(2, Decimal.ROUND_DOWN);
  const perTrade = Decimal.min(dec(base.fixedNotional), exposure).toDecimalPlaces(
    2,
    Decimal.ROUND_DOWN,
  );
  const fields = {
    ...base,
    fixedNotional: perTrade.toString(),
    maxNotionalPerTrade: perTrade.toString(),
    maxExposure: exposure.toString(),
  };
  const rows: CopyPlanRow[] = input.candidates.map((c) => {
    const l = lev[c.market] ?? 1;
    const liq =
      input.marginMode !== "isolated" || c.tiers === null || c.tiers.length === 0
        ? null
        : (() => {
            const ds = (["long", "short"] as const).map((side) =>
              liquidationDistance({
                tiers: c.tiers ?? [],
                leverage: l,
                notional: perTrade.toString(),
                side,
              }),
            );
            if (ds.some((d) => d === null)) return null;
            const worst = Decimal.min(...(ds as Decimal[]));
            return worst.mul(100).toDecimalPlaces(1, Decimal.ROUND_DOWN).toString();
          })();
    return {
      market: c.market,
      selected: chosen.has(c.market),
      leverage: l,
      maxLeverage: caps[c.market] ?? 1,
      marginPerPosition: perTrade.div(l).toDecimalPlaces(2, Decimal.ROUND_DOWN).toString(),
      liquidationPct: liq,
      trades30d: c.trades30d,
    };
  });
  const selectedRows = rows.filter((r) => r.selected);
  const mixed = selectedRows.some((r) => r.leverage !== p.leverage);
  return {
    rows,
    fields,
    lowestLeverage: lowest,
    mixed,
    leverageByMarket: Object.fromEntries(selectedRows.map((r) => [r.market, r.leverage])),
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
  /** Market có volume 24h trên SoDEX dưới `COPY_THIN_MARKET_USD` (lệnh copy dễ bị bỏ qua hoặc nhỏ hơn). */
  thinMarkets: z.array(z.string()).default([]),
  /** Mọi market copy được của trader (đã chọn hay chưa), cho bảng "Markets we'll copy" (DEC-226). */
  rows: z
    .array(
      z.object({
        market: z.string(),
        selected: z.boolean(),
        leverage: z.number().int(),
        maxLeverage: z.number().int(),
        marginPerPosition: decimalStringSchema,
        liquidationPct: decimalStringSchema.nullable(),
        trades30d: z.number().int().nullable(),
      }),
    )
    .default([]),
  lowestLeverage: z.number().int().nullable().default(null),
  /** Có market dùng đòn bẩy khác mức an toàn (per-market, hoặc bị hạ về trần của market). */
  mixedLeverage: z.boolean().default(false),
});
export type CopyPreview = z.infer<typeof copyPreviewSchema>;

/** Ngưỡng cảnh báo "Thin market on SoDEX" (DEC-207): volume 24h theo quote (USD). */
export const COPY_THIN_MARKET_USD = "50000";

export const copyStartSchema = copyRequestSchema.extend({
  acknowledged: z.literal(true),
  twoFactorCode: z.string().min(6).max(11).optional(),
});

import { z } from "zod";

import { BotState } from "../enums";
import { decimalStringSchema, isoDateTimeSchema } from "../schemas";

import { timeZoneSchema } from "./market-hours";

// Signal Analysis (team, #233, docs/mockups/signal-analysis): tab All / Volume Builder / Market Making. Chỉ bot
// Market Making (`volume_maker`) + Volume Builder (`volume_farm`) tiền thật; người dùng hiện theo account (không email,
// DEC-288). Số là số quá khứ do API tính, không dự báo; thiếu → null ("Not available"), không bao giờ 0.
// Không chứa snapshot thô: chỉ các số trang hiện. Tên field tránh tên nội bộ của chiến lược (check:bundle).

/** Kỳ của trang; tối đa 30 ngày để truy vấn có giới hạn. */
export const SIGNAL_RANGES = ["24h", "7d", "14d", "30d"] as const;
export type SignalRange = (typeof SIGNAL_RANGES)[number];
export const SIGNAL_RANGE_MS: Record<SignalRange, number> = {
  "24h": 86_400_000,
  "7d": 7 * 86_400_000,
  "14d": 14 * 86_400_000,
  "30d": 30 * 86_400_000,
};
/**
 * Snapshot tín hiệu (`bot_events.payload.signal`, DEC-311) và bối cảnh lệnh Market Making (`orders.context`, DEC-312) được
 * giữ chừng này ngày rồi scheduler bỏ đi, giữ nguyên dòng Decisions / lệnh (#229). Phải dài hơn kỳ dài nhất của
 * trang (30 ngày) để trang không bao giờ thiếu dữ liệu trong kỳ; test kiểm tra.
 */
export const SIGNAL_SNAPSHOT_RETENTION_DAYS = 45;
/** Nhóm dưới chừng này mẫu là "Thin sample"; gợi ý / cost driver chỉ hiện khi nhóm đạt mức này. */
export const SIGNAL_MIN_GROUP = 30;
/** Số dòng mỗi trang của danh sách Entries / Fills. */
export const SIGNAL_PAGE_SIZE = 50;

const uuid = z.uuid();
const money = decimalStringSchema;
/** bp / % đã làm tròn 2 chữ số; null = không tính được. */
const num = z.number().nullable();

const baseQuery = {
  range: z.enum(SIGNAL_RANGES).default("7d"),
  tz: timeZoneSchema.default("UTC"),
  market: z.string().min(1).max(40).optional(),
  botId: uuid.optional(),
};

export const SIGNAL_STRATEGIES = ["volume_maker", "volume_farm"] as const;
export type SignalStrategy = (typeof SIGNAL_STRATEGIES)[number];

export const signalAllQuerySchema = z.object({
  ...baseQuery,
  strategy: z.enum(SIGNAL_STRATEGIES).optional(),
  /** Account = user id (team thấy theo account, không email). */
  account: uuid.optional(),
});
export type SignalAllQuery = z.infer<typeof signalAllQuerySchema>;

export const VB_REGIMES = ["up", "down", "sideways", "volatile", "unclear"] as const;
export type VbRegime = (typeof VB_REGIMES)[number];

export const signalVbQuerySchema = z.object({
  ...baseQuery,
  regime: z.enum(VB_REGIMES).optional(),
  entryType: z.enum(["signal", "balance"]).optional(),
  reversed: z.enum(["on", "off"]).optional(),
});
export type SignalVbQuery = z.infer<typeof signalVbQuerySchema>;

export const signalMmQuerySchema = z.object({
  ...baseQuery,
  /** Where to quote: 0 = best price, 3 = 3+ steps back. */
  level: z.coerce.number().int().min(0).max(3).optional(),
  smart: z.enum(["on", "off"]).optional(),
  side: z.enum(["buy", "sell"]).optional(),
});
export type SignalMmQuery = z.infer<typeof signalMmQuerySchema>;

const offset = z.coerce.number().int().min(0).max(100_000).default(0);
export const signalVbEntriesQuerySchema = signalVbQuerySchema.extend({
  sort: z.enum(["newest", "worst", "move"]).default("newest"),
  offset,
});
export type SignalVbEntriesQuery = z.infer<typeof signalVbEntriesQuerySchema>;
export const signalMmFillsQuerySchema = signalMmQuerySchema.extend({
  sort: z.enum(["newest", "worst", "cuts"]).default("newest"),
  offset,
});
export type SignalMmFillsQuery = z.infer<typeof signalMmFillsQuerySchema>;

// ── Chung ───────────────────────────────────────────────────────────────────────────────────────────────────────────

const botFacet = z.object({
  id: uuid,
  name: z.string(),
  market: z.string(),
  strategy: z.enum(SIGNAL_STRATEGIES),
  /** Lúc tạo bot; bộ chọn hiện ngày theo múi giờ của trang. */
  createdAt: isoDateTimeSchema,
  /** 8 ký tự cuối của user id ("Account ··{tail}", DEC-288); không bao giờ email. */
  tail: z.string(),
  /** Trạng thái hiện tại của bot (bộ chọn bot dùng lại bộ lọc State của Trading Agent, #289). */
  state: z.enum(BotState),
  /** Số version cấu hình đang chạy; null khi chưa có. */
  version: z.number().int().nullable(),
});
export type SignalBotFacet = z.infer<typeof botFacet>;
const accountFacet = z.object({ id: uuid, tail: z.string() });

const head = {
  computedAt: isoDateTimeSchema,
  range: z.enum(SIGNAL_RANGES),
  tz: z.string(),
  from: isoDateTimeSchema,
  to: isoDateTimeSchema,
  /** Bot / account tiền thật có fill trong kỳ (theo bộ lọc). */
  bots: z.number().int().nonnegative(),
  accounts: z.number().int().nonnegative(),
  markets: z.array(z.string()),
  botList: z.array(botFacet),
};

/** Một gợi ý có số liệu (chỉ khi nhóm ≥ 30); `values` là tham số của câu chữ trong en.json. */
export const signalSuggestionSchema = z.object({
  key: z.string(),
  n: z.number().int().nonnegative(),
  values: z.record(z.string(), z.union([z.number(), z.string()])),
});
export type SignalSuggestion = z.infer<typeof signalSuggestionSchema>;
/** Gợi ý bị ẩn vì nhóm dưới 30. */
export const signalHiddenLeadSchema = z.object({ key: z.string(), n: z.number().int() });
export type SignalHiddenLead = z.infer<typeof signalHiddenLeadSchema>;

// ── All ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Chi phí một nhóm fill, $ / 1M volume, dương = tốn, âm = có lời. fees + markout + inventory = net.
 * - fees: phí SoDEX + builder (fills.fee đã gồm builder).
 * - markout: giá chạy ngược fill sau 1 phút, đã gồm spread kiếm được.
 * - inventory: phần còn lại của kết quả giá (giữ vị thế sau phút đầu, cắt vị thế, stop loss).
 */
export const signalCostGroupSchema = z.object({
  key: z.string(),
  label: z.string(),
  /** Phụ đề (ví dụ market · strategy của bot, số bot của account). */
  strategy: z.enum(SIGNAL_STRATEGIES).nullable(),
  market: z.string().nullable(),
  bots: z.number().int().nonnegative(),
  accounts: z.number().int().nonnegative(),
  fills: z.number().int().nonnegative(),
  volume: money,
  fees: money.nullable(),
  sodexFees: money.nullable(),
  builderFees: money.nullable(),
  markout: money.nullable(),
  inventory: money.nullable(),
  net: money.nullable(),
  /** Net cost tổng (USDC), dương = tốn. */
  netUsd: money.nullable(),
  /** Net cost / $1M của kỳ trước cùng độ dài; null = không có fill kỳ trước hoặc thiếu giá. */
  prevNet: money.nullable(),
  /** Net cost / $1M kỳ này − kỳ trước (API tính, web không trừ); null khi thiếu một trong hai. */
  vsPrev: money.nullable(),
  /** Các số / 1M chia cho volume có giá 1 phút (false = dưới 80% có giá, markout / tồn kho Not available). */
  priced: z.boolean(),
  thin: z.boolean(),
});
export type SignalCostGroup = z.infer<typeof signalCostGroupSchema>;

export const signalDriverSchema = z.object({
  kind: z.enum(["account", "bot", "strategyMarketHours"]),
  group: signalCostGroupSchema,
  /** (net nhóm − net trung bình) × volume nhóm, USDC. */
  extraUsd: money,
  /** Phần chiếm nhiều nhất của chi phí nhóm. */
  part: z.enum(["fees", "markout", "inventory"]),
  /** Phần đó của cả strategy (hoặc tổng) để so sánh, $ / 1M. */
  partOverall: money.nullable(),
  sharePct: num,
  /** Khối 4 giờ (giờ bắt đầu, theo múi giờ của trang) với kind strategyMarketHours. */
  hourFrom: z.number().int().min(0).max(23).nullable(),
});
export type SignalDriver = z.infer<typeof signalDriverSchema>;

export const signalAllViewSchema = z.object({
  ...head,
  accountList: z.array(accountFacet),
  total: signalCostGroupSchema,
  byStrategy: z.array(signalCostGroupSchema),
  byMarket: z.array(signalCostGroupSchema),
  byBot: z.array(signalCostGroupSchema),
  byAccount: z.array(signalCostGroupSchema),
  /** Theo ngày địa phương (key YYYY-MM-DD); inventory không gồm vị thế mang sang từ trước ngày đó. */
  daily: z.array(signalCostGroupSchema),
  /** Theo giờ (key ISO đầu giờ) khi kỳ ≤ 7 ngày; null khi dài hơn. */
  hourly: z.array(signalCostGroupSchema).nullable(),
  /** 24 giờ trong ngày (key "0".."23"), mọi ngày gộp lại. */
  byHour: z.array(signalCostGroupSchema),
  drivers: z.array(signalDriverSchema),
});
export type SignalAllView = z.infer<typeof signalAllViewSchema>;

// ── Volume Builder ──────────────────────────────────────────────────────────────────────────────────────────────────

export const SIGNAL_VB_HORIZONS = [10, 30, 60, 120, 300] as const;
export const SIGNAL_MM_HORIZONS = [0, 10, 30, 60, 120, 300] as const;

const markoutStat = z.object({
  n: z.number().int().nonnegative(),
  mean: num,
  p25: num,
  p75: num,
  /** % mẫu có markout < 0 (giá đi ngược fill). */
  againstPct: num,
});
export type SignalMarkoutStat = z.infer<typeof markoutStat>;

/** Một dòng breakdown của VB (bp mỗi vòng, + = có lợi cho lệnh vào). */
export const vbRowSchema = z.object({
  key: z.string(),
  n: z.number().int().nonnegative(),
  sharePct: num,
  moveBefore3: num,
  markout1m: num,
  beforeFees: num,
  fees: num,
  net: num,
  netPerM: money.nullable(),
  oppositeNet: num,
  thin: z.boolean(),
});
export type VbRow = z.infer<typeof vbRowSchema>;

export const VB_BREAKDOWNS = [
  "regime",
  "score",
  "part",
  "exit",
  "entryType",
  "hour",
  "market",
  "size",
] as const;
export type VbBreakdown = (typeof VB_BREAKDOWNS)[number];

export const VB_MOVE_BUCKETS = ["against", "0-2", "2-4", "4-6", "6+"] as const;
const moveBucket = z.object({
  key: z.enum(VB_MOVE_BUCKETS),
  n: z.number().int().nonnegative(),
  beforeFees: num,
  opposite: num,
  thin: z.boolean(),
});

export const signalVbViewSchema = z.object({
  ...head,
  summary: z.object({
    entries: z.number().int().nonnegative(),
    signal: z.number().int().nonnegative(),
    balance: z.number().int().nonnegative(),
    /** Lượt vào trước v2.11.0 (không có snapshot tín hiệu). */
    noSnapshot: z.number().int().nonnegative(),
    volume: money,
    beforeFees: num,
    fees: num,
    sodexFees: num,
    builderFees: num,
    net: num,
    beforeFeesPerM: money.nullable(),
    feesPerM: money.nullable(),
    netPerM: money.nullable(),
    netUsd: money.nullable(),
    /** What-if phía ngược lại: trước phí / sau phí (bp), chỉ lượt có spread lúc vào. */
    opposite: num,
    oppositeNet: num,
    oppositeNetPerM: money.nullable(),
    oppositeN: z.number().int().nonnegative(),
  }),
  suggestions: z.array(signalSuggestionSchema),
  hidden: z.array(signalHiddenLeadSchema),
  markout: z.object({
    actual: z.array(markoutStat),
    opposite: z.array(num),
  }),
  moveBefore: z.object({
    m1: z.array(moveBucket),
    m3: z.array(moveBucket),
    m5: z.array(moveBucket),
  }),
  breakdown: z.record(
    z.enum(VB_BREAKDOWNS),
    z.object({ rows: z.array(vbRowSchema), total: vbRowSchema }),
  ),
});
export type SignalVbView = z.infer<typeof signalVbViewSchema>;

export const VB_EXIT_REASONS = [
  "hold",
  "takeProfit",
  "earlyProfit",
  "maxHold",
  "stopLoss",
  "stopOnSodex",
  "other",
] as const;
export type VbExitReason = (typeof VB_EXIT_REASONS)[number];

export const vbEntrySchema = z.object({
  id: uuid,
  filledAt: isoDateTimeSchema,
  market: z.string(),
  botId: uuid,
  botName: z.string(),
  side: z.enum(["long", "short"]),
  entryType: z.enum(["signal", "balance"]).nullable(),
  /** 0–100; null với lượt cân long / short hoặc không có snapshot. */
  score: num,
  moveBefore3: num,
  markout1m: num,
  exit: z.enum(VB_EXIT_REASONS).nullable(),
  beforeFees: num,
  net: num,
  oppositeNet: num,
});
export type VbEntry = z.infer<typeof vbEntrySchema>;

export const signalVbEntriesPageSchema = z.object({
  total: z.number().int().nonnegative(),
  items: z.array(vbEntrySchema),
  nextOffset: z.number().int().nullable(),
});
export type SignalVbEntriesPage = z.infer<typeof signalVbEntriesPageSchema>;

const candle = z.object({
  t: isoDateTimeSchema,
  h: money,
  l: money,
  c: money,
});
const pricePoint = z.object({ t: isoDateTimeSchema, p: money });

/** Một dòng Order timeline: quyết định của bot, lệnh gửi, hoặc fill. */
export const signalTimelineItemSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("decision"),
    at: isoDateTimeSchema,
    decision: z.string(),
    why: z.string().nullable(),
  }),
  z.object({
    kind: z.literal("order"),
    at: isoDateTimeSchema,
    side: z.enum(["buy", "sell"]),
    type: z.enum(["limit", "market"]),
    postOnly: z.boolean(),
    reduceOnly: z.boolean(),
    price: money.nullable(),
    status: z.string(),
  }),
  z.object({
    kind: z.literal("fill"),
    at: isoDateTimeSchema,
    side: z.enum(["buy", "sell"]),
    size: money,
    price: money,
    fee: money,
    maker: z.boolean().nullable(),
  }),
]);
export type SignalTimelineItem = z.infer<typeof signalTimelineItemSchema>;

export const vbEntryDetailSchema = z.object({
  entry: vbEntrySchema,
  entryPrice: money,
  exitPrice: money.nullable(),
  exitAt: isoDateTimeSchema.nullable(),
  orderAt: isoDateTimeSchema.nullable(),
  heldSecs: z.number().int().nullable(),
  notional: money,
  pricePnl: money.nullable(),
  fees: money,
  netPnl: money.nullable(),
  pricePnlBp: num,
  feesBp: num,
  /** % so với giá vào, từ high / low nến 1 phút trong lúc giữ. */
  mfePct: num,
  maePct: num,
  /** Nến không phủ hết lúc giữ (giữ > 24 giờ): MFE / MAE chỉ tính trên phần có. */
  mfePartial: z.boolean(),
  candles: z.array(candle),
  timeline: z.array(signalTimelineItemSchema),
  signal: z
    .object({
      score: num,
      regime: z.enum(VB_REGIMES),
      spreadBp: num,
      /** Mỗi phần 0–100 (50 = trung tính). */
      parts: z.object({
        momentum: z.number(),
        wick: z.number(),
        volume: z.number(),
        trade: z.number(),
        book: z.number(),
      }),
      lead: z.enum(["momentum", "wick", "volume", "trade", "book"]).nullable(),
      reversed: z.boolean(),
    })
    .nullable(),
  moveBefore: z.object({ m1: num, m3: num, m5: num }),
  moveBeforeAll: z.object({ m1: num, m3: num, m5: num }),
  markouts: z.array(num),
  markoutsAll: z.array(num),
  opposite: z
    .object({
      side: z.enum(["long", "short"]),
      entry: money,
      exit: money,
      pricePnl: money,
      fees: money,
      net: money,
      netBp: num,
    })
    .nullable(),
});
export type VbEntryDetail = z.infer<typeof vbEntryDetailSchema>;

// ── Market Making ───────────────────────────────────────────────────────────────────────────────────────────────────

/** Một dòng breakdown của MM (bp mỗi fill, + = có lợi cho fill). */
export const mmRowSchema = z.object({
  key: z.string(),
  n: z.number().int().nonnegative(),
  sharePct: num,
  spread: num,
  markout10s: num,
  markout1m: num,
  markout5m: num,
  againstPct: num,
  netAfterFees: num,
  /** Net cost / $1M kể cả tồn kho; dương = tốn. */
  netPerM: money.nullable(),
  thin: z.boolean(),
});
export type MmRow = z.infer<typeof mmRowSchema>;

export const MM_BREAKDOWNS = ["level", "smart", "clamp", "hour", "market", "size", "side"] as const;
export type MmBreakdown = (typeof MM_BREAKDOWNS)[number];

export const signalMmViewSchema = z.object({
  ...head,
  summary: z.object({
    fills: z.number().int().nonnegative(),
    volume: money,
    spread: num,
    markout1m: num,
    feesBp: num,
    againstPct: num,
    cuts: z.number().int().nonnegative(),
    cutsUsd: money.nullable(),
    netPerM: money.nullable(),
    netUsd: money.nullable(),
    prevNetPerM: money.nullable(),
    vsPrev: money.nullable(),
    /** Fill có bối cảnh lệnh (DEC-312); fill cũ hơn không có quote level / Smart quoting. */
    withContext: z.number().int().nonnegative(),
  }),
  /** $ / 1M, dương = tốn; spread âm = kiếm được. */
  waterfall: z.object({
    spread: money.nullable(),
    priceAgainst: money.nullable(),
    fees: money.nullable(),
    sodexFees: money.nullable(),
    builderFees: money.nullable(),
    inventory: money.nullable(),
    net: money.nullable(),
  }),
  suggestions: z.array(signalSuggestionSchema),
  hidden: z.array(signalHiddenLeadSchema),
  curve: z.object({
    all: z.array(markoutStat),
    on: z.array(num),
    off: z.array(num),
    feesBp: num,
  }),
  levels: z.array(
    z.object({
      level: z.number().int().min(0).max(3),
      n: z.number().int().nonnegative(),
      spread: num,
      priceAgainst: num,
      netAfterFees: num,
      /** Lệnh đã khớp ÷ lệnh đặt ở mức đó (%). */
      fillRatePct: num,
      thin: z.boolean(),
    }),
  ),
  inventory: z.object({
    timeFlatPct: num,
    avgPositionOrders: num,
    inventoryPerM: money.nullable(),
    cuts: z.number().int().nonnegative(),
    cutsUsd: money.nullable(),
    avgCutMoveBp: num,
    latestCuts: z.array(
      z.object({
        fillId: uuid,
        at: isoDateTimeSchema,
        market: z.string(),
        botName: z.string(),
        position: z.enum(["long", "short"]),
        moveBp: num,
        entry: money.nullable(),
        price: money,
        heldSecs: z.number().int().nullable(),
        resultUsd: money.nullable(),
      }),
    ),
  }),
  breakdown: z.record(
    z.enum(MM_BREAKDOWNS),
    z.object({ rows: z.array(mmRowSchema), total: mmRowSchema }),
  ),
});
export type SignalMmView = z.infer<typeof signalMmViewSchema>;

/** p25 / p75 của "Price after the fill" cho đúng bộ lọc (endpoint riêng, tải sau trang chính). */
export const signalMmQuantilesSchema = z.object({
  p25: z.array(num),
  p75: z.array(num),
});
export type SignalMmQuantiles = z.infer<typeof signalMmQuantilesSchema>;

export const mmFillSchema = z.object({
  id: uuid,
  filledAt: isoDateTimeSchema,
  market: z.string(),
  botId: uuid,
  botName: z.string(),
  side: z.enum(["buy", "sell"]),
  level: z.number().int().min(0).nullable(),
  smart: z.boolean().nullable(),
  clamp: z.enum(["hit", "normal"]).nullable(),
  kind: z.enum(["quote", "close", "cut"]),
  usd: money,
  spread: num,
  markout10s: num,
  markout1m: num,
  markout5m: num,
  netAfterFees: num,
});
export type MmFill = z.infer<typeof mmFillSchema>;

export const signalMmFillsPageSchema = z.object({
  total: z.number().int().nonnegative(),
  items: z.array(mmFillSchema),
  nextOffset: z.number().int().nullable(),
});
export type SignalMmFillsPage = z.infer<typeof signalMmFillsPageSchema>;

export const mmFillDetailSchema = z.object({
  fill: mmFillSchema,
  price: money,
  size: money,
  mid: money.nullable(),
  /** Mid theo giây (mid_1s) quanh fill khi có (giữ 48 giờ); nếu không có thì nến 1 phút. */
  prices: z.array(pricePoint),
  priceSource: z.enum(["mid", "candles"]).nullable(),
  quote: z.object({
    level: z.number().int().nullable(),
    smart: z.boolean().nullable(),
    clamp: z.enum(["hit", "normal"]).nullable(),
    /** Giá báo so với giới hạn Binance (bp, dương = còn cách giới hạn); null khi không theo giá Binance. */
    insideLimitBp: num,
    spreadBp: num,
    bookSecs: z.number().nullable(),
    positionBefore: money.nullable(),
    positionOrders: num,
  }),
  markouts: z.array(num),
  markoutsAll: z.array(num),
  /** USDC: spread kiếm được, giá chạy ngược tới 1 phút, phí SoDEX, builder fee, net sau 1 phút. */
  split: z.object({
    spread: money.nullable(),
    priceAgainst: money.nullable(),
    /** null khi fill không có builder fee đã ghi (không dồn vào phí SoDEX). */
    sodexFee: money.nullable(),
    builderFee: money.nullable(),
    net: money.nullable(),
  }),
  timeline: z.array(signalTimelineItemSchema),
});
export type MmFillDetail = z.infer<typeof mmFillDetailSchema>;

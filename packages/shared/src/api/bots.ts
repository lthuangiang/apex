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

/** Bot khối lượng (Volume Maker, Volume Farm): chỉ tạo được khi admin bật cho tài khoản (DEC-80); api kiểm tra. */
export const VOLUME_STRATEGIES = [Strategy.volumeMaker, Strategy.volumeFarm] as const;
/**
 * Chiến lược thử nghiệm (DEC-107; Copy Trade DEC-161): chỉ tạo và chạy được khi team bật AI Desk cho tài khoản, cho tới khi có đủ dữ liệu
 * để mở rộng. Api và engine đều kiểm tra.
 */
export const EXPERIMENTAL_STRATEGIES = [Strategy.adaptiveDca, Strategy.copyTrade] as const;
export const BOT_STRATEGIES = [
  ...LAUNCHED_STRATEGIES,
  ...VOLUME_STRATEGIES,
  ...EXPERIMENTAL_STRATEGIES,
] as const;

/** Tính năng của người dùng đang đăng nhập: `volumeBots` do admin bật ở Users (DEC-80). */
export const featuresSchema = z.object({
  volumeMaker: z.boolean(),
  volumeFarm: z.boolean(),
  /** AI Desk: team bật theo tài khoản ở Users (DEC-105). */
  aiDesk: z.boolean().default(false),
  /** AI Adaptive DCA (Beta, DEC-107): cờ riêng (DEC-192), mặc định bật, team tắt được (DEC-TBD-adaptive-dca-beta). */
  adaptiveDca: z.boolean().default(false),
  /** Builder fee hiệu lực theo chiến lược của user (DEC-159), phần mười bp; thiếu key = mặc định. */
  builderFees: z.record(z.string(), z.number().int()).default({}),
});

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

/** Điều kiện bot đang chờ trước khi vào lệnh (DEC-91). Bot vẫn Running; UI hiện "Waiting for price". */
export const botWaitingSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("entry"),
    condition: z.discriminatedUnion("type", [
      z.object({ type: z.literal("at_price"), price: decimalStringSchema }),
      z.object({ type: z.literal("cross"), price: decimalStringSchema }),
      z.object({
        type: z.literal("in_range"),
        low: decimalStringSchema,
        high: decimalStringSchema,
      }),
    ]),
  }),
  z.object({ kind: z.literal("pullback"), price: decimalStringSchema }),
  z.object({ kind: z.literal("cooldown"), until: isoDateTimeSchema }),
  z.object({ kind: z.literal("start_at"), at: isoDateTimeSchema }),
]);
export type BotWaiting = z.infer<typeof botWaitingSchema>;

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
  /** Đơn vị của `capital`: quote, hoặc base với TWAP (tổng khối lượng, UI_REVIEW N2). */
  capitalUnit: z.enum(["quote", "base"]).default("quote"),
  /** Nhãn thay cho `market` khi bot chạy nhiều tài sản (Rebalancing: "BTC · ETH · USDC"); null thì dùng market. */
  marketLabel: z.string().nullable().default(null),
  /** Số lệnh đã khớp (filled / partially_filled); 0 thì UI hiện "No fills yet" thay cho Profit (UI_REVIEW J1). */
  fills: z.number().int().nonnegative().default(0),
  /** Chỉ có khi bot Running và đang chờ điều kiện vào; null là không chờ. */
  waiting: botWaitingSchema.nullable().default(null),
  /** `paper`: tiền giả, lệnh chỉ mô phỏng trong DRIFT (DEC-105). UI gắn nhãn PAPER ở mọi nơi hiện bot. */
  mode: z.enum(["live", "paper"]).default("live"),
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
  /** Câu lỗi SoDEX trả về khi từ chối lệnh, nguyên văn; null khi SoDEX không gửi. */
  rejectMessage: z.string().nullable().default(null),
  submittedAt: isoDateTimeSchema.nullable(),
});
export type OrderView = z.infer<typeof orderViewSchema>;
/**
 * `items` chỉ gồm tối đa 200 lệnh mới nhất; `counts` server đếm trên toàn bộ lệnh, nên không bị giới hạn đó ảnh hưởng.
 * "Hôm nay" tính từ 00:00 theo múi giờ của tài khoản (DEC-90).
 */
export const orderListSchema = z.object({
  items: z.array(orderViewSchema),
  counts: z.object({
    open: z.number().int(),
    partiallyFilled: z.number().int(),
    filledToday: z.number().int(),
    rejectedToday: z.number().int(),
    /** Lý do của lệnh bị từ chối gần nhất hôm nay. */
    lastRejectCode: z.string().nullable(),
    lastRejectMessage: z.string().nullable(),
    total: z.number().int(),
  }),
});

/**
 * Một lần khớp của bot theo SoDEX (bảng `fills`, mỗi trade id một dòng). `value` = price × size. `liquidity` null
 * khi SoDEX không báo maker / taker. `close` = lệnh reduce-only (đóng vị thế).
 */
export const botFillViewSchema = z.object({
  id: uuidSchema,
  filledAt: isoDateTimeSchema,
  side: z.enum(["buy", "sell"]),
  price: decimalStringSchema,
  size: decimalStringSchema,
  value: decimalStringSchema,
  /** Đã gồm builder fee. */
  fee: decimalStringSchema,
  liquidity: z.enum(["maker", "taker"]).nullable(),
  close: z.boolean(),
});
export type BotFillView = z.infer<typeof botFillViewSchema>;
/** Số lần khớp mỗi trang ở Trading Agent. */
export const BOT_FILLS_PAGE_SIZE = 10;
/** Một trang lần khớp của bot, mới nhất trước; `total` là tổng số lần khớp. */
export const botFillListSchema = z.object({
  items: z.array(botFillViewSchema),
  page: z.number().int().positive(),
  pageSize: z.number().int().positive(),
  total: z.number().int().nonnegative(),
});
export type BotFillList = z.infer<typeof botFillListSchema>;

export const botDetailSchema = z.object({
  bot: botSummarySchema,
  versions: z.array(botVersionSchema),
  events: z.array(botEventSchema),
  openOrders: z.number().int().nonnegative(),
  /** Giờ server: Runtime tính theo mốc này, không phụ thuộc đồng hồ máy người dùng (DEC-88). */
  serverTime: isoDateTimeSchema,
  /** Mốc "Running" gần nhất khi bot đang chạy; null khi không chạy hoặc chưa có. Runtime tính từ đây. */
  runningSince: isoDateTimeSchema.nullable().default(null),
  /** Chỉ số theo dõi của Volume Maker (VOLUME_MAKER.md mục 17.6); null với chiến lược khác hoặc chưa chạy. */
  volumeMaker: z
    .object({
      volume: decimalStringSchema,
      /** Null: không đặt Stop after trading (DEC-99). */
      volumeTarget: decimalStringSchema.nullable(),
      cost: decimalStringSchema,
      costBudget: decimalStringSchema,
      costPerMillion: decimalStringSchema.nullable(),
      makerSharePct: decimalStringSchema.nullable(),
      inventory: decimalStringSchema,
      selfTradeBlocked: z.number().int(),
      /** Cơ cấu chi phí của phiên (DEC-136). Phí SoDEX = tổng phí trên fill − builder fee. */
      sodexFees: decimalStringSchema.default("0"),
      builderFees: decimalStringSchema.default("0"),
      /** Lãi / lỗ giá đã chốt (có dấu, trước phí). */
      pricePnl: decimalStringSchema.default("0"),
      /** Lãi / lỗ chưa chốt của vị thế đang mở theo giá gần nhất (có dấu). */
      openPnl: decimalStringSchema.default("0"),
      /** Funding đã trả (dương) hoặc nhận (âm). */
      funding: decimalStringSchema.default("0"),
    })
    .nullable()
    .default(null),
  /**
   * Khối lượng của Volume Farm (DEC-83). `session` đọc từ state của engine: tính từ lần chạy đầu của version đang
   * chạy, Pause / Resume không xoá. Các kỳ còn lại tính từ `fills` của bot, nên giữ qua các version.
   */
  volumeFarm: z
    .object({
      session: z.object({
        volume: decimalStringSchema,
        trades: z.number().int(),
        wins: z.number().int(),
        winRatePct: decimalStringSchema.nullable(),
        /** Tổng phí của các lần khớp trong phiên: phí giao dịch SoDEX + builder fee của DRIFT. */
        fees: decimalStringSchema,
        /** Phần phí giao dịch của SoDEX (= fees − builderFees, DEC-127). */
        sodexFees: decimalStringSchema.default("0"),
        /** Phần builder fee của DRIFT (cột `builder_fee` của fill, DEC-127). */
        builderFees: decimalStringSchema.default("0"),
        /** Lời / lỗ giá đã chốt của các lượt đã đóng, trước phí (DEC-127). */
        pricePnl: decimalStringSchema.default("0"),
        /** Funding đã trả (dương) hoặc nhận (âm) (DEC-127). */
        funding: decimalStringSchema.default("0"),
        /** Lãi / lỗ ròng đã chốt = pricePnl − fees − funding; chưa tính vị thế đang mở. */
        net: decimalStringSchema,
        /** Lỗ ròng trên mỗi 1 triệu USD khối lượng; 0 khi đang lãi; null khi chưa có khối lượng. */
        costPerMillion: decimalStringSchema.nullable(),
      }),
      volume1h: decimalStringSchema,
      volume24h: decimalStringSchema,
      volume7d: decimalStringSchema,
      volumeTotal: decimalStringSchema,
      makerSharePct: decimalStringSchema.nullable(),
      volumeTarget: decimalStringSchema.nullable(),
      position: decimalStringSchema,
    })
    .nullable()
    .default(null),
  /** AI Adaptive DCA (DEC-107): đọc thị trường và quyết định gần nhất của engine; null với chiến lược khác. */
  adaptiveDca: z
    .object({
      regime: z.enum(["SIDEWAY", "TREND_UP", "TREND_DOWN", "HIGH_VOLATILITY", "UNKNOWN"]),
      /** ATR 5 phút (giá); null khi chưa đủ nến. */
      atr: decimalStringSchema.nullable(),
      rsi: decimalStringSchema.nullable(),
      decision: z.enum(["continue", "reduce", "exit"]),
      phase: z.string(),
      extraBuys: z.number().int(),
      maxExtraBuys: z.number().int(),
      /** Giá trị vị thế hiện tại / trần (quote). */
      exposure: decimalStringSchema,
      maxExposure: decimalStringSchema,
      cycles: z.number().int(),
      exits: z.number().int(),
    })
    .nullable()
    .default(null),
});
export type BotDetail = z.infer<typeof botDetailSchema>;

/** Hành động trạng thái: chỉ Start hỏi 2FA, và chỉ khi người dùng đã bật (DEC-115). Stop không hỏi. */
export const botActionBodySchema = z.object({
  twoFactorCode: z.string().min(6).max(11).optional(),
  /** Start: người dùng đã tick checkbox xác nhận. */
  acknowledged: z.boolean().optional(),
  /** Stop bot Perps: đóng vị thế của bot bằng lệnh market reduce-only (DEC-81). Thiếu = giữ vị thế. */
  closePosition: z.boolean().optional(),
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

/**
 * Funding đã trả của các perp và volume Spot 24 giờ, cho ô chọn tài sản Funding Arb (DEC-160). Chỉ số đã xảy ra
 * (bảng `funding_rates`, `candles_1m`); web tính số giờ thu đủ phí bằng `arbFit`.
 */
export const fundingStatsSchema = z.object({
  perps: z.array(
    z.object({
      market: z.string(),
      intervalHours: z.number().positive(),
      /** Funding trung bình 7 ngày, % mỗi kỳ; null khi chưa có kỳ nào. */
      avg7dPct: decimalStringSchema.nullable(),
      /** Số kỳ có dữ liệu trong 7 ngày. */
      periods7d: z.number().int(),
      /** Số kỳ dương trong 21 kỳ gần nhất; null khi chưa đủ 21 kỳ. */
      positive21: z.number().int().nullable(),
    }),
  ),
  /** Volume Spot 24 giờ (quote) theo market; thiếu = chưa có nến. */
  spotVolume24h: z.record(z.string(), decimalStringSchema),
});
export type FundingStats = z.infer<typeof fundingStatsSchema>;

/** Giá gần nhất của một market (marketdata, Redis `md:last:*`); null khi chưa có hoặc đã hết hạn. */
export const marketLastSchema = z.object({
  market: z.string(),
  price: decimalStringSchema.nullable(),
  /** ms UTC của nến cung cấp giá. */
  at: z.number().int().nullable(),
});
export type MarketLast = z.infer<typeof marketLastSchema>;

/** Khung thời gian của chart ở màn tạo bot (IMP-05, DEC-91). */
export const CHART_INTERVALS = ["15m", "1h", "4h", "1d"] as const;
export type ChartInterval = (typeof CHART_INTERVALS)[number];

/** Nến SoDEX cho chart, cũ nhất trước. `t` là ms UTC lúc mở nến. */
export const candleListSchema = z.object({
  market: z.string(),
  interval: z.enum(CHART_INTERVALS),
  items: z.array(
    z.object({
      t: z.number().int(),
      o: decimalStringSchema,
      h: decimalStringSchema,
      l: decimalStringSchema,
      c: decimalStringSchema,
    }),
  ),
});
export type CandleList = z.infer<typeof candleListSchema>;

/**
 * Bản đồ thanh lý ước tính (IMP-05). Chỉ để hiển thị: không đưa vào strategy, reco hay quyết định đặt lệnh.
 * `available: false` khi chưa cấu hình nhà cung cấp hoặc nhà cung cấp không có dữ liệu cho market: UI ẩn tab.
 */
export const liquidationMapSchema = z.object({
  market: z.string(),
  interval: z.enum(CHART_INTERVALS),
  available: z.boolean(),
  /** Tên nhà cung cấp để ghi nguồn; null khi không có dữ liệu. */
  source: z.string().nullable(),
  /** ms UTC lúc nhà cung cấp tính dữ liệu. */
  updatedAt: z.number().int().nullable(),
  /** Mỗi dải: mức giá và giá trị thanh lý ước tính (quote). */
  bands: z.array(z.object({ price: decimalStringSchema, value: decimalStringSchema })),
});
export type LiquidationMap = z.infer<typeof liquidationMapSchema>;

/**
 * Số mức giá mỗi phía API trả cho sổ lệnh trực tiếp ở Trading Agent (DEC-99). 20 (DEC-147) để trên desktop Live quotes
 * hiện thêm mức cho cao bằng cột Market Making + Fills; mặc định vẫn hiện 10.
 */
export const ORDERBOOK_DEPTH = 20;

/** Sổ lệnh Perps của SoDEX (chỉ đọc). Bids giá cao nhất trước, asks giá thấp nhất trước. */
export const orderbookViewSchema = z.object({
  market: z.string(),
  /** ms UTC lúc server đọc từ SoDEX. */
  at: z.number().int(),
  bids: z.array(z.object({ price: decimalStringSchema, size: decimalStringSchema })),
  asks: z.array(z.object({ price: decimalStringSchema, size: decimalStringSchema })),
});
export type OrderbookView = z.infer<typeof orderbookViewSchema>;

/** Redis key của bản đồ thanh lý theo coin Hyperliquid: `marketdata` ghi, `api` đọc (DEC-92). */
export const hyperliquidMapKey = (coin: string): string => `liq:hl:map:${coin}`;
/** Bản ghi trong Redis: dải giá theo coin và thời điểm tính (ms UTC). */
export const hyperliquidMapSchema = z.object({
  updatedAt: z.number().int(),
  bands: z.array(z.object({ price: decimalStringSchema, value: decimalStringSchema })),
});
export type HyperliquidMap = z.infer<typeof hyperliquidMapSchema>;
/** Coin Hyperliquid của market SoDEX: "BTC-USD" và "vBTC_vUSDC" đều là "BTC". */
export const hyperliquidCoinOf = (market: string): string =>
  (market.split(/[-_/]/)[0] ?? market).replace(/^v(?=[A-Z0-9])/, "");

/** Kỳ của bảng Volume (DEC-128): phiên đang chạy (từ lúc version hiện tại được áp) hoặc khoảng thời gian gần nhất. */
export const VOLUME_PERIODS = ["session", "h1", "h24", "d7", "all"] as const;
export type VolumePeriod = (typeof VOLUME_PERIODS)[number];

/**
 * Thống kê volume theo kỳ của bot khối lượng (DEC-128), tính từ fill thật, lệnh đã gửi và các dòng "Closed … net"
 * trong Decisions. `series` chia kỳ thành các khoảng đều nhau, giá trị của từng khoảng (không cộng dồn).
 */
export const volumeAnalyticsSchema = z.object({
  period: z.enum(VOLUME_PERIODS),
  from: isoDateTimeSchema,
  to: isoDateTimeSchema,
  bucketMs: z.number().int().positive(),
  series: z.array(
    z.object({
      t: isoDateTimeSchema,
      volume: decimalStringSchema,
      maker: decimalStringSchema,
      fees: decimalStringSchema,
      /** Lãi / lỗ ròng (sau phí) của các lượt đóng trong khoảng này. */
      net: decimalStringSchema,
    }),
  ),
  totals: z.object({
    volume: decimalStringSchema,
    maker: decimalStringSchema,
    buy: decimalStringSchema,
    fees: decimalStringSchema,
    builderFees: decimalStringSchema,
    /** Lãi / lỗ ròng sau phí của các lượt đã đóng trong kỳ. */
    net: decimalStringSchema,
    trades: z.number().int(),
    wins: z.number().int(),
    ordersPlaced: z.number().int(),
    ordersFilled: z.number().int(),
    ordersRejected: z.number().int(),
  }),
});
export type VolumeAnalytics = z.infer<typeof volumeAnalyticsSchema>;

/** Review sau khi chạy của Volume Builder (DEC-131). Số là number: kết quả thống kê, không phải số tiền để ghi sổ. */
export const reviewParamsSchema = z.object({
  earlyProfitFees: z.number(),
  earlyExitSecs: z.number().int(),
  minHoldSecs: z.number().int(),
  maxHoldSecs: z.number().int(),
  slMarginPct: z.number(),
});
export type ReviewParamsView = z.infer<typeof reviewParamsSchema>;
const reviewScore = { costPerMillion: z.number(), winRatePct: z.number() };
export const botReviewResultSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("insufficient"),
    trades: z.number().int(),
    minTrades: z.number().int(),
  }),
  z.object({
    status: z.literal("done"),
    trades: z.number().int(),
    from: z.number(),
    to: z.number(),
    volume: z.number(),
    actual: z.object({
      costPerMillion: z.number(),
      feesPerMillion: z.number(),
      builderPerMillion: z.number(),
      pricePerMillion: z.number(),
      winRatePct: z.number(),
    }),
    current: z.object({ params: reviewParamsSchema, ...reviewScore }),
    best: z.object({
      params: reviewParamsSchema,
      ...reviewScore,
      deltaPerMillion: z.number(),
      ciLow: z.number(),
      ciHigh: z.number(),
      inSample: z.number(),
      outOfSample: z.number(),
      currentInSample: z.number(),
      currentOutOfSample: z.number(),
    }),
    recommended: z.boolean(),
    /** DEC-134; thiếu ở kết quả cũ (khi đó suy từ `recommended`). */
    suggestion: z.enum(["strong", "weak", "none"]).optional(),
    tested: z.number().int(),
    takerShare: z.object({
      trades: z.number().int(),
      takerCostPerMillion: z.number().nullable(),
      makerCostPerMillion: z.number().nullable(),
    }),
  }),
]);
export type BotReviewResult = z.infer<typeof botReviewResultSchema>;
export const botReviewViewSchema = z.object({
  id: uuidSchema,
  status: z.enum(["queued", "running", "done", "failed", "unavailable"]),
  error: z.string().nullable(),
  result: botReviewResultSchema.nullable(),
  appliedVersion: z.number().int().nullable(),
  createdAt: z.string(),
  finishedAt: z.string().nullable(),
});
export type BotReviewView = z.infer<typeof botReviewViewSchema>;
/** Strategy có review sau khi chạy. */
export const REVIEW_STRATEGIES = ["volume_farm"] as const;

// ─── Strategy Analytics (DEC-141) ────────────────────────────────────────────

export const ANALYTICS_PERIODS = ["h1", "h24", "d7", "d30", "all"] as const;
export type AnalyticsPeriod = (typeof ANALYTICS_PERIODS)[number];
/** Khoảng thời gian giữ lệnh (giây, cận dưới gồm, cận trên không gồm). */
export const HOLD_BUCKETS = [
  { key: "0-30s", from: 0, to: 30 },
  { key: "30-60s", from: 30, to: 60 },
  { key: "1-2m", from: 60, to: 120 },
  { key: "2-5m", from: 120, to: 300 },
  { key: "5-10m", from: 300, to: 600 },
  { key: "10m+", from: 600, to: Infinity },
] as const;
export const EXIT_REASONS = [
  "takeProfit",
  "earlyProfit",
  "holdTime",
  "maxHold",
  "stopLoss",
  "exchangeStop",
  "trailing",
  "other",
] as const;
export type ExitReason = (typeof EXIT_REASONS)[number];

export const analyticsTradeSchema = z.object({
  /** Khoá duy nhất: thời điểm khớp lệnh vào (ms). */
  key: z.string(),
  cycle: z.number().int(),
  openedAt: z.number(),
  closedAt: z.number(),
  side: z.enum(["long", "short"]),
  entry: z.number(),
  exit: z.number(),
  qty: z.number(),
  notional: z.number(),
  /** Lãi giá trước phí, phí (đã gồm builder fee), lãi ròng, USDC. */
  gross: z.number(),
  fees: z.number(),
  net: z.number(),
  holdSecs: z.number(),
  bucket: z.string(),
  exitReason: z.enum(EXIT_REASONS),
  /** Lãi / lỗ lớn nhất trong lượt theo nến 1 phút, % giá vào; null khi thiếu nến. */
  mfePct: z.number().nullable(),
  maePct: z.number().nullable(),
  version: z.number().int().nullable(),
  allMaker: z.boolean(),
});
export type AnalyticsTrade = z.infer<typeof analyticsTradeSchema>;

export const botAnalyticsSchema = z.object({
  period: z.enum(ANALYTICS_PERIODS),
  from: z.number(),
  to: z.number(),
  /** False với chiến lược chưa hỗ trợ (giai đoạn 1: Volume Builder). */
  supported: z.boolean(),
  summary: z.object({
    trades: z.number().int(),
    net: z.number(),
    gross: z.number(),
    fees: z.number(),
    volume: z.number(),
    winRateGross: z.number().nullable(),
    winRateNet: z.number().nullable(),
    /** Tổng lãi / tổng lỗ (sau phí); null khi không có lượt lỗ hoặc lãi. */
    profitFactor: z.number().nullable(),
    /** Sụt giảm lớn nhất của đường lãi ròng cộng dồn, USDC (số âm hoặc 0). */
    maxDrawdown: z.number(),
    avgHoldSecs: z.number().nullable(),
    medianHoldSecs: z.number().nullable(),
    /** Lãi ròng của kỳ trước cùng độ dài; null với "all". */
    prevNet: z.number().nullable(),
  }),
  equity: z.array(z.object({ t: z.number(), net: z.number() })),
  holding: z.array(
    z.object({
      bucket: z.string(),
      trades: z.number().int(),
      winRateGross: z.number().nullable(),
      winRateNet: z.number().nullable(),
      avgNet: z.number().nullable(),
      totalNet: z.number(),
    }),
  ),
  execution: z.object({
    makerRatioPct: z.number().nullable(),
    feePerTrade: z.number().nullable(),
    feePerMillion: z.number().nullable(),
    ordersPlaced: z.number().int(),
    ordersFilled: z.number().int(),
    fillRatePct: z.number().nullable(),
    rejected: z.number().int(),
  }),
  exits: z.array(
    z.object({ reason: z.enum(EXIT_REASONS), trades: z.number().int(), avgNet: z.number() }),
  ),
  trades: z.array(analyticsTradeSchema),
  best: z.string().nullable(),
  worst: z.string().nullable(),
  insights: z.array(
    z.object({
      key: z.string(),
      params: z.record(z.string(), z.union([z.string(), z.number()])),
    }),
  ),
  /** Chỉ Market Making (DEC-144); null với chiến lược khác. */
  mm: z
    .lazy(() => mmAnalyticsSchema)
    .nullable()
    .default(null),
});
export type BotAnalytics = z.infer<typeof botAnalyticsSchema>;

export const tradeDetailSchema = z.object({
  trade: analyticsTradeSchema,
  orders: z.array(
    z.object({
      tag: z.string(),
      side: z.enum(["buy", "sell"]),
      type: z.string(),
      price: z.string().nullable(),
      size: z.string(),
      filledSize: z.string(),
      status: z.string(),
      rejectCode: z.string().nullable(),
      at: z.number(),
    }),
  ),
  fills: z.array(
    z.object({
      at: z.number(),
      tag: z.string(),
      side: z.enum(["buy", "sell"]),
      price: z.number(),
      size: z.number(),
      fee: z.number(),
      maker: z.boolean(),
    }),
  ),
  candles: z.array(
    z.object({ t: z.number(), o: z.number(), h: z.number(), l: z.number(), c: z.number() }),
  ),
  enter: z.object({ at: z.number(), decision: z.string(), why: z.string() }).nullable(),
  closed: z.object({ at: z.number(), decision: z.string(), why: z.string() }).nullable(),
  config: z
    .object({ version: z.number().int(), config: z.record(z.string(), z.unknown()) })
    .nullable(),
});
export type TradeDetail = z.infer<typeof tradeDetailSchema>;

/** Analytics của Market Making (DEC-144): tính theo từng lần khớp, không theo lượt vào / ra. */
export const MM_HORIZONS = [1, 3, 5] as const;
const adverseSchema = z.object({
  /** Phút sau khi khớp. */
  minutes: z.number().int(),
  /** Giá chạy theo hướng có lợi cho lệnh vừa khớp, bp (âm = khớp bất lợi); null khi thiếu nến. */
  bp: z.number().nullable(),
  againstPct: z.number().nullable(),
});
export const mmAnalyticsSchema = z.object({
  fills: z.number().int(),
  quoteFills: z.number().int(),
  closeFills: z.number().int(),
  volume: z.number(),
  makerPct: z.number().nullable(),
  fees: z.number(),
  builderFees: z.number(),
  feePerMillion: z.number().nullable(),
  ordersPlaced: z.number().int(),
  ordersFilled: z.number().int(),
  fillRatePct: z.number().nullable(),
  rejected: z.number().int(),
  /** Thời gian lệnh đứng trên sổ tới khi khớp (giây, trung vị). */
  medianRestSecs: z.number().nullable(),
  /** Khớp bất lợi của lệnh báo giá (không tính lệnh đóng tồn kho), theo phút sau khi khớp. */
  adverse: z.array(adverseSchema),
  bySide: z.array(
    z.object({
      side: z.enum(["bid", "ask"]),
      fills: z.number().int(),
      adverse: z.array(adverseSchema),
    }),
  ),
  /** So sánh theo công tắc Smart quoting của version lúc khớp. */
  smart: z.array(
    z.object({ on: z.boolean(), fills: z.number().int(), adverse: z.array(adverseSchema) }),
  ),
  inventory: z.object({
    series: z.array(z.object({ t: z.number(), usd: z.number() })),
    maxAbsUsd: z.number(),
    flatPct: z.number().nullable(),
  }),
  volumeSeries: z.array(z.object({ t: z.number(), volume: z.number() })),
});
export type MmAnalytics = z.infer<typeof mmAnalyticsSchema>;

/** Số liệu công khai trên Landing (DEC-148): từ trước đến nay, không cần đăng nhập. */
export const publicStatsSchema = z.object({
  /** Tổng giá trị khớp (giá × khối lượng) của mọi lệnh do bot gửi, theo đồng quote (USDC). */
  totalVolume: decimalStringSchema,
  /** Số bot đã từng chạy (mọi trạng thái trừ draft). */
  botsLaunched: z.number().int(),
  at: z.number().int(),
});
export type PublicStats = z.infer<typeof publicStatsSchema>;

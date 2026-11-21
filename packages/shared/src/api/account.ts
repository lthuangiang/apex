import { z } from "zod";

import { OPS_HEALTH, OPS_REASON_CODES } from "../ops-health";
import { decimalStringSchema, isoDateTimeSchema, uuidSchema } from "../schemas";

import { twoFactorCodeSchema } from "./auth";
import { BOT_STRATEGIES, botSummarySchema } from "./bots";
import { connectEventViewSchema } from "./sodex";

// API màn Overview / Portfolio / Risk Center / AI Analyst / Builder Revenue (P10, DEC-41).

const dec = decimalStringSchema;

export const portfolioViewSchema = z.object({
  updatedAt: isoDateTimeSchema,
  equity: dec,
  available: dec,
  marginInUsePct: dec.nullable(),
  marginInUse: dec,
  unrealizedPnl: dec,
  unpriced: z.array(z.string()),
  holdings: z.array(
    z.object({
      coin: z.string(),
      total: dec,
      available: dec,
      inOrders: dec,
      value: dec.nullable(),
    }),
  ),
  positions: z.array(
    z.object({
      market: z.string(),
      side: z.enum(["long", "short"]),
      size: dec,
      entryPrice: dec,
      markPrice: dec.nullable(),
      unrealizedPnl: dec,
      leverage: z.number(),
      marginMode: z.enum(["cross", "isolated"]),
      liquidationPrice: dec.nullable(),
      notional: dec.nullable(),
    }),
  ),
  pendingOrders: z.object({ count: z.number().int(), lockedQuote: dec }),
  /** Coin Spot định giá bằng index price của SoDEX (`B[].px`), không có market riêng. */
  indexPriced: z.array(z.string()).default([]),
  /** Số dư theo engine (UI_REVIEW I3, DEC-58); `equity` / `available` vẫn là tổng hai khối. */
  accounts: z.object({
    spot: z.object({
      value: dec,
      available: dec,
      inOrders: dec,
      unpricedCoins: z.array(z.string()),
    }),
    perps: z
      .object({
        accountValue: dec,
        availableMargin: dec,
        availableIsolated: dec.nullable(),
        marginInUse: dec,
        unrealizedPnl: dec,
        openPositions: z.number().int(),
        collateral: z.array(
          z.object({
            asset: z.string(),
            balance: dec,
            indexPrice: dec.nullable(),
            value: dec.nullable(),
            collateralRatio: dec.nullable(),
            marginValue: dec.nullable(),
          }),
        ),
      })
      .nullable(),
  }),
});
export type PortfolioView = z.infer<typeof portfolioViewSchema>;
export const portfolioResponseSchema = z.object({ portfolio: portfolioViewSchema.nullable() });

export const riskLimitKeys = [
  "dailyLossPct",
  "maxDrawdownPct",
  "perTradePct",
  "maxLeverage",
  "maxPositions",
] as const;
export type RiskLimitKey = (typeof riskLimitKeys)[number];

export const riskViewSchema = z.object({
  checkedAt: isoDateTimeSchema.nullable(),
  limits: z.object({
    dailyLossPct: dec.nullable(),
    maxDrawdownPct: dec.nullable(),
    perTradePct: dec.nullable(),
    maxLeverage: dec.nullable(),
    maxPositions: z.number().int().nullable(),
  }),
  enforced: z.record(z.string(), z.boolean()),
  status: z.object({
    dailyLossPct: dec.nullable(),
    drawdownPct: dec.nullable(),
    peakEquity: dec.nullable(),
    peakAt: z.number().int().nullable(),
    equity: dec.nullable(),
    highestLeverage: z.object({ market: z.string(), leverage: z.number() }).nullable(),
    openPositions: z.number().int().nullable(),
    largestOrderTodayPct: dec.nullable(),
  }),
  alerts: z.array(
    z.object({
      id: uuidSchema,
      kind: z.string(),
      severity: z.enum(["notice", "warning", "critical"]),
      data: z.record(z.string(), z.unknown()),
      occurredAt: isoDateTimeSchema,
      acknowledgedAt: isoDateTimeSchema.nullable(),
      resolvedAt: isoDateTimeSchema.nullable(),
    }),
  ),
  halt: z.object({
    running: z.number().int(),
    paused: z.number().int(),
    openOrders: z.number().int(),
    positions: z.number().int().nullable(),
  }),
});
export type RiskView = z.infer<typeof riskViewSchema>;

export const riskLimitsBodySchema = z.object({
  key: z.enum(riskLimitKeys),
  /** null = bỏ giới hạn. */
  value: dec.nullable(),
});

export const overviewViewSchema = z.object({
  portfolio: portfolioViewSchema.nullable(),
  equityCurve: z.array(z.object({ at: z.number().int(), equity: dec })),
  realizedPnl: dec.nullable(),
  realizedSince: z.number().int(),
  risk: riskViewSchema.shape.status
    .extend({ limits: riskViewSchema.shape.limits, breached: z.number().int() })
    .nullable(),
  bots: z.array(botSummarySchema),
  activity: z.array(
    z.object({
      id: uuidSchema,
      botId: uuidSchema,
      botName: z.string(),
      type: z.string(),
      decision: z.string().nullable(),
      why: z.string().nullable(),
      occurredAt: isoDateTimeSchema,
    }),
  ),
  watchlist: z.array(
    z.object({
      market: z.string(),
      engine: z.enum(["spot", "perps"]),
      /** Perps: mark price; Spot: giá gần nhất. null = không đọc được, dòng vẫn hiện "Not available". */
      price: dec.nullable(),
      change24hPct: dec.nullable(),
      /** Giá đóng của các nến 1h trong 24h qua (cũ → mới), cho sparkline; rỗng khi không đọc được. */
      spark: z.array(dec).default([]),
    }),
  ),
});
export type OverviewView = z.infer<typeof overviewViewSchema>;

export const analystViewSchema = z.object({
  briefing: z.string().nullable(),
  basis: z.string(),
  insights: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      subject: z.string(),
      attention: z.boolean(),
      observed: z.string(),
      interpretation: z.string(),
      check: z.string(),
      sources: z.string(),
      link: z
        .object({ kind: z.enum(["portfolio", "bot", "orders"]), botId: z.string().optional() })
        .nullable(),
    }),
  ),
  notEnough: z.object({ observed: z.string(), progress: z.string() }).nullable(),
});
export type AnalystView = z.infer<typeof analystViewSchema>;

export const builderRevenueViewSchema = z.object({
  builderId: z.string(),
  balances: z.object({
    spot: dec.nullable(),
    perps: dec.nullable(),
    at: isoDateTimeSchema.nullable(),
  }),
  period: z.string(),
  totals: z.object({
    recognized: dec,
    perps: dec,
    spot: dec,
    fills: z.number().int(),
    notional: dec,
    effectivePct: dec.nullable(),
  }),
  days: z.array(
    z.object({
      date: z.string(),
      engine: z.enum(["spot", "perps"]),
      fromFills: dec,
      balanceDelta: dec.nullable(),
      difference: dec.nullable(),
      status: z.enum(["matched", "pending"]),
    }),
  ),
  approvals: z.object({
    approved: z.number().int(),
    revoked: z.number().int(),
    never: z.number().int(),
  }),
});
export type BuilderRevenueView = z.infer<typeof builderRevenueViewSchema>;

/** Users (chỉ role `team`, chỉ đọc; DEC-64). Không có thao tác đổi role / khoá / xoá trong v1. */
export const adminUsersQuerySchema = z.object({
  q: z.string().trim().max(200).default(""),
  page: z.coerce.number().int().min(1).default(1),
});
export const adminUsersViewSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      email: z.string(),
      role: z.enum(["user", "team"]),
      createdAt: isoDateTimeSchema,
      twoFactor: z.boolean(),
      sodex: z
        .object({
          address: z.string(),
          accountId: z.string(),
          status: z.enum(["connecting", "connected", "disconnected"]),
        })
        .nullable(),
      /** `null` = chưa kết nối SoDEX; `never` = đã kết nối nhưng chưa có approval nào đọc lại được. */
      builderFee: z.enum(["approved", "revoked", "never", "exempt"]).nullable(),
      bots: z.object({ running: z.number().int(), total: z.number().int() }),
      /** Số dư gần nhất từ equity snapshot; null khi chưa có. */
      equity: decimalStringSchema.nullable(),
      /** Tổng khối lượng lệnh bot đã khớp, gồm cả mở và đóng. */
      volume: decimalStringSchema,
      /** Admin đã bật bot khối lượng (Volume Maker, Volume Farm) cho tài khoản này (DEC-80). */
      volumeBots: z.boolean(),
      /** Admin đã bật AI Desk cho tài khoản này (DEC-105). */
      aiDesk: z.boolean().default(false),
      /** Team chưa tắt AI Adaptive DCA (Beta) cho tài khoản này (DEC-218). */
      adaptiveDca: z.boolean().default(true),
      /** #423: team đã bật Signal Research (BETA) cho tài khoản này; mặc định tắt. */
      signalResearch: z.boolean().default(false),
    }),
  ),
  total: z.number().int(),
  page: z.number().int(),
  pageSize: z.number().int(),
});
export type AdminUsersView = z.infer<typeof adminUsersViewSchema>;

/** Một dòng builder fee của user (DEC-159), phần mười bp: 10 = 0.01%. */
export const builderFeeRowSchema = z.object({
  strategy: z.enum(BOT_STRATEGIES),
  defaultRate: z.number().int(),
  rate: z.number().int(),
  /** Team đã đặt mức riêng (có thể bằng mặc định). */
  custom: z.boolean(),
});
export type BuilderFeeRow = z.infer<typeof builderFeeRowSchema>;

/**
 * Chi tiết một user cho team (chỉ đọc, DEC-93). Volume = Σ giá × khối lượng các lệnh bot đã khớp, gồm cả mở và
 * đóng; số dư lấy từ equity snapshot, không gọi SoDEX. Mọi lần xem đều ghi audit.
 */
export const adminUserDetailSchema = z.object({
  user: adminUsersViewSchema.shape.items.element.extend({
    /** Lần dùng phiên gần nhất. */
    lastSeenAt: isoDateTimeSchema.nullable(),
  }),
  stats: z.object({
    equityAt: isoDateTimeSchema.nullable(),
    volume24h: decimalStringSchema,
    volume7d: decimalStringSchema,
    volumeAll: decimalStringSchema,
    fills: z.number().int(),
    builderFees: decimalStringSchema,
    /** Σ PnL của các bot có dữ liệu, gồm cả bot đã lưu trữ. */
    botProfit: decimalStringSchema,
  }),
  bots: z.array(
    botSummarySchema.extend({
      /** Chi phí trên mỗi 1 triệu USD khối lượng (Market Making); null với chiến lược khác hoặc khi chưa có khối lượng. */
      costPerMillion: decimalStringSchema.nullable(),
    }),
  ),
  /** Builder fee theo chiến lược của user (DEC-159). */
  builderFees: z.array(builderFeeRowSchema),
  /** Lịch sử kết nối SoDEX (DEC-114): bước phía trình duyệt và yêu cầu chữ ký phía server, mới nhất trước. */
  connect: z.object({
    events: z.array(connectEventViewSchema),
    requests: z.array(
      z.object({
        action: z.string(),
        status: z.string(),
        sodexError: z.string().nullable(),
        at: isoDateTimeSchema,
      }),
    ),
  }),
  orders: z.array(
    z.object({
      id: uuidSchema,
      botName: z.string(),
      market: z.string(),
      side: z.enum(["buy", "sell"]),
      type: z.enum(["limit", "market"]),
      price: decimalStringSchema.nullable(),
      size: decimalStringSchema,
      filledSize: decimalStringSchema,
      status: z.string(),
      at: isoDateTimeSchema,
    }),
  ),
});
export type AdminUserDetail = z.infer<typeof adminUserDetailSchema>;

/** Team bật / tắt bot khối lượng cho một user (DEC-80). Tắt thì bot khối lượng đang chạy được pause. */
export const adminVolumeBotsBodySchema = z.object({ enabled: z.boolean() });
export type AdminVolumeBotsBody = z.input<typeof adminVolumeBotsBodySchema>;
export const adminVolumeBotsSchema = z.object({
  volumeBots: z.boolean(),
  /** Số bot khối lượng đang chạy được chuyển sang Pausing khi tắt. */
  paused: z.number().int(),
});
export type AdminVolumeBots = z.infer<typeof adminVolumeBotsSchema>;

/** Team đặt builder fee riêng cho một chiến lược của user; `rate: null` = về mặc định (DEC-159). */
export const adminBuilderFeeBodySchema = z.object({
  strategy: z.enum(BOT_STRATEGIES),
  rate: z
    .number()
    .int({ message: "Use steps of 0.001%." })
    .min(0, { message: "Allowed 0–0.01%." })
    .max(10, { message: "Allowed 0–0.01%." })
    .nullable(),
});
export type AdminBuilderFeeBody = z.input<typeof adminBuilderFeeBodySchema>;
export const adminBuilderFeeSchema = z.object({
  builderFees: z.array(builderFeeRowSchema),
  /** Số bot đang chạy của chiến lược đó được ghi một dòng Decisions. */
  notified: z.number().int(),
});
export type AdminBuilderFee = z.infer<typeof adminBuilderFeeSchema>;

/** Team bật / tắt AI Desk cho một user (DEC-105). Tắt không dừng bot nào; chỉ ẩn AI Desk. */
export const adminAiDeskBodySchema = z.object({ enabled: z.boolean() });
export const adminAiDeskSchema = z.object({ aiDesk: z.boolean() });
export type AdminAiDesk = z.infer<typeof adminAiDeskSchema>;

/** #423: team bật / tắt Signal Research (BETA) cho một user. Tắt: mục biến mất khỏi menu, API trả 403, version đang chạy tự pause. */
export const adminSignalResearchBodySchema = z.object({ enabled: z.boolean() });
export const adminSignalResearchSchema = z.object({
  signalResearch: z.boolean(),
  /** Số version đang chạy của user được pause khi tắt cờ (PM review #428); bật cờ thì 0 (không tự resume). */
  paused: z.number().int(),
});
export type AdminSignalResearch = z.infer<typeof adminSignalResearchSchema>;

/** Team bật / tắt AI Adaptive DCA (Beta) cho một user (DEC-218). Tắt: bot đang chạy chuyển sang Pausing. */
export const adminAdaptiveDcaBodySchema = z.object({ enabled: z.boolean() });
export const adminAdaptiveDcaSchema = z.object({
  adaptiveDca: z.boolean(),
  paused: z.number().int(),
});
export type AdminAdaptiveDca = z.infer<typeof adminAdaptiveDcaSchema>;

/** Team đặt lại mật khẩu cho một user (DEC-77): cần 2FA của người thao tác. */
export const adminResetPasswordBodySchema = z.object({ twoFactorCode: twoFactorCodeSchema });
export type AdminResetPasswordBody = z.input<typeof adminResetPasswordBodySchema>;
/** Mật khẩu tạm chỉ trả về đúng một lần, không lưu ở đâu khác ngoài hash. */
export const adminResetPasswordSchema = z.object({
  email: z.string(),
  temporaryPassword: z.string(),
});
export type AdminResetPassword = z.infer<typeof adminResetPasswordSchema>;

/** Watchlist của Overview (UI_REVIEW M2, DEC-74). Thứ tự trong mảng là thứ tự hiển thị. */
export const WATCHLIST_MAX = 8;
export const watchlistEntrySchema = z.object({
  market: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/),
  engine: z.enum(["spot", "perps"]),
});
export type WatchlistEntry = z.infer<typeof watchlistEntrySchema>;
export const watchlistSchema = z.object({ items: z.array(watchlistEntrySchema) });
export type Watchlist = z.infer<typeof watchlistSchema>;
export const watchlistBodySchema = z.object({
  items: z
    .array(watchlistEntrySchema)
    .max(WATCHLIST_MAX)
    .refine((xs) => new Set(xs.map((x) => x.market)).size === xs.length, {
      message: "Duplicate market.",
    }),
});

// ─── Platform Stats (DEC-98, chỉ role `team`) ────────────────────────────────

/** Một ngày trong chart thống kê nền tảng. */
export const platformStatsDaySchema = z.object({
  date: z.string(), // YYYY-MM-DD
  newUsers: z.number().int(),
  volume: z.string(), // notional (price × size), tổng của ngày
  fees: z.string(), // builder fee, tổng của ngày
});
export type PlatformStatsDay = z.infer<typeof platformStatsDaySchema>;

/** Bước của phễu kích hoạt (DEC-139): user khác nhau đã tới bước đó (mọi thời gian). */
export const ACTIVATION_STEPS = [
  "signedUp",
  "connected",
  "approved",
  "firstBot",
  "firstFill",
  "active7d",
] as const;
export type ActivationStep = (typeof ACTIVATION_STEPS)[number];

/** Insight tự sinh từ số liệu (DEC-139): `key` + `params` để UI dịch; sắp theo mức độ. */
export const statsInsightSchema = z.object({
  severity: z.enum(["critical", "warning", "info", "good"]),
  key: z.string(),
  params: z.record(z.string(), z.union([z.string(), z.number()])),
});
export type StatsInsight = z.infer<typeof statsInsightSchema>;

/** Phần tổng quan có so sánh kỳ trước, phễu, theo strategy, lý do dừng, sức khoẻ, insight (DEC-139). */
export const platformOverviewSchema = z.object({
  kpis: z.object({
    activeUsers: z.object({ cur: z.number().int(), prev: z.number().int() }),
    volume: z.object({ cur: z.string(), prev: z.string() }),
    revenue: z.object({ cur: z.string(), prev: z.string() }),
    /** Builder fee thực thu mỗi $1M volume trong kỳ; null khi chưa có volume. */
    revenuePerMillion: z.string().nullable(),
    /** % volume trong kỳ không thu builder fee (account builder được miễn, hoặc fill thiếu builder fee). */
    unchargedVolumePct: z.number().nullable(),
  }),
  activation: z.array(z.object({ step: z.enum(ACTIVATION_STEPS), users: z.number().int() })),
  strategies: z.array(
    z.object({
      strategy: z.string(),
      bots: z.number().int(),
      running: z.number().int(),
      volume: z.string(),
      feePerMillion: z.string().nullable(),
      /**
       * Net cost / $1M trong kỳ (DEC-296): max(0, −net PnL) ÷ volume × 1e6, cùng helper với trang bot
       * (`netCostPerMillion`). Net PnL = thay đổi lãi ròng (giá đã chốt + chưa chốt − phí, gồm builder fee) của bot thật
       * trong kỳ. Lãi → "0". null khi chưa có volume hoặc thiếu giá để định giá vị thế.
       */
      netCostPerMillion: z.string().nullable(),
      ordersPlaced: z.number().int(),
      fillRatePct: z.number().nullable(),
      rejectRatePct: z.number().nullable(),
    }),
  ),
  stops: z.array(z.object({ reason: z.string().nullable(), bots: z.number().int() })),
  /**
   * Builder fee thật (`fills.builder_fee`) trong kỳ theo strategy × mức đã thu (DEC-296), chỉ cho team, không
   * có user. `rate` = builder fee ÷ notional theo phần mười bp (làm tròn); `source`: `default` = đúng mức mặc định của
   * strategy, `tier` = một bậc volume (DEC-258), `custom` = mức khác (team đặt tay, DEC-159), `none` = fill không thu
   * builder fee (account builder được miễn, hoặc SoDEX không trả). Suy từ mức đã thu, không từ bảng mức hiện tại.
   */
  builderFeeSources: z.array(
    z.object({
      strategy: z.string(),
      source: z.enum(["default", "tier", "custom", "none"]),
      rate: z.number().int().nullable(),
      volume: z.string(),
      builderFees: z.string(),
    }),
  ),
  health: z.object({
    /** Giây kể từ giá BTC-USD gần nhất của marketdata; null khi không có. */
    priceAgeSec: z.number().nullable(),
    needsAttention: z.number().int(),
    rejected24h: z.number().int(),
    lastFillAt: z.string().nullable(),
  }),
  insights: z.array(statsInsightSchema),
});
export type PlatformOverview = z.infer<typeof platformOverviewSchema>;

/** Mục MCP ở Stats (DEC-225): chỉ số đếm thật từ `mcp_tokens` / `mcp_calls`. */
export const mcpPlatformStatsSchema = z.object({
  /** User có token MCP còn refresh được (chưa thu hồi, chưa hết hạn). */
  connectedUsers: z.number().int(),
  calls24h: z.number().int(),
  byTool24h: z.array(
    z.object({ tool: z.string(), calls: z.number().int(), errors: z.number().int() }),
  ),
  /** Phần trăm trên mọi dòng `mcp_calls` 24h; null khi không có dòng nào ("Not available"). */
  deniedPct24h: z.string().nullable(),
  rateLimitedPct24h: z.string().nullable(),
});
export type McpPlatformStats = z.infer<typeof mcpPlatformStatsSchema>;

export const platformStatsSchema = z.object({
  /** Số ngày được truy vấn (7 | 30 | 90). */
  period: z.number().int(),
  /** ISO timestamp của lúc chạy query. */
  snapshotAt: z.string(),
  users: z.object({
    total: z.number().int(),
    connected: z.number().int(),
    new24h: z.number().int(),
    new7d: z.number().int(),
    new30d: z.number().int(),
  }),
  volume: z.object({
    total: z.string(),
    h24: z.string(),
    d7: z.string(),
    d30: z.string(),
  }),
  fees: z.object({
    total: z.string(),
    h24: z.string(),
    d7: z.string(),
    d30: z.string(),
  }),
  bots: z.object({
    total: z.number().int(),
    running: z.number().int(),
    created24h: z.number().int(),
  }),
  /** Dữ liệu theo ngày trong `period` ngày gần nhất. */
  daily: z.array(platformStatsDaySchema),
  /** Màn Connect SoDEX trong `period` ngày (DEC-114): số user ở từng bước, lỗi hay gặp, thiết bị. */
  connect: z.object({
    steps: z.array(z.object({ type: z.string(), users: z.number().int() })),
    failures: z.array(z.object({ type: z.string(), reason: z.string(), users: z.number().int() })),
    devices: z.array(z.object({ device: z.string(), users: z.number().int() })),
  }),
  overview: platformOverviewSchema,
  mcp: mcpPlatformStatsSchema,
});
export type PlatformStats = z.infer<typeof platformStatsSchema>;

export const platformStatsQuerySchema = z.object({
  period: z.coerce.number().int().min(7).max(90).default(30),
});
export type PlatformStatsQuery = z.infer<typeof platformStatsQuerySchema>;

/**
 * Trang Bot Monitor của team (tên cũ "Ops"; docs/mockups/ops, DEC-288, thay bố cục DEC-276). Mọi số không
 * tính được là null (UI: "Not available" / "n/a"), không bao giờ 0 thay cho "không biết".
 */
export const TEAM_OPS_STRATEGIES = ["volume_maker", "volume_farm"] as const;
export const teamOpsQuerySchema = z.object({
  /** Active (mặc định) hoặc All bots (phân trang trong SQL, theo từng chiến lược). */
  show: z.enum(["active", "all"]).default("active"),
  /** Chỉ dùng ở All bots: tab đang xem. */
  strategy: z.enum(TEAM_OPS_STRATEGIES).default("volume_maker"),
  /** Chỉ dùng ở All bots: tìm theo tên bot, market hoặc user id. */
  q: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().min(1).max(100_000).default(1),
});
export type TeamOpsQuery = z.infer<typeof teamOpsQuerySchema>;

export const teamOpsReasonSchema = z.object({
  code: z.enum(OPS_REASON_CODES),
  invariant: z.string().optional(),
  detail: z.string().optional(),
  value: dec.optional(),
  median: dec.optional(),
  count: z.number().int().optional(),
  at: isoDateTimeSchema.nullable().optional(),
  until: isoDateTimeSchema.optional(),
});

const countSchema = z.number().int().nonnegative();

export const teamOpsBotSchema = z.object({
  botId: uuidSchema,
  /** Chủ bot: link sang trang admin của user (route của bot chỉ chủ bot mở được). */
  userId: uuidSchema,
  name: z.string(),
  strategy: z.enum(TEAM_OPS_STRATEGIES),
  market: z.string(),
  state: z.string(),
  reasonCode: z.string().nullable(),
  createdAt: isoDateTimeSchema,
  /** Mốc stopping / stopped gần nhất từ outbox `user.<account>.bot` (7 ngày); null khi không có. */
  stopAt: isoDateTimeSchema.nullable(),
  health: z.enum(OPS_HEALTH),
  reasons: z.array(teamOpsReasonSchema),
  /** Cost / $1M: 24 giờ fill (công thức Market hours) hoặc, với bot không chạy ở All bots, cả đợt chạy (bot_runtime). */
  costPerMillion: dec.nullable(),
  costScope: z.enum(["day", "lifetime"]),
  /** Σ giá × khối lượng fill trong 60 phút / 24 giờ (USDC); null khi không có fill. */
  volumeHour: dec.nullable(),
  volumeDay: dec.nullable(),
  /** Tỷ lệ notional khớp maker trong 24 giờ, 0–100; fill chưa rõ maker / taker bỏ khỏi cả tử lẫn mẫu. */
  makerSharePct: dec.nullable(),
  /** Market Making: Smart quoting bật trong cấu hình đang chạy; null với Volume Builder hoặc thiếu cấu hình. */
  smartQuoting: z.boolean().nullable(),
  /** Từ dòng "Order requests" gần nhất (≤ 5 phút), quy về mỗi phút. */
  requestsPerMinute: dec.nullable(),
  /** Khoảng dài nhất giữa hai lần xét báo giá trong 60 phút (giây). */
  maxQuoteGapSec: dec.nullable(),
  positionCutsDay: countSchema,
  positionCutsHour: countSchema,
  untrackedCancels: countSchema,
  /** |vị thế| × mid ÷ max inventory × 100, từ bot_runtime; null khi thiếu số. */
  positionPct: dec.nullable(),
  /** Cảnh báo bất biến mới nhất trong 7 ngày (DEC-274): đang sai, hoặc đã hết sai. */
  alert: z
    .object({
      invariant: z.string(),
      status: z.enum(["active", "resolved"]),
      /** active: lúc bắt đầu sai; resolved: lúc hết sai. */
      at: isoDateTimeSchema,
      detail: z.string(),
    })
    .nullable(),
  /** Volume Builder (24 giờ, từ Decisions và lệnh); null với Market Making. */
  vb: z
    .object({
      rounds: countSchema,
      /** Số lượt có price PnL > 0, trước phí (DEC-129). */
      roundsWon: countSchema,
      /** Trung bình "net … USDC after fees"; null khi không có lượt. */
      avgNet: dec.nullable(),
      entriesPostOnly: countSchema,
      entriesMarket: countSchema,
      /** "Market orders after" của cấu hình: null = chỉ post-only (không bật taker) hoặc thiếu cấu hình. */
      takerAfter: z.number().int().nullable(),
      exits: z.object({
        takeProfit: countSchema,
        earlyProfit: countSchema,
        holdEnded: countSchema,
        maxHold: countSchema,
        botStop: countSchema,
        sodexStop: countSchema,
      }),
      waits: z.object({
        counterTrend: countSchema,
        spread: countSchema,
        sideways: countSchema,
        stale: countSchema,
        belowMinimum: countSchema,
        blockedHour: countSchema,
      }),
      marketRejects: countSchema,
    })
    .nullable(),
  /**
   * 5 quyết định / cảnh báo gần nhất trong 7 ngày, mới nhất trước; bỏ dòng "Order requests". Dòng cảnh báo: `name` là
   * mã bất biến (P1…), `alert` là failing / resolved; dòng Decisions: `alert` null.
   */
  log: z.array(
    z.object({
      at: isoDateTimeSchema,
      name: z.string(),
      why: z.string().nullable(),
      alert: z.enum(["failing", "resolved"]).nullable(),
    }),
  ),
});

const teamOpsStrategySummarySchema = z.object({
  running: countSchema,
  paused: countSchema,
  stopping: countSchema,
  stoppedDay: countSchema,
  volumeHour: dec.nullable(),
  volumeDay: dec.nullable(),
  costPerMillion: dec.nullable(),
  makerSharePct: dec.nullable(),
  rounds: countSchema,
  roundsWonPct: dec.nullable(),
});

export const teamOpsViewSchema = z.object({
  checkedAt: isoDateTimeSchema,
  show: z.enum(["active", "all"]),
  /** Ô tóm tắt luôn tính trên nhóm Active (bot đang có mặt), kể cả khi xem All bots. */
  summary: z.object({
    total: teamOpsStrategySummarySchema,
    volume_maker: teamOpsStrategySummarySchema,
    volume_farm: teamOpsStrategySummarySchema,
    alerts: z.array(z.object({ botId: uuidSchema, name: z.string(), invariant: z.string() })),
    alertBots: countSchema,
    problem: countSchema,
    check: countSchema,
  }),
  /** "Look at these first": bot Problem rồi Check của nhóm Active. */
  attention: z.array(teamOpsBotSchema),
  /** Active: mọi bot của nhóm Active (cả hai chiến lược). All bots: một trang của chiến lược đang xem. */
  bots: z.array(teamOpsBotSchema),
  /** Số bot mỗi tab: Active = số hàng; All bots = tổng khớp tìm kiếm. */
  counts: z.object({ volume_maker: countSchema, volume_farm: countSchema }),
  page: z
    .object({
      strategy: z.enum(TEAM_OPS_STRATEGIES),
      page: z.number().int().min(1),
      pageSize: z.number().int().min(1),
      total: countSchema,
    })
    .nullable(),
});
export type TeamOpsView = z.infer<typeof teamOpsViewSchema>;
export type TeamOpsBot = z.infer<typeof teamOpsBotSchema>;

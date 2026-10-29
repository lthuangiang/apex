import { z } from "zod";

import { decimalStringSchema, isoDateTimeSchema, uuidSchema } from "../schemas";

import { botSummarySchema } from "./bots";

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
    }),
  ),
  total: z.number().int(),
  page: z.number().int(),
  pageSize: z.number().int(),
});
export type AdminUsersView = z.infer<typeof adminUsersViewSchema>;

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

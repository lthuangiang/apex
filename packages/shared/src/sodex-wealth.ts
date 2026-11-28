import { z } from "zod";

import { decimalStringSchema } from "./schemas";

// SoDEX Wealth API công khai (DEC-402 mục 2, #589): https://mainnet-gw.sodex.dev/api/v1/wealth. Chỉ đọc, không token,
// không chữ ký. Server đọc qua `WealthReadClient` (packages/sodex); response parse ở đây. Trường theo tài liệu
// docs.sodex.com › Wealth API và response thật đọc ngày 2026-11-28 (địa chỉ zero). Trường tài liệu ghi "optional" hoặc
// chưa thấy trong dữ liệu thật đều để nullish; trường lạ bị zod bỏ. Một số trường số trả chuỗi rỗng ("") khi chưa có
// giá trị (`tvl.settledValue`, `chainConfig.minDeposit`…): chuỗi rỗng đọc thành null, không bao giờ thành "0".

/** Gateway Wealth mặc định (mainnet). */
export const SODEX_WEALTH_DEFAULT_ORIGIN = "https://mainnet-gw.sodex.dev";

/** Envelope: `code` 0 = thành công kèm `data`; `code` -1 = lỗi kèm `error` (HTTP vẫn 200). */
export const wealthEnvelopeSchema = z.object({
  code: z.number(),
  timestamp: z.number().optional(),
  data: z.unknown().optional(),
  error: z.string().optional(),
});

/** Số thập phân dạng chuỗi; "" hoặc thiếu → null. Chuỗi không phải số → lỗi schema (không đoán). */
export const wealthDecimalSchema = z
  .union([decimalStringSchema, z.literal("")])
  .nullish()
  .transform((v) => (v === "" || v === undefined || v === null ? null : v));

const optStr = z
  .string()
  .nullish()
  .transform((v) => (v === undefined || v === null || v === "" ? null : v));
const optInt = z
  .number()
  .int()
  .nullish()
  .transform((v) => v ?? null);
const optBool = z
  .boolean()
  .nullish()
  .transform((v) => v ?? null);

export const wealthShareSchema = z.object({
  coin: z.string(),
  address: z.string().nullish(),
  decimals: z.number().int().nullish(),
});

/** Cặp spot của quỹ order book (`fundType = clob`). */
export const wealthSpotSchema = z.object({
  symbol: z.string(),
  symbolId: z.number().int().nullish(),
  displayName: z.string().nullish(),
  quote: z.object({ coin: z.string(), decimals: z.number().int().nullish() }).nullish(),
});

/** `GET /funds` (một phần tử). `nav` thiếu với quỹ clob / bridged chưa có NAV; `aum` chỉ có với escrow vault. */
export const wealthFundSchema = z.object({
  fundId: z.string().min(1),
  name: z.string(),
  /** `escrow_vault`, `clob`, `bridged_vault`; thấy thêm `ssi-v2` trong dữ liệu thật. Để chuỗi tự do. */
  fundType: z.string(),
  /** `subscription` hoặc `live`. */
  fundStatus: z.string(),
  iconUrl: optStr,
  tagline: optStr,
  nav: wealthDecimalSchema,
  aum: wealthDecimalSchema,
  asOf: optStr,
  share: wealthShareSchema.nullish(),
  spot: wealthSpotSchema.nullish(),
});
export type WealthFund = z.infer<typeof wealthFundSchema>;
export const wealthFundsSchema = z.array(wealthFundSchema);

/** `GET /funds/{fundId}`: thêm mô tả, cấu hình on-chain, cửa sổ subscription. */
export const wealthFundInfoSchema = wealthFundSchema.extend({
  description: optStr,
  issuerName: optStr,
  inceptionDate: optStr,
  chainConfig: z
    .object({
      assetDecimals: optInt,
      minDeposit: wealthDecimalSchema,
      minRedeemShares: wealthDecimalSchema,
      paused: optBool,
    })
    .nullish(),
  subscription: z
    .object({
      subscribeDeadline: optInt,
      unsubscribeDeadline: optInt,
      totalSubscribed: wealthDecimalSchema,
      minimumSubscribeAmount: wealthDecimalSchema,
    })
    .nullish(),
});
export type WealthFundInfo = z.infer<typeof wealthFundInfoSchema>;

/** `GET /funds/{fundId}/trading-status`. Mốc thời gian là giây Unix. */
export const wealthTradingStatusSchema = z.object({
  fundId: z.string(),
  /** Kênh đang mở: `rfq`, `batch`, `clob`, `subscription`, `closed`… Để chuỗi tự do. */
  channel: z.string(),
  closedReason: optStr,
  nextChannel: optStr,
  nextChannelAt: optInt,
  sessionMode: optStr,
  rfq: z.object({ quotable: optBool, pausedByMaker: optBool }).nullish(),
  batch: z.object({ opensAt: optInt, cutoffAt: optInt, expectedDeliveryAt: optInt }).nullish(),
});
export type WealthTradingStatus = z.infer<typeof wealthTradingStatusSchema>;

/** `GET /users/{address}/positions` (một dòng). Số lượng share là chuỗi thập phân đầy đủ. */
export const wealthPositionSchema = z.object({
  fundId: z.string(),
  name: optStr,
  source: optStr,
  coin: optStr,
  share: wealthShareSchema.nullish(),
  spot: wealthSpotSchema.nullish(),
  pendingRedeemShares: wealthDecimalSchema,
  pendingDepositShares: wealthDecimalSchema,
  processingCost: wealthDecimalSchema,
  pendingProceeds: wealthDecimalSchema,
  costBasis: wealthDecimalSchema,
  ledgerShares: wealthDecimalSchema,
  avgCost: wealthDecimalSchema,
  avgCostWithAirdrop: wealthDecimalSchema,
  completedCost: wealthDecimalSchema,
  redeemedShares: wealthDecimalSchema,
});
export const wealthPositionsSchema = z.object({
  summary: z
    .object({
      processingCost: wealthDecimalSchema,
      pendingProceeds: wealthDecimalSchema,
      incomplete: optBool,
    })
    .nullish(),
  positions: z.array(wealthPositionSchema).default([]),
  bridgeStatus: optStr,
});
export type WealthPositions = z.infer<typeof wealthPositionsSchema>;

/** `GET /users/{address}/pnl`. `priced = false` thì các trường theo giá bị bỏ. */
export const wealthPnlPositionSchema = z.object({
  fundId: z.string(),
  source: optStr,
  shares: wealthDecimalSchema,
  avgCostWithAirdrop: wealthDecimalSchema,
  price: wealthDecimalSchema,
  priceAsOf: optStr,
  marketValue: wealthDecimalSchema,
  unrealizedPnl: wealthDecimalSchema,
  realizedPnl: wealthDecimalSchema,
  pnl24h: wealthDecimalSchema,
  priced: optBool,
});
export const wealthPnlSchema = z.object({
  currency: optStr,
  settledValue: wealthDecimalSchema,
  totalCost: wealthDecimalSchema,
  totalPnl: wealthDecimalSchema,
  totalRealizedPnl: wealthDecimalSchema,
  totalUnrealizedPnl: wealthDecimalSchema,
  totalPnl24h: wealthDecimalSchema,
  inFlightValue: wealthDecimalSchema,
  totalValue: wealthDecimalSchema,
  complete: optBool,
  incompleteFunds: z.array(z.string()).nullish(),
  bridgeStatus: optStr,
  positions: z.array(wealthPnlPositionSchema).default([]),
});
export type WealthPnl = z.infer<typeof wealthPnlSchema>;

/** `GET /users/{address}/in-flight`: tiền / share đã đưa mà chưa nhận. Ô bằng 0 bị bỏ. */
export const wealthInFlightSchema = z.object({
  funds: z
    .array(
      z.object({
        fundId: z.string(),
        inFlight: z
          .array(
            z.object({
              kind: z.string(),
              stage: optStr,
              direction: optStr,
              unit: optStr,
              amount: wealthDecimalSchema,
              count: optInt,
            }),
          )
          .default([]),
      }),
    )
    .default([]),
  bridgeStatus: optStr,
});
export type WealthInFlight = z.infer<typeof wealthInFlightSchema>;

/** `GET /users/{address}/fund-details`: sổ cái của ví, mới nhất trước. Trường chưa xác định bị bỏ (khác "0"). */
export const wealthFundEntrySchema = z.object({
  fundId: z.string(),
  /** Định danh dòng phía SoDEX, "khi có" (tài liệu: optional). #594 dùng làm khoá chống trùng; thiếu thì tự dựng khoá. */
  entryId: optStr,
  kind: z.string(),
  status: z.string(),
  transactionType: optStr,
  channel: optStr,
  source: optStr,
  requestedAt: optStr,
  at: optStr,
  shares: wealthDecimalSchema,
  requestedShares: wealthDecimalSchema,
  proceeds: wealthDecimalSchema,
  cost: wealthDecimalSchema,
  costEstimated: optBool,
  planIndex: optStr,
});
export const wealthFundDetailsSchema = z.object({
  totals: z
    .array(
      z.object({
        fundId: z.string(),
        shares: wealthDecimalSchema,
        pendingRedeemShares: wealthDecimalSchema,
        pendingDepositShares: wealthDecimalSchema,
        costBasis: wealthDecimalSchema,
        avgCost: wealthDecimalSchema,
      }),
    )
    .default([]),
  entries: z.array(wealthFundEntrySchema).default([]),
  bridgeStatus: optStr,
});
export type WealthFundDetails = z.infer<typeof wealthFundDetailsSchema>;

/** `GET /users/{address}/recurring-buys`. Ngày 2026-11-28 gateway trả `code -1 internal error` cho ví rỗng. */
export const wealthRecurringPlanSchema = z.object({
  planIndex: z.union([z.string(), z.number().int()]).transform(String),
  dcaAddress: optStr,
  fundId: optStr,
  target: optStr,
  amount: wealthDecimalSchema,
  /** `DAILY`, `WEEKLY`, `BI_WEEKLY`, `MONTHLY`. */
  planType: optStr,
  dayOfPeriod: optInt,
  createdAt: optStr,
  /** `ACTIVE`, `PAUSED`, `CANCELLED`. */
  status: optStr,
  successfulExecutionCount: optInt,
  nextScheduledAt: optStr,
  totalBuyAmount: wealthDecimalSchema,
  totalBuyShares: wealthDecimalSchema,
  avgCost: wealthDecimalSchema,
  processingAmount: wealthDecimalSchema,
  anomalyCount: optInt,
});
export const wealthRecurringBuysSchema = z.object({
  availableAssets: wealthDecimalSchema,
  plans: z.array(wealthRecurringPlanSchema).default([]),
});
export type WealthRecurringBuys = z.infer<typeof wealthRecurringBuysSchema>;

/** `GET /users/{address}/recurring-buys/{planIndex}/executions`: một dòng mỗi ngày lịch, mới nhất trước. */
export const wealthRecurringExecutionsSchema = z.object({
  planIndex: z.union([z.string(), z.number().int()]).transform(String).nullish(),
  executions: z
    .array(
      z.object({
        scheduledLocalDate: z.string(),
        scheduledAt: optStr,
        status: z.string(),
        reasonCode: optStr,
        amount: wealthDecimalSchema,
        attemptedAt: optStr,
        executedAt: optStr,
      }),
    )
    .default([]),
});
export type WealthRecurringExecutions = z.infer<typeof wealthRecurringExecutionsSchema>;

/** `GET /users/{address}/pnl-history`: cũ nhất trước. */
export const wealthPnlHistorySchema = z.object({
  currency: optStr,
  interval: optStr,
  range: optStr,
  points: z
    .array(
      z.object({
        ts: z.string(),
        pnl: wealthDecimalSchema,
        settledValue: wealthDecimalSchema,
        inFlightValue: wealthDecimalSchema,
        totalValue: wealthDecimalSchema,
        incomplete: optBool,
      }),
    )
    .default([]),
  accountingFrom: optStr,
});
export type WealthPnlHistory = z.infer<typeof wealthPnlHistorySchema>;

/** `GET /users/{address}/tvl`: snapshot theo giờ. `settledValue` rỗng và không có `snapshotAt` = chưa có snapshot. */
export const wealthTvlSchema = z.object({
  currency: optStr,
  settledValue: wealthDecimalSchema,
  snapshotAt: optStr,
  incomplete: optBool,
});
export type WealthTvl = z.infer<typeof wealthTvlSchema>;

export const WEALTH_PNL_HISTORY_INTERVALS = ["1m", "5m", "15m", "1h", "4h", "1d"] as const;
export const WEALTH_PNL_HISTORY_RANGES = ["1W", "1M", "3M", "1Y", "All"] as const;

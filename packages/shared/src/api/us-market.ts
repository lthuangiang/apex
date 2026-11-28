import { z } from "zod";

import { add, dec, mul, type Decimal } from "../money";
import { decimalStringSchema, isoDateTimeSchema } from "../schemas";

// US Market + SoDEX Wealth (DEC-402, #588). Hằng số và hàm thuần dùng chung cho api (#589), engine (#590) và web
// (#591 / #592); schema response của `GET /api/v1/markets/us` và `GET /api/v1/wealth/me`.
// Không bịa số (quy tắc 8): trường không đọc được là null, web hiện "Not provided"; không bao giờ thay bằng "0".

/** Độ sâu = tổng notional (giá × khối lượng, đơn vị quote ≈ USD) của 10 mức giá mỗi phía (DEC-402 mục 4). */
export const DEPTH_LEVELS = 10;
/** Nhãn `Thin`: phía mỏng hơn dưới 10.000 USD. */
export const DEPTH_THIN_USD = "10000";
/** Nhãn `Very thin`: phía mỏng hơn dưới 1.000 USD. */
export const DEPTH_VERY_THIN_USD = "1000";
/** Lần khớp cuối cũ hơn mức này thì không hiện khối lượng ticker mà hiện "Last trade" (DEC-402 mục 3). */
export const LAST_TRADE_STALE_MS = 24 * 60 * 60 * 1000;
/** Cache đọc sổ lệnh / ticker / quỹ của `GET /api/v1/markets/us` (DEC-402 mục 4: 30–60 s). */
export const US_MARKET_CACHE_MS = 30_000;

export const DepthLabel = { ok: "ok", thin: "thin", veryThin: "very_thin" } as const;
export type DepthLabel = (typeof DepthLabel)[keyof typeof DepthLabel];
export const DEPTH_LABELS = [DepthLabel.ok, DepthLabel.thin, DepthLabel.veryThin] as const;

/** Trạng thái sổ lệnh lấy từ dữ liệu thật: `halted` theo `status` symbol; một phía rỗng = `empty`. */
export const BookStatus = { trading: "trading", empty: "empty", halted: "halted" } as const;
export type BookStatus = (typeof BookStatus)[keyof typeof BookStatus];
export const BOOK_STATUSES = [BookStatus.trading, BookStatus.empty, BookStatus.halted] as const;

export type UsMarketEngine = "spot" | "perps";
/** Market Anthropic trên SoDEX (DEC-402 mục 1): perps trước, spot sau, đúng thứ tự bản phác. */
export const US_MARKET_ANTHROPIC: readonly { engine: UsMarketEngine; symbol: string }[] = [
  { engine: "perps", symbol: "ANT-USD" },
  { engine: "spot", symbol: "vANT_vUSDC" },
];

/** Một mức giá của sổ lệnh: [giá, khối lượng] dạng chuỗi thập phân. */
export type DepthBookLevel = readonly [string, string];

/** Tổng notional `levels` mức đầu tiên (mặc định 10). Phía rỗng = "0" (đó là dữ liệu thật, không phải thiếu). */
export function sideNotional(
  levels: readonly DepthBookLevel[],
  max: number = DEPTH_LEVELS,
): string {
  let total: Decimal = dec("0");
  for (const [price, size] of levels.slice(0, max)) total = add(total, mul(price, size));
  return total.toFixed();
}

/** Nhãn theo phía mỏng hơn (DEC-402 mục 4). */
export function depthLabelOf(bidsNotional: string, asksNotional: string): DepthLabel {
  const thinner = minDec(bidsNotional, asksNotional);
  if (thinner.lessThan(dec(DEPTH_VERY_THIN_USD))) return DepthLabel.veryThin;
  if (thinner.lessThan(dec(DEPTH_THIN_USD))) return DepthLabel.thin;
  return DepthLabel.ok;
}

function minDec(a: string, b: string): Decimal {
  const x = dec(a);
  const y = dec(b);
  return x.lessThan(y) ? x : y;
}

/** `halted` khi symbol không ở trạng thái giao dịch; còn lại một phía rỗng = `empty`. */
export function bookStatusOf(input: { halted: boolean; bids: number; asks: number }): BookStatus {
  if (input.halted) return BookStatus.halted;
  if (input.bids === 0 || input.asks === 0) return BookStatus.empty;
  return BookStatus.trading;
}

export const marketDepthSchema = z.object({
  /** Tổng notional 10 mức phía mua (quote, ≈ USD). */
  bidsNotional: decimalStringSchema,
  asksNotional: decimalStringSchema,
  bidLevels: z.number().int().nonnegative(),
  askLevels: z.number().int().nonnegative(),
  label: z.enum(DEPTH_LABELS),
  /**
   * Vị thế tối đa của bot mới (DEC-402 mục 5) = phía mỏng hơn, chỉ khi nhãn `thin` / `very_thin`; null khi sổ đủ sâu
   * (không có giới hạn theo sổ lệnh).
   */
  maxPositionUsd: decimalStringSchema.nullable(),
});
export type MarketDepth = z.infer<typeof marketDepthSchema>;

/** Độ sâu từ sổ lệnh (10 mức mỗi phía). */
export function marketDepthOf(book: {
  bids: readonly DepthBookLevel[];
  asks: readonly DepthBookLevel[];
}): MarketDepth {
  const bidsNotional = sideNotional(book.bids);
  const asksNotional = sideNotional(book.asks);
  const label = depthLabelOf(bidsNotional, asksNotional);
  return {
    bidsNotional,
    asksNotional,
    bidLevels: Math.min(book.bids.length, DEPTH_LEVELS),
    askLevels: Math.min(book.asks.length, DEPTH_LEVELS),
    label,
    maxPositionUsd: label === DepthLabel.ok ? null : minDec(bidsNotional, asksNotional).toFixed(),
  };
}

/**
 * Khối lượng ticker (quote) và lần khớp cuối (`closeTime`, ms). Ticker là của phiên gần nhất, nên khi `closeTime` cũ hơn
 * 24 giờ thì `volume24h` = null và web hiện "Last trade" (DEC-402 mục 3).
 */
export function tickerVolumeOf(
  ticker: { quoteVolume: string | null; closeTime: number | null },
  nowMs: number,
): { volume24h: string | null; lastTradeAt: string | null } {
  if (ticker.closeTime === null) return { volume24h: null, lastTradeAt: null };
  const lastTradeAt = new Date(ticker.closeTime).toISOString();
  const stale = nowMs - ticker.closeTime > LAST_TRADE_STALE_MS;
  return { volume24h: stale ? null : ticker.quoteVolume, lastTradeAt };
}

/** Phần đọc được hoặc không (`not_provided`: gateway lỗi / trả sai dạng). */
export function providedSection<T extends z.ZodType>(item: T) {
  return z.discriminatedUnion("status", [
    z.object({ status: z.literal("ok"), items: z.array(item) }),
    z.object({ status: z.literal("not_provided") }),
  ]);
}

export const usMarketRowSchema = z.object({
  /** Tên symbol SoDEX (`ANT-USD`, `vANT_vUSDC`, `vVOO_vUSDC`). */
  symbol: z.string(),
  engine: z.enum(["spot", "perps"]),
  /** Tên hiển thị SoDEX trả (`ANT/USDC`); null khi không có. */
  displayName: z.string().nullable(),
  /** Quỹ Wealth của token quỹ spot; null với market Anthropic. */
  fundId: z.string().nullable(),
  fundName: z.string().nullable(),
  /** Đòn bẩy tối đa (perps); null với spot. */
  maxLeverage: z.number().int().nullable(),
  lastPrice: decimalStringSchema.nullable(),
  /** Khối lượng quote của ticker; null khi lần khớp cuối cũ hơn 24 giờ hoặc không đọc được. */
  volume24h: decimalStringSchema.nullable(),
  lastTradeAt: isoDateTimeSchema.nullable(),
  /** null = không đọc được sổ lệnh / symbol. */
  bookStatus: z.enum(BOOK_STATUSES).nullable(),
  depth: marketDepthSchema.nullable(),
});
export type UsMarketRow = z.infer<typeof usMarketRowSchema>;

/** Trạng thái nhận lệnh nạp / rút của quỹ (`trading-status`). `open` = kênh khác `closed`. */
export const wealthFundRequestsSchema = z.object({
  channel: z.string(),
  open: z.boolean(),
  closedReason: z.string().nullable(),
  nextChannel: z.string().nullable(),
  nextChannelAt: isoDateTimeSchema.nullable(),
});

export const wealthFundRowSchema = z.object({
  fundId: z.string(),
  name: z.string(),
  fundType: z.string(),
  fundStatus: z.string(),
  nav: decimalStringSchema.nullable(),
  /** Quy mô quỹ (`aum`); null = SoDEX không trả → "Not provided". */
  aum: decimalStringSchema.nullable(),
  asOf: z.string().nullable(),
  /** Cặp spot của token quỹ (quỹ `clob`). */
  spotSymbol: z.string().nullable(),
  /** null = không đọc được `trading-status`. */
  requests: wealthFundRequestsSchema.nullable(),
});
export type WealthFundRow = z.infer<typeof wealthFundRowSchema>;

/** `GET /api/v1/markets/us` (#589). Công tắc `US_MARKET_ENABLED` tắt → 404. */
export const usMarketsResponseSchema = z.object({
  /** Lúc đọc sổ lệnh (đầu chu kỳ cache): web hiện "Order book read N s ago". */
  readAt: isoDateTimeSchema,
  anthropic: z.array(usMarketRowSchema),
  /** Token quỹ US trên sổ spot (quỹ `clob` có `spot`), trạng thái theo dõi. */
  fundTokens: providedSection(usMarketRowSchema),
  /** Quỹ SoDEX Wealth không phải token sổ lệnh (vault / index). */
  funds: providedSection(wealthFundRowSchema),
});
export type UsMarketsResponse = z.infer<typeof usMarketsResponseSchema>;

const nDec = decimalStringSchema.nullable();

/** Tổng của ví (`/users/{address}/pnl`). Trường SoDEX không trả = null. */
export const wealthSummarySchema = z.object({
  currency: z.string().nullable(),
  totalValue: nDec,
  settledValue: nDec,
  totalCost: nDec,
  totalPnl: nDec,
  totalRealizedPnl: nDec,
  totalUnrealizedPnl: nDec,
  totalPnl24h: nDec,
  inFlightValue: nDec,
  /** false khi có quỹ chưa định giá (bị loại khỏi tổng). */
  complete: z.boolean().nullable(),
});
export type WealthSummary = z.infer<typeof wealthSummarySchema>;

export const wealthHoldingSchema = z.object({
  fundId: z.string(),
  name: z.string().nullable(),
  fundType: z.string().nullable(),
  shares: nDec,
  price: nDec,
  marketValue: nDec,
  avgCost: nDec,
  unrealizedPnl: nDec,
  realizedPnl: nDec,
  pnl24h: nDec,
  /** Share đang trong lệnh rút chưa xong (`positions`); null khi không đọc được. */
  pendingRedeemShares: nDec,
  pendingDepositShares: nDec,
  priced: z.boolean().nullable(),
});
export type WealthHolding = z.infer<typeof wealthHoldingSchema>;

export const wealthInFlightRowSchema = z.object({
  fundId: z.string(),
  name: z.string().nullable(),
  kind: z.string(),
  stage: z.string().nullable(),
  direction: z.string().nullable(),
  unit: z.string().nullable(),
  amount: nDec,
  count: z.number().int().nullable(),
});

export const wealthActivityRowSchema = z.object({
  fundId: z.string(),
  name: z.string().nullable(),
  kind: z.string(),
  transactionType: z.string().nullable(),
  status: z.string(),
  at: z.string().nullable(),
  requestedAt: z.string().nullable(),
  shares: nDec,
  cost: nDec,
  proceeds: nDec,
});

export const wealthRecurringBuyRowSchema = z.object({
  planIndex: z.string(),
  fundId: z.string().nullable(),
  name: z.string().nullable(),
  amount: nDec,
  planType: z.string().nullable(),
  status: z.string().nullable(),
  nextScheduledAt: z.string().nullable(),
  successfulExecutionCount: z.number().int().nullable(),
  totalBuyAmount: nDec,
  avgCost: nDec,
});

export const wealthPnlPointSchema = z.object({
  ts: z.string(),
  pnl: nDec,
  totalValue: nDec,
});

/** Số dòng hoạt động tối đa trả về (mới nhất trước). */
export const WEALTH_ACTIVITY_LIMIT = 50;

/**
 * Phần đọc thêm của `GET /api/v1/wealth/me` (#592): mặc định không đọc, chỉ khi `?include=recurringBuys,pnlHistory`
 * (mỗi phần thêm một lời gọi Wealth, weight 20 theo giả định chưa đo).
 */
export const WEALTH_ME_INCLUDES = ["recurringBuys", "pnlHistory"] as const;
export type WealthMeInclude = (typeof WEALTH_ME_INCLUDES)[number];

/** Query `include` (danh sách cách nhau bằng dấu phẩy); giá trị lạ → 400. Thiếu / rỗng = không đọc thêm. */
export const wealthMeQuerySchema = z
  .object({ include: z.string().max(200).optional() })
  .transform((q, ctx) => {
    const parts = (q.include ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s !== "");
    const out = new Set<WealthMeInclude>();
    for (const part of parts) {
      const hit = WEALTH_ME_INCLUDES.find((x) => x === part);
      if (hit === undefined) {
        ctx.addIssue({ code: "custom", path: ["include"], message: `Unknown include: ${part}` });
        return z.NEVER;
      }
      out.add(hit);
    }
    return { include: [...out] };
  });

/**
 * Hết ngân sách weight của chính DeskLabs khi đọc Wealth (#592): 429 `RATE_LIMITED`, `details.reason` này và
 * `details.retryAfterMs`. Web hiện "SoDEX Wealth is busy", không hiện "Not provided".
 */
export const WEALTH_BUSY_REASON = "sodex_wealth_budget";

/**
 * `GET /api/v1/wealth/me` (#589): đọc theo master wallet của tài khoản đang đăng nhập, không lưu. Chưa kết nối SoDEX →
 * `not_connected`. Tổng (`pnl`) lỗi → 502 `SODEX_UNAVAILABLE`; các phần còn lại lỗi → `not_provided`. Hết ngân sách
 * weight ở bất kỳ phần nào → 429 (`WEALTH_BUSY_REASON`). `recurringBuys` / `pnlHistory` chỉ có khi được yêu cầu qua
 * `include` (#592).
 */
export const wealthMeResponseSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("not_connected") }),
  z.object({
    status: z.literal("ok"),
    readAt: isoDateTimeSchema,
    summary: wealthSummarySchema,
    holdings: z.array(wealthHoldingSchema),
    inFlight: providedSection(wealthInFlightRowSchema),
    activity: providedSection(wealthActivityRowSchema),
    /** Chỉ khi `include=recurringBuys`. */
    recurringBuys: providedSection(wealthRecurringBuyRowSchema).optional(),
    /** Chỉ khi `include=pnlHistory`. 1 tháng, mỗi ngày một điểm, cũ nhất trước. */
    pnlHistory: providedSection(wealthPnlPointSchema).optional(),
  }),
]);
export type WealthMeResponse = z.infer<typeof wealthMeResponseSchema>;

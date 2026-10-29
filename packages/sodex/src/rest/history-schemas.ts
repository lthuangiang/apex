import { decimalStringSchema } from "@drift/shared";
import { z } from "zod";

import { uint64Schema } from "./schemas";

// Schema dữ liệu lịch sử và thị trường (rest-v1/schema.md, đối chiếu với response mainnet thật ngày
// 2026-10-27). Kline trả thập phân có thể kèm số 0 thừa ("80115.000000000000000000"); giữ nguyên chuỗi.

const decimal = decimalStringSchema;
const ms = z.number().int().nonnegative();

/** UserTrade (Spot và Perps). `fee` đã gồm `builderFee`; không cộng hai lần. */
export const userTradeSchema = z.object({
  symbol: z.string(),
  tradeID: uint64Schema,
  orderID: uint64Schema,
  clOrdID: z.string(),
  side: z.enum(["BUY", "SELL"]),
  price: decimal,
  quantity: decimal,
  fee: decimal.optional(),
  builderFee: decimal.optional(),
  feeCoin: z.string().optional(),
  isMaker: z.boolean().optional(),
  time: ms,
});
export type UserTrade = z.infer<typeof userTradeSchema>;

/** Position (Perps, `positions/history`). `realizedPnL` đã trừ phí giao dịch. */
export const positionSchema = z.object({
  id: uint64Schema,
  symbol: z.string(),
  marginMode: z.string(),
  positionSide: z.enum(["LONG", "SHORT", "BOTH"]),
  size: decimal,
  avgEntryPrice: decimal,
  cumTradingFee: decimal,
  cumFundingFee: decimal,
  cumClosedSize: decimal,
  avgClosePrice: decimal,
  maxSize: decimal,
  realizedPnL: decimal,
  leverage: z.number().int().positive(),
  active: z.boolean(),
  createdAt: ms,
  updatedAt: ms,
});
export type Position = z.infer<typeof positionSchema>;

/** PerpsUserFunding: `fundingFee` âm = nhận (theo tài liệu field; SODEX.md mục 5.5). */
export const userFundingSchema = z.object({
  symbol: z.string(),
  positionID: uint64Schema,
  positionSide: z.string(),
  fundingFee: decimal,
  feeCoin: z.string(),
  timestamp: ms,
});
export type UserFunding = z.infer<typeof userFundingSchema>;

/** RPCKline. API trả mới nhất trước. */
export const klineSchema = z.object({
  t: ms,
  o: decimal,
  h: decimal,
  l: decimal,
  c: decimal,
  v: decimal,
  q: decimal,
  n: z.number().int().nonnegative(),
});
export type Kline = z.infer<typeof klineSchema>;

export const markPriceSchema = z.object({
  symbol: z.string(),
  markPrice: decimal,
  indexPrice: decimal,
  fundingRate: decimal,
  nextFundingTime: ms,
});
export type MarkPrice = z.infer<typeof markPriceSchema>;

export const KlineInterval = ["1m", "5m", "15m", "30m", "1h", "4h", "1d", "1w", "1M"] as const;
export type KlineInterval = (typeof KlineInterval)[number];

/** Lệnh REST (lịch sử / đang mở), đối chiếu response mainnet ngày 2026-10-27. */
export const restOrderSchema = z.object({
  symbol: z.string(),
  orderID: uint64Schema,
  clOrdID: z.string(),
  side: z.enum(["BUY", "SELL"]),
  status: z.enum([
    "NEW",
    "PARTIALLY_FILLED",
    "FILLED",
    "CANCELED",
    "REJECTED",
    "EXPIRED",
    "TRIGGERED",
  ]),
  origQty: decimal,
  executedQty: decimal,
  executedValue: decimal,
  createdAt: ms,
  updatedAt: ms,
});
export type RestOrder = z.infer<typeof restOrderSchema>;

/** Vị thế đang mở trong Perps account state (`WsPerpsPosition`, schema.md, tra ngày 2026-10-28). */
export const perpsOpenPositionSchema = z.object({
  i: z.number().int(),
  s: z.string(),
  m: z.string(),
  sz: decimal,
  /** Chỉ có với vị thế ISOLATED; vị thế CROSS không gửi field này (mainnet, 2026-10-28). */
  iw: decimal.nullish().transform((v) => v ?? null),
  ep: decimal,
  ur: decimal,
  l: z.number(),
  lp: decimal,
});
export type PerpsOpenPosition = z.infer<typeof perpsOpenPositionSchema>;

/** `WsPerpsState`: chỉ các field DRIFT dùng. */
export const perpsAccountStateSchema = z.object({
  /** Account value theo index price, chưa trừ haircut (Multi-Asset Margin). */
  av: decimal,
  /** Margin dùng được cho Cross, sau collateral ratio. */
  am: decimal,
  /** Margin dùng được cho Isolated: chỉ USDC. */
  ami: decimal.nullish().transform((v) => v ?? null),
  im: decimal,
  cm: decimal,
  /**
   * Tài sản thế chấp Perps theo coin (`a`): `wb` wallet balance, `px` index price, `mr` collateral ratio,
   * `wm` giá trị tính vào margin (đã haircut). Field ngoài `wb` có thể vắng ở account cũ.
   */
  B: z
    .array(
      z.object({
        a: z.string(),
        wb: decimal,
        px: decimal.nullish().transform((v) => v ?? null),
        mr: decimal.nullish().transform((v) => v ?? null),
        wm: decimal.nullish().transform((v) => v ?? null),
      }),
    )
    .nullable()
    .transform((v) => v ?? []),
  P: z
    .array(perpsOpenPositionSchema)
    .nullable()
    .transform((v) => v ?? []),
  /** Thiết lập đòn bẩy + margin mode theo symbol của account (`s`, `l`, `m`); để đối soát `updateLeverage`. */
  S: z
    .array(z.object({ s: z.string(), l: z.number().int(), m: z.enum(["CROSS", "ISOLATED"]) }))
    .nullish()
    .transform((v) => v ?? []),
});
export type PerpsAccountState = z.infer<typeof perpsAccountStateSchema>;

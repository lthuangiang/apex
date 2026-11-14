import { z } from "zod";

import { decimalStringSchema, isoDateTimeSchema } from "../schemas";

// Market Making: chi phí / $1M theo market (D1) và Price PnL đến từ đâu (D2), DEC-TBD-mm-cost. Số quá khứ 24 giờ, không
// dự báo; thiếu dữ liệu → null ("Not available"), không bao giờ 0.

export const mmMarketCostSchema = z.object({
  market: z.string(),
  /** Một bước giá (bps) = tick ÷ giá giữa × 10.000. */
  stepBps: decimalStringSchema.nullable(),
  /** Spread thường gặp (trung vị, số tick) trong 24 giờ. */
  spreadTicks: z.number().int().nullable(),
  /** Độ lệch chuẩn % thay đổi giữa các nến 1 phút, 24 giờ (bps). */
  swingBps: decimalStringSchema.nullable(),
  /** Khối lượng quote 24 giờ (USD) từ nến 1 phút. */
  volume24h: decimalStringSchema.nullable(),
  /** Markout 30 s phía maker × 100 (USD / $1M); dương = có lợi. */
  pricePnlPerMillion: decimalStringSchema.nullable(),
  /** Nguồn của Price PnL: fill thật của bot MM DeskLabs, hay giao dịch công khai SoDEX. */
  pricePnlSource: z.enum(["bots", "public"]).nullable(),
  /** Phí maker SoDEX + builder fee MM − Price PnL (USD / $1M). */
  totalCostPerMillion: decimalStringSchema.nullable(),
  /** Người dùng đang có bot MM chạy ở market này ("Your bot today"). */
  yourBot: z.boolean(),
});
export type MmMarketCost = z.infer<typeof mmMarketCostSchema>;

export const mmMarketCostsSchema = z.object({
  asOf: isoDateTimeSchema,
  /** Lần cập nhật dữ liệu gần nhất; null khi chưa có dữ liệu nào. Cũ hơn 1 giờ thì web hiện "Updated {time}". */
  updatedAt: isoDateTimeSchema.nullable(),
  makerFeePerMillion: decimalStringSchema,
  builderFeePerMillion: decimalStringSchema,
  markets: z.array(mmMarketCostSchema),
});
export type MmMarketCosts = z.infer<typeof mmMarketCostsSchema>;

/** D2: markout fill thật của bot trong 24 giờ. */
export const mmMarkoutSchema = z.object({
  asOf: isoDateTimeSchema,
  market: z.string(),
  fills: z.number().int(),
  /** Markout (bps, dương = có lợi cho bot) 5 / 30 / 60 s sau fill; null khi không đủ dữ liệu giá. */
  markout: z.object({
    s5: decimalStringSchema.nullable(),
    s30: decimalStringSchema.nullable(),
    s60: decimalStringSchema.nullable(),
  }),
  stepBps: decimalStringSchema.nullable(),
  /** Vòng mua bán (vị thế từ 0 về 0) đóng lỗ theo Price PnL (chưa trừ phí); null khi chưa có vòng nào. */
  roundTrips: z
    .object({
      losing: z.number().int(),
      total: z.number().int(),
      /** Vòng lỗ mất nhiều hơn (mỗi đơn vị) vòng lãi được; thiếu một trong hai loại → null (ẩn câu). */
      losersLoseMore: z.boolean().nullable(),
    })
    .nullable(),
  /** Câu "In short" chỉ hiện khi một bước giá < trung vị |Δ giá giữa 30 s| trên các fill (PM chốt D-a). */
  inShort: z.boolean(),
});
export type MmMarkout = z.infer<typeof mmMarkoutSchema>;

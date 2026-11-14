import { z } from "zod";

import { decimalStringSchema, isoDateTimeSchema } from "../schemas";

// Market Making: chi phí / $1M theo market (DEC-TBD-mm-cost-v1, thay phần xếp hạng của DEC-227) và Price PnL đến từ
// đâu (D2, DEC-227). Số quá khứ 24 giờ, không dự báo; thiếu dữ liệu → null ("not enough data"), không bao giờ 0.

export const mmMarketCostSchema = z.object({
  market: z.string(),
  /** Một bước giá (bps) = tick ÷ giá đóng nến 1m mới nhất × 10.000. */
  stepBps: decimalStringSchema.nullable(),
  /** Spread thường gặp (trung vị, số tick) trong 24 giờ, từ book ticker; chỉ để tham khảo. */
  spreadTicks: z.number().int().nullable(),
  /** Độ lệch chuẩn % thay đổi giữa các nến 1 phút, 24 giờ (bps); null khi dưới 50% số phút có volume. */
  swingBps: decimalStringSchema.nullable(),
  /** Khối lượng quote 24 giờ (USD) từ nến 1 phút. */
  volume24h: decimalStringSchema.nullable(),
  /** "Up to … / day": 5% volume 24h (USD). */
  capacityPerDay: decimalStringSchema.nullable(),
  /** Sức chứa dưới $100K / ngày: không gợi ý, xếp sau ("Too little volume"). */
  tooLittleVolume: z.boolean(),
  /** Số nến 1m và số phút có volume trong 24 giờ (ngưỡng dữ liệu của mô hình). */
  candleMinutes24h: z.number().int(),
  activeMinutes24h: z.number().int(),
  /** Giao dịch công khai đã ghi (markout đối chiếu): số giờ có số, số giao dịch, notional 24 giờ. */
  hoursWithData: z.number().int(),
  trades24h: z.number().int(),
  notional24h: decimalStringSchema,
  /** Markout 30 s công khai phía maker × 100 (USD / $1M); chỉ để đối chiếu, không dùng xếp hạng. */
  publicPricePnlPerMillion: decimalStringSchema.nullable(),
  /** PnL giá dùng để tính chi phí (USD / $1M): mô hình, hoặc trộn với bot của chính người xem. */
  pricePnlPerMillion: decimalStringSchema.nullable(),
  /** Nguồn số: "yours" = có bot của người xem ở market này (đã trộn với mô hình), "model" = chỉ mô hình. */
  source: z.enum(["yours", "model"]).nullable(),
  /** Số vòng đóng của bot người xem trong 24 giờ (trọng số khi trộn). */
  yourRoundTrips: z.number().int(),
  /** Phí maker SoDEX + builder fee MM − PnL giá (USD / $1M); ≤ 0 thì web ghi "0 or less". */
  totalCostPerMillion: decimalStringSchema.nullable(),
  /** Người dùng đang có bot MM chạy ở market này. */
  yourBot: z.boolean(),
});
export type MmMarketCost = z.infer<typeof mmMarketCostSchema>;

export const mmMarketCostsSchema = z.object({
  asOf: isoDateTimeSchema,
  /** Lần cập nhật dữ liệu giao dịch công khai gần nhất; null khi chưa có. */
  updatedAt: isoDateTimeSchema.nullable(),
  makerFeePerMillion: decimalStringSchema,
  builderFeePerMillion: decimalStringSchema,
  /** Hệ số mô hình đang dùng (PnL giá = a × bước − k × dao động, chặn ≤ 0); version 0 = hệ số khởi đầu. */
  modelVersion: z.number().int(),
  model: z.object({ a: decimalStringSchema, k: decimalStringSchema }),
  /** Đã xếp: đủ dữ liệu + đủ sức chứa trước (rẻ nhất trước), rồi "Too little volume", rồi thiếu dữ liệu. */
  markets: z.array(mmMarketCostSchema),
  /** Tối đa 3 market gợi ý (đủ dữ liệu, không "Too little volume"). */
  suggested: z.array(z.string()),
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

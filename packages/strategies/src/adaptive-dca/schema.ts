import { dec } from "@drift/shared";
import { z } from "zod";

import { marketSchema, percent, positiveDecimal } from "../common/schema";

// S11 AI Adaptive DCA (DEC-107, docs/AI_ADAPTIVE_DCA.md): DCA trên Perps, chỉ vào chu kỳ khi regime 5 phút hợp lệ và RSI
// cho tín hiệu, khoảng cách lệnh DCA theo ATR (tính lại mỗi lần đặt), trần tổng vị thế, hard stop, quyết định
// Continue / Reduce / Exit bằng quy tắc cố định. Không phải mô hình đoán mò, không dự báo.

export const ADCA_DEFAULTS = {
  direction: "long",
  marginMode: "isolated",
  /** 4 lệnh thêm × 1.5: thang 100 + 100 + 150 + 225 + 337.5 = 912.5 nằm trong trần mặc định 1.000 (DEC-107). */
  maxSafetyOrders: 4,
  sizeMultiplier: "1.5",
  atrMultiplier: "2",
  takeProfitPct: "1.5",
  hardStopLossPct: "8",
  entryRsi: "45",
  cooldownMinutes: 30,
} as const;

export const adaptiveDcaSchema = z
  .object({
    market: marketSchema,
    leverage: z
      .number()
      .int({ message: "Whole numbers only." })
      .min(1, { message: "Allowed 1× or more." }),
    marginMode: z.enum(["cross", "isolated"]).default(ADCA_DEFAULTS.marginMode),
    direction: z.enum(["long", "short"]).default(ADCA_DEFAULTS.direction),
    /** Giá trị (quote, đã gồm đòn bẩy) của lệnh vào đầu chu kỳ. */
    baseOrder: positiveDecimal("Below SoDEX minimum order size."),
    /** Giá trị của lệnh DCA đầu tiên; lệnh sau × sizeMultiplier. */
    safetyOrder: positiveDecimal("Below SoDEX minimum order size."),
    maxSafetyOrders: z
      .number()
      .int()
      .min(1, { message: "Allowed 1–10." })
      .max(10, { message: "Allowed 1–10." })
      .default(ADCA_DEFAULTS.maxSafetyOrders),
    sizeMultiplier: percent(1, 2, "Allowed 1–2×.").default(ADCA_DEFAULTS.sizeMultiplier),
    /** Khoảng cách lệnh DCA = ATR 5 phút × hệ số này (lệnh sau xa hơn 20% mỗi bậc). */
    atrMultiplier: percent(0.5, 10, "Allowed 0.5–10×.").default(ADCA_DEFAULTS.atrMultiplier),
    takeProfitPct: percent(0.2, 20, "Allowed 0.2–20%.").default(ADCA_DEFAULTS.takeProfitPct),
    /** Trần tổng giá trị vị thế (quote): không đặt thêm lệnh DCA nếu vượt. */
    maxExposure: positiveDecimal(),
    /** Giá đi ngược so với giá trung bình chừng này % thì đóng cả chu kỳ. */
    hardStopLossPct: percent(1, 50, "Allowed 1–50%.").default(ADCA_DEFAULTS.hardStopLossPct),
    /** Long: chỉ vào khi RSI 5 phút ≤ mức này; short: ≥ 100 − mức này. */
    entryRsi: percent(10, 90, "Allowed 10–90.").default(ADCA_DEFAULTS.entryRsi),
    /** Nghỉ sau khi chu kỳ đóng bằng Exit hoặc hard stop. */
    cooldownMinutes: z
      .number()
      .int()
      .min(0, { message: "Allowed 0–1440 min." })
      .max(1440, { message: "Allowed 0–1440 min." })
      .default(ADCA_DEFAULTS.cooldownMinutes),
    /** Lỗ ròng của bot (đã chốt + chưa chốt + phí + funding) chạm mức này thì dừng và đóng vị thế. */
    maxLoss: positiveDecimal(),
  })
  .superRefine((c, ctx) => {
    if (dec(c.maxExposure).lt(dec(c.baseOrder)))
      ctx.addIssue({
        code: "custom",
        path: ["maxExposure"],
        message: "Must be at least the first order.",
      });
  });
export type AdaptiveDcaConfig = z.infer<typeof adaptiveDcaSchema>;

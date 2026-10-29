import { dec } from "@drift/shared";
import { z } from "zod";

import { safetyOffsetPct } from "../common/dca-bot";
import { leverageSchema, marginModeSchema } from "../common/perps";
import { marketSchema, optionalPositive, percent, positiveDecimal } from "../common/schema";

// S4 Futures DCA (STRATEGIES.md). Stop loss bắt buộc; "trước giá thanh lý" kiểm tra bằng SoDEX preview.
export const futuresDcaSchema = z
  .object({
    market: marketSchema,
    leverage: leverageSchema,
    marginMode: marginModeSchema,
    direction: z.enum(["long", "short"]),
    baseOrder: positiveDecimal(),
    safetyOrder: positiveDecimal(),
    maxSafetyOrders: z
      .number()
      .int()
      .min(0, { message: "Allowed 0–20." })
      .max(20, { message: "Allowed 0–20." }),
    firstStepPct: percent(0.1, 20, "Allowed 0.1–20%."),
    stepMultiplier: percent(1, 3, "Allowed 1–3×."),
    sizeMultiplier: percent(1, 3, "Allowed 1–3×."),
    takeProfitPct: positiveDecimal(),
    stopLossPct: positiveDecimal(),
    maxLoss: optionalPositive(),
  })
  .superRefine((c, ctx) => {
    if (dec(c.stopLossPct).lte(safetyOffsetPct(c, c.maxSafetyOrders))) {
      ctx.addIssue({
        code: "custom",
        path: ["stopLossPct"],
        message: "Must be larger than the last safety order drop.",
      });
    }
  });
export type FuturesDcaConfig = z.infer<typeof futuresDcaSchema>;

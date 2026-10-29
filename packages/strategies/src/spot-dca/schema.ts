import { dec } from "@drift/shared";
import { z } from "zod";

import { safetyOffsetPct } from "../common/dca-bot";
import { marketSchema, optionalPositive, percent, positiveDecimal } from "../common/schema";

// S3 Spot DCA (STRATEGIES.md). "≥ SoDEX min size" và "TP > round-trip fees" kiểm tra bằng dữ liệu ngoài.
export const spotDcaSchema = z
  .object({
    market: marketSchema,
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
    start: z.enum(["immediately", "price_at_or_below"]),
    startLevel: optionalPositive(),
    stopLossPct: optionalPositive(),
    maxCycles: z.number().int().min(1, { message: "Must be 1 or more." }).optional(),
    maxLoss: optionalPositive(),
  })
  .superRefine((c, ctx) => {
    if (
      c.stopLossPct !== undefined &&
      dec(c.stopLossPct).lte(safetyOffsetPct(c, c.maxSafetyOrders))
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["stopLossPct"],
        message: "Must be larger than the last safety order drop.",
      });
    }
    if (c.start === "price_at_or_below" && c.startLevel === undefined) {
      ctx.addIssue({ code: "custom", path: ["startLevel"], message: "Required." });
    }
  });
export type SpotDcaConfig = z.infer<typeof spotDcaSchema>;

import { dec } from "@drift/shared";
import { z } from "zod";

import { marketSchema, optionalPositive, positiveDecimal } from "../common/schema";

// S1 Spot Grid (STRATEGIES.md). Field "Investment ≤ free balance" và "step > round-trip fees" cần dữ
// liệu ngoài, kiểm tra ở `validateSpotGrid`.

export const spotGridSchema = z
  .object({
    market: marketSchema,
    lowerPrice: positiveDecimal(),
    upperPrice: positiveDecimal(),
    gridLevels: z
      .number()
      .int()
      .min(2, { message: "Allowed 2–200." })
      .max(200, { message: "Allowed 2–200." }),
    spacing: z.enum(["arithmetic", "geometric"]),
    investment: positiveDecimal(),
    triggerPrice: optionalPositive(),
    stopPrice: optionalPositive(),
    /** % trên investment. */
    takeProfitPct: optionalPositive("Must be above 0."),
    maxLoss: positiveDecimal(),
    onStop: z.enum(["keep_base", "sell_at_market"]),
  })
  .superRefine((c, ctx) => {
    if (dec(c.lowerPrice).gte(c.upperPrice)) {
      ctx.addIssue({
        code: "custom",
        path: ["lowerPrice"],
        message: "Must be lower than the upper price.",
      });
      ctx.addIssue({
        code: "custom",
        path: ["upperPrice"],
        message: "Must be higher than the lower price.",
      });
    }
    if (
      c.triggerPrice !== undefined &&
      (dec(c.triggerPrice).lt(c.lowerPrice) || dec(c.triggerPrice).gt(c.upperPrice))
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["triggerPrice"],
        message: "Must be inside the grid range.",
      });
    }
    if (c.stopPrice !== undefined && dec(c.stopPrice).gte(c.lowerPrice)) {
      ctx.addIssue({
        code: "custom",
        path: ["stopPrice"],
        message: "Must be below the lower price.",
      });
    }
    if (dec(c.maxLoss).gte(c.investment)) {
      ctx.addIssue({ code: "custom", path: ["maxLoss"], message: "Must be below the investment." });
    }
  });
export type SpotGridConfig = z.infer<typeof spotGridSchema>;

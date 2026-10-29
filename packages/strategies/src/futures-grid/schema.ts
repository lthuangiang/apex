import { dec } from "@drift/shared";
import { z } from "zod";

import { leverageSchema, marginModeSchema } from "../common/perps";
import { marketSchema, optionalPositive, positiveDecimal } from "../common/schema";

// S2 Futures Grid (STRATEGIES.md).
export const futuresGridSchema = z
  .object({
    market: marketSchema,
    leverage: leverageSchema,
    marginMode: marginModeSchema,
    direction: z.enum(["neutral", "long", "short"]),
    lowerPrice: positiveDecimal(),
    upperPrice: positiveDecimal(),
    gridLevels: z
      .number()
      .int()
      .min(2, { message: "Allowed 2–200." })
      .max(200, { message: "Allowed 2–200." }),
    spacing: z.enum(["arithmetic", "geometric"]),
    margin: positiveDecimal(),
    triggerPrice: optionalPositive(),
    /** Bắt buộc (STRATEGIES.md S2, UI_REVIEW G4): bot perp có đòn bẩy cần mức dừng trước thanh lý. */
    stopBelow: positiveDecimal(),
    stopAbove: optionalPositive(),
    takeProfitPct: optionalPositive(),
    maxLoss: positiveDecimal(),
    onStop: z.enum(["close_at_market", "keep_position"]),
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
    if (dec(c.stopBelow).gte(c.lowerPrice)) {
      ctx.addIssue({
        code: "custom",
        path: ["stopBelow"],
        message: "Must be below the lower price.",
      });
    }
    if (c.stopAbove !== undefined && dec(c.stopAbove).lte(c.upperPrice)) {
      ctx.addIssue({
        code: "custom",
        path: ["stopAbove"],
        message: "Must be above the upper price.",
      });
    }
    if (dec(c.maxLoss).gte(c.margin)) {
      ctx.addIssue({ code: "custom", path: ["maxLoss"], message: "Must be below the margin." });
    }
  });
export type FuturesGridConfig = z.infer<typeof futuresGridSchema>;

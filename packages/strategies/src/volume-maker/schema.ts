import { dec } from "@drift/shared";
import { z } from "zod";

import { positiveDecimal } from "../common/schema";

// S9 Volume Maker (STRATEGIES.md, VOLUME_MAKER.md mục 17). Khoá bằng `VOLUME_MAKER_ENABLED`; chỉ BTC / ETH perp,
// đòn bẩy cố định 1×, chỉ lệnh post-only. Câu lỗi chép nguyên văn từ STRATEGIES.md.
export const VOLUME_MAKER_MARKETS = ["BTC-USD", "ETH-USD"] as const;

export const volumeMakerSchema = z
  .object({
    market: z.enum(VOLUME_MAKER_MARKETS, { message: "Required." }),
    leverage: z.literal(1, { message: "Volume Maker runs at 1×." }),
    volumeTarget: positiveDecimal(),
    orderSize: positiveDecimal("Below SoDEX minimum order size."),
    distanceBp: positiveDecimal("Must be at least one tick."),
    maxInventory: positiveDecimal(),
    refreshSeconds: z
      .number()
      .int()
      .min(2, { message: "Allowed 2–60 s." })
      .max(60, { message: "Allowed 2–60 s." }),
    runUntil: z.enum(["season_end", "date", "target_or_budget"]),
    /** ms; bắt buộc khi `runUntil` là `season_end` hoặc `date`. */
    untilAt: z.number().int().positive().optional(),
    costBudget: positiveDecimal(),
    inventoryLossStop: positiveDecimal(),
    onStop: z.enum(["close_inventory", "keep_position"]),
  })
  .superRefine((c, ctx) => {
    if (!dec(c.maxInventory).gt(c.orderSize))
      ctx.addIssue({
        code: "custom",
        path: ["maxInventory"],
        message: "Must be above the order size.",
      });
    if (!dec(c.inventoryLossStop).lt(c.costBudget))
      ctx.addIssue({
        code: "custom",
        path: ["inventoryLossStop"],
        message: "Must be below the budget.",
      });
    if (c.runUntil !== "target_or_budget" && c.untilAt === undefined)
      ctx.addIssue({ code: "custom", path: ["untilAt"], message: "Required." });
  });
export type VolumeMakerConfig = z.infer<typeof volumeMakerSchema>;

import { dec } from "@drift/shared";
import { z } from "zod";

import { marketSchema, optionalPositive, positiveDecimal } from "../common/schema";

// S5 Recurring Buy (STRATEGIES.md). Không bao giờ bán; không có builder fee (Spot chỉ thu ở chiều bán).
export const recurringBuySchema = z
  .object({
    market: marketSchema,
    amountPerBuy: positiveDecimal(),
    frequency: z.enum(["daily", "weekly", "monthly"]),
    dayOfWeek: z.number().int().min(0).max(6).optional(),
    dayOfMonth: z.number().int().min(1).max(28).optional(),
    time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    timeZone: z.string().min(1),
    ends: z.enum(["never", "after_budget", "after_n_buys"]),
    totalBudget: optionalPositive(),
    buyCount: z.number().int().min(1).optional(),
    skipAbovePrice: optionalPositive(),
    onLowBalance: z.enum(["skip_and_notify", "pause"]),
  })
  .superRefine((c, ctx) => {
    if (
      c.ends === "after_budget" &&
      (c.totalBudget === undefined || dec(c.totalBudget).lt(c.amountPerBuy))
    ) {
      ctx.addIssue({ code: "custom", path: ["totalBudget"], message: "Must be at least one buy." });
    }
    if (c.ends === "after_n_buys" && c.buyCount === undefined) {
      ctx.addIssue({ code: "custom", path: ["buyCount"], message: "Must be 1 or more." });
    }
  });
export type RecurringBuyConfig = z.infer<typeof recurringBuySchema>;

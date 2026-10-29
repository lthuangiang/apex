import { dec, sum } from "@drift/shared";
import { z } from "zod";

import { optionalPositive, percent, positiveDecimal } from "../common/schema";

// S6 Rebalancing (STRATEGIES.md). Danh sách tài sản gồm cả quote asset (ví dụ BTC 50 · ETH 30 · USDC 20).
export const rebalancingSchema = z
  .object({
    quoteAsset: z.enum(["USDC", "USDT"]),
    assets: z
      .array(
        z.object({
          asset: z.string().min(1),
          /** Market Spot của tài sản so với quote; bỏ trống với chính quote asset. */
          market: z.string().min(1).optional(),
          weightPct: percent(0, 100, "Weights must add up to 100%."),
        }),
      )
      .min(2, { message: "Allowed 2–10 assets." })
      .max(10, { message: "Allowed 2–10 assets." }),
    rebalanceWhen: z.enum(["threshold", "schedule"]),
    /** Bắt buộc khi `rebalanceWhen = threshold`; form ẩn ô này ở chế độ schedule (UI_REVIEW G4). */
    thresholdPct: percent(1, 50, "Allowed 1–50%.").optional(),
    /** Chế độ schedule: chu kỳ lịch, chạy 00:00 theo `timeZone` (DEC-67). Weekly = thứ Hai, Monthly = ngày 1. */
    schedule: z.enum(["daily", "weekly", "monthly"]).optional(),
    timeZone: z.string().min(1).optional(),
    /** Chế độ schedule cũ: mỗi N giờ (DEC-36); chỉ dùng khi config không có `schedule`. */
    scheduleHours: z.number().int().min(1).max(720).default(24),
    investment: positiveDecimal(),
    maxTradePct: percent(1, 100, "Allowed 1–100%."),
    stopBelow: optionalPositive(),
    takeProfitPct: optionalPositive(),
  })
  .superRefine((c, ctx) => {
    if (c.rebalanceWhen === "threshold" && c.thresholdPct === undefined) {
      ctx.addIssue({ code: "custom", path: ["thresholdPct"], message: "Allowed 1–50%." });
    }
    if (!sum(c.assets.map((a) => a.weightPct)).eq(100)) {
      ctx.addIssue({ code: "custom", path: ["assets"], message: "Weights must add up to 100%." });
    }
    if (c.stopBelow !== undefined && dec(c.stopBelow).gte(c.investment)) {
      ctx.addIssue({
        code: "custom",
        path: ["stopBelow"],
        message: "Must be below the investment.",
      });
    }
    c.assets.forEach((a, i) => {
      if (a.asset !== c.quoteAsset && a.market === undefined) {
        ctx.addIssue({ code: "custom", path: ["assets", i, "market"], message: "Required." });
      }
    });
  });
export type RebalancingConfig = z.infer<typeof rebalancingSchema>;

import { z } from "zod";

import { marketSchema, optionalPositive, percent, positiveDecimal } from "../common/schema";
import { localToUtc } from "../recurring-buy/schedule";

// S8 TWAP (STRATEGIES.md). Tự chia lát; không dùng TWAP native của SoDEX (DEC-36).
export const twapSchema = z
  .object({
    market: marketSchema,
    engine: z.enum(["spot", "perps"]),
    side: z.enum(["buy", "sell"]),
    totalSize: positiveDecimal(),
    durationMinutes: z
      .number()
      .int()
      .min(5, { message: "Allowed 5 min – 24 h." })
      .max(1440, { message: "Allowed 5 min – 24 h." }),
    slices: z.number().int().min(1),
    priceLimit: optionalPositive(),
    // Chỉ có nghĩa với Perps; form ẩn ô này khi Engine = Spot nên không gửi lên (UI_REVIEW G4).
    reduceOnly: z.boolean().default(false),
    maxSlippagePct: percent(0.05, 5, "Allowed 0.05–5%."),
    onSkip: z.enum(["add_to_end", "leave_unfilled"]),
    // Start at (IMPROVEMENTS IMP-03, DEC-91): thiếu `start` (config cũ) là Now. `startDate` là ngày (ms UTC lúc
    // 00:00 như ô date của form), `startTime` "HH:MM" theo múi giờ `timeZone` (múi giờ trong Settings).
    start: z.enum(["now", "at"]).optional(),
    startDate: z.number().int().positive().optional(),
    startTime: z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/, { message: "Use HH:MM." })
      .optional(),
    timeZone: z.string().min(1).optional(),
  })
  .superRefine((c, ctx) => {
    if (c.start !== "at") return;
    if (c.startDate === undefined)
      ctx.addIssue({ code: "custom", path: ["startDate"], message: "Required." });
    if (c.startTime === undefined)
      ctx.addIssue({ code: "custom", path: ["startTime"], message: "Required." });
    if (c.timeZone === undefined)
      ctx.addIssue({
        code: "custom",
        path: ["startTime"],
        message: "Set your time zone in Settings.",
      });
  });
export type TwapConfig = z.infer<typeof twapSchema>;

/** Thời điểm bắt đầu (ms UTC) hoặc null = Now. */
export function twapStartAt(c: TwapConfig): number | null {
  if (c.start !== "at" || c.startDate === undefined || c.startTime === undefined) return null;
  const d = new Date(c.startDate);
  const [h = 0, m = 0] = c.startTime.split(":").map(Number);
  return localToUtc(c.timeZone ?? "UTC", d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), h, m);
}

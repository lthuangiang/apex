import { z } from "zod";

import { marketSchema, optionalPositive, percent, positiveDecimal } from "../common/schema";

// S8 TWAP (STRATEGIES.md). Tự chia lát; không dùng TWAP native của SoDEX (DEC-36).
export const twapSchema = z.object({
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
  reduceOnly: z.boolean(),
  maxSlippagePct: percent(0.05, 5, "Allowed 0.05–5%."),
  onSkip: z.enum(["add_to_end", "leave_unfilled"]),
});
export type TwapConfig = z.infer<typeof twapSchema>;

import { dec } from "@drift/shared";
import { z } from "zod";

import { leverageSchema } from "../common/perps";
import { percent, positiveDecimal } from "../common/schema";

// S7 Funding Arbitrage (STRATEGIES.md). Ngưỡng funding là % mỗi kỳ funding của market (DEC-36).
export const fundingArbSchema = z
  .object({
    asset: z.string().min(1, { message: "Required." }),
    spotMarket: z.string().min(1, { message: "Required." }),
    perpMarket: z.string().min(1, { message: "Required." }),
    leverage: leverageSchema.max(3, { message: "Above your 3.0× account cap." }),
    investment: positiveDecimal(),
    enterFundingPct: positiveDecimal(),
    exitFundingPct: z.string().regex(/^-?\d+(\.\d+)?$/),
    maxGapPct: percent(0.1, 5, "Allowed 0.1–5%."),
    minMarginRatioPct: percent(10, 90, "Allowed 10–90%."),
    maxLoss: positiveDecimal(),
  })
  .superRefine((c, ctx) => {
    if (dec(c.exitFundingPct).gte(c.enterFundingPct)) {
      ctx.addIssue({
        code: "custom",
        path: ["exitFundingPct"],
        message: "Must be below the entry level.",
      });
    }
    if (dec(c.maxLoss).gte(c.investment)) {
      ctx.addIssue({ code: "custom", path: ["maxLoss"], message: "Must be below the investment." });
    }
  });
export type FundingArbConfig = z.infer<typeof fundingArbSchema>;

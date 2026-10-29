import { Strategy } from "@drift/shared";
import type { z } from "zod";

import type { StrategyModule } from "./core/types";
import { fundingArb } from "./funding-arb";
import { fundingArbSchema } from "./funding-arb/schema";
import { futuresDca } from "./futures-dca";
import { futuresDcaSchema } from "./futures-dca/schema";
import { futuresGrid } from "./futures-grid";
import { futuresGridSchema } from "./futures-grid/schema";
import { rebalancing } from "./rebalancing";
import { rebalancingSchema } from "./rebalancing/schema";
import { recurringBuy } from "./recurring-buy";
import { recurringBuySchema } from "./recurring-buy/schema";
import { spotDca } from "./spot-dca";
import { spotDcaSchema } from "./spot-dca/schema";
import { spotGrid } from "./spot-grid";
import { spotGridSchema } from "./spot-grid/schema";
import { twap } from "./twap";
import { twapSchema } from "./twap/schema";
import { volumeMaker } from "./volume-maker";
import { volumeMakerSchema } from "./volume-maker/schema";

// Registry chiến lược: engine (chạy thật) và backtest (mô phỏng) dùng chung để có cùng chuỗi hành động.

export interface StrategyEntry {
  schema: z.ZodType;
  module: StrategyModule<never, unknown>;
  engines: readonly ("spot" | "perps")[];
}

export const STRATEGIES = {
  [Strategy.spotGrid]: { schema: spotGridSchema, module: spotGrid, engines: ["spot"] },
  [Strategy.futuresGrid]: { schema: futuresGridSchema, module: futuresGrid, engines: ["perps"] },
  [Strategy.spotDca]: { schema: spotDcaSchema, module: spotDca, engines: ["spot"] },
  [Strategy.futuresDca]: { schema: futuresDcaSchema, module: futuresDca, engines: ["perps"] },
  [Strategy.recurringBuy]: { schema: recurringBuySchema, module: recurringBuy, engines: ["spot"] },
  [Strategy.rebalancing]: { schema: rebalancingSchema, module: rebalancing, engines: ["spot"] },
  [Strategy.fundingArb]: {
    schema: fundingArbSchema,
    module: fundingArb,
    engines: ["spot", "perps"],
  },
  [Strategy.twap]: { schema: twapSchema, module: twap, engines: ["spot", "perps"] },
  // Khoá bằng VOLUME_MAKER_ENABLED ở api và engine (VOLUME_MAKER.md mục 17.5).
  [Strategy.volumeMaker]: { schema: volumeMakerSchema, module: volumeMaker, engines: ["perps"] },
} as const;

export type LaunchedStrategy = keyof typeof STRATEGIES;

import { gridBotFor } from "../common/grid-bot";
import type { StrategyModule } from "../core/types";

import type { SpotGridConfig } from "./schema";

// S1 Spot Grid: lõi grid với hướng long cố định (STRATEGIES.md, DEC-36).
export type { GridBotState as SpotGridState } from "../common/grid-bot";

export const spotGrid: StrategyModule<SpotGridConfig, import("../common/grid-bot").GridBotState> =
  gridBotFor((c: SpotGridConfig) => ({
    market: c.market,
    engine: "spot",
    direction: "long",
    lowerPrice: c.lowerPrice,
    upperPrice: c.upperPrice,
    gridLevels: c.gridLevels,
    spacing: c.spacing,
    notional: c.investment,
    capital: c.investment,
    triggerPrice: c.triggerPrice,
    stopBelow: c.stopPrice,
    takeProfitPct: c.takeProfitPct,
    maxLoss: c.maxLoss,
    closeOnStop: c.onStop === "sell_at_market",
  }));

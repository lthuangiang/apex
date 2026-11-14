import { entryOf, type EntryCondition } from "../common/entry";
import { gridBotFor } from "../common/grid-bot";
import type { StrategyModule } from "../core/types";

import type { SpotGridConfig } from "./schema";

// S1 Spot Grid: lõi grid với hướng long cố định (STRATEGIES.md, DEC-36).
// First entry = Now (hoặc không chọn) nghĩa là vào ngay khi giá trong khoảng lưới; giá đang ngoài khoảng thì chờ giá vào
// khoảng, không mua market cả vốn (PM chốt sau bản rà soát strategy).
function spotGridEntry(c: SpotGridConfig): EntryCondition {
  const e = entryOf(
    c,
    c.triggerPrice === undefined ? undefined : { type: "cross", price: c.triggerPrice },
  );
  return e.type === "now" ? { type: "within", low: c.lowerPrice, high: c.upperPrice } : e;
}

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
    entry: spotGridEntry(c),
    stopBelow: c.stopPrice,
    takeProfitPct: c.takeProfitPct,
    maxLoss: c.maxLoss,
    closeOnStop: c.onStop === "sell_at_market",
  }));

import { mul } from "@drift/shared";

import { gridBotFor, type GridBotState } from "../common/grid-bot";
import type { StrategyModule } from "../core/types";

import type { FuturesGridConfig } from "./schema";

// S2 Futures Grid: lõi grid trên perps với hướng Neutral / Long / Short; danh nghĩa = margin × đòn bẩy.
// Funding ghi vào PnL; giá thanh lý lấy từ SoDEX ở màn tạo bot, không tính ở đây (STRATEGIES.md).
export const futuresGrid: StrategyModule<FuturesGridConfig, GridBotState> = gridBotFor(
  (c: FuturesGridConfig) => ({
    market: c.market,
    engine: "perps",
    direction: c.direction,
    lowerPrice: c.lowerPrice,
    upperPrice: c.upperPrice,
    gridLevels: c.gridLevels,
    spacing: c.spacing,
    notional: mul(c.margin, String(c.leverage)).toString(),
    capital: c.margin,
    triggerPrice: c.triggerPrice,
    stopBelow: c.stopBelow,
    stopAbove: c.stopAbove,
    takeProfitPct: c.takeProfitPct,
    maxLoss: c.maxLoss,
    closeOnStop: c.onStop === "close_at_market",
  }),
);

import { mul } from "@drift/shared";

import { dcaBotFor, type DcaBotState } from "../common/dca-bot";
import type { StrategyModule } from "../core/types";

import type { FuturesDcaConfig } from "./schema";

// S4 Futures DCA: lõi DCA trên perps; base / safety là margin, danh nghĩa = margin × đòn bẩy.
// Long: safety khi giá giảm; Short: khi giá tăng. TP và đóng vị thế dùng reduce-only.
export const futuresDca: StrategyModule<FuturesDcaConfig, DcaBotState> = dcaBotFor(
  (c: FuturesDcaConfig) => ({
    market: c.market,
    engine: "perps",
    direction: c.direction,
    baseNotional: mul(c.baseOrder, String(c.leverage)).toString(),
    safetyNotional: mul(c.safetyOrder, String(c.leverage)).toString(),
    maxSafetyOrders: c.maxSafetyOrders,
    firstStepPct: c.firstStepPct,
    stepMultiplier: c.stepMultiplier,
    sizeMultiplier: c.sizeMultiplier,
    takeProfitPct: c.takeProfitPct,
    stopLossPct: c.stopLossPct,
    maxLoss: c.maxLoss,
  }),
);

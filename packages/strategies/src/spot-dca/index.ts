import { dcaBotFor, type DcaBotState } from "../common/dca-bot";
import type { StrategyModule } from "../core/types";

import type { SpotDcaConfig } from "./schema";

// S3 Spot DCA: lõi DCA, long, Spot.
export const spotDca: StrategyModule<SpotDcaConfig, DcaBotState> = dcaBotFor(
  (c: SpotDcaConfig) => ({
    market: c.market,
    engine: "spot",
    direction: "long",
    baseNotional: c.baseOrder,
    safetyNotional: c.safetyOrder,
    maxSafetyOrders: c.maxSafetyOrders,
    firstStepPct: c.firstStepPct,
    stepMultiplier: c.stepMultiplier,
    sizeMultiplier: c.sizeMultiplier,
    takeProfitPct: c.takeProfitPct,
    stopLossPct: c.stopLossPct,
    maxCycles: c.maxCycles,
    maxLoss: c.maxLoss,
    startLevel: c.start === "price_at_or_below" ? c.startLevel : undefined,
  }),
);

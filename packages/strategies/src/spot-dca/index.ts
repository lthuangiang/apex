import { dcaBotFor, type DcaBotState } from "../common/dca-bot";
import { entryOf, nextCycleOf } from "../common/entry";
import type { StrategyModule } from "../core/types";

import type { SpotDcaConfig } from "./schema";

// S3 Spot DCA: lõi DCA, long, Spot.
// Config cũ `start: price_at_or_below` chặn mọi Cycle ở `startLevel`: đọc thành At price + Same as first entry (DEC-91).
const legacyStart = (c: SpotDcaConfig) =>
  c.start === "price_at_or_below" && c.startLevel !== undefined
    ? { type: "at_price" as const, price: c.startLevel }
    : undefined;

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
    entry: entryOf(c, legacyStart(c)),
    nextCycle: nextCycleOf(
      c,
      c.entry === undefined && legacyStart(c) !== undefined ? { type: "same_as_entry" } : undefined,
    ),
  }),
);

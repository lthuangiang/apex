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

// Logic thuần của các chiến lược (P5). Engine (chạy thật) và backtest (mô phỏng) dùng chung registry
// này để có cùng chuỗi hành động (ARCHITECTURE.md mục 4). Volume Maker thêm ở P12.

export * from "./core";
export * from "./sim";
export { safetyOffsetPct } from "./common/dca-bot";
export { gridPrices, stepCoversFees } from "./common/grid";
export { leverageCapIssue } from "./common/perps";
export { nextRun } from "./recurring-buy/schedule";
export { REBALANCE_CHECK_MS } from "./rebalancing";
export { sliceIntervalMs } from "./twap";
export {
  fundingArbSchema,
  futuresDcaSchema,
  futuresGridSchema,
  rebalancingSchema,
  recurringBuySchema,
  spotDcaSchema,
  spotGridSchema,
  twapSchema,
};

export { STRATEGIES, type LaunchedStrategy, type StrategyEntry } from "./registry";
export * from "./backtest";
export { fundingArb, futuresDca, futuresGrid, rebalancing, recurringBuy, spotDca, spotGrid, twap };
export {
  meetsMinSize,
  minSizeDetail,
  requirementOf,
  type MinSizeDetail,
  type Requirement,
} from "./requirements";
export { costPerMillion, costUsed, volumeMaker, type VolumeMakerState } from "./volume-maker";
export {
  VOLUME_MAKER_MARKETS,
  volumeMakerSchema,
  type VolumeMakerConfig,
} from "./volume-maker/schema";

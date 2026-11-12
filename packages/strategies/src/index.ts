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
export * from "./paper";
export { safetyOffsetPct } from "./common/dca-bot";
export { entryReady, type EntryCondition, type NextCycle, type WaitingInfo } from "./common/entry";
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

export { STRATEGIES, waitingOf, type LaunchedStrategy, type StrategyEntry } from "./registry";
export * from "./backtest";
export { fundingArb, futuresDca, futuresGrid, rebalancing, recurringBuy, spotDca, spotGrid, twap };
export {
  copyMarkets,
  meetsMinSize,
  minSizeDetail,
  requirementOf,
  type MinSizeDetail,
  type Requirement,
} from "./requirements";
export { costPerMillion, costUsed, volumeMaker, type VolumeMakerState } from "./volume-maker";
export {
  FARM_TIMING,
  farmNet,
  farmStopFraction,
  farmRandom,
  stepVolumeFarm,
  volumeFarm,
  type VolumeFarmState,
} from "./volume-farm";
export {
  buildTrades,
  currentParams,
  realFeeRates,
  replayOptions,
  REVIEW_GRID,
  REVIEW_MIN_TRADES,
  REVIEW_SOLID_TRADES,
  REVIEW_STRONG_TRADES,
  reviewTrades,
  reviewVolumeFarm,
  type ReplayOption,
  type ReplayOutcome,
  type ReviewFill,
  type ReviewParams,
  type ReviewResult,
  type ReviewTrade,
} from "./volume-farm/review";
export { volumeFarmSchema, type VolumeFarmConfig } from "./volume-farm/schema";
export { farmSignal, type FarmSignal } from "./volume-farm/signal";
export {
  VM_DEFAULTS,
  VM_LEVERAGE_MAX,
  vmMaxInventory,
  volumeMakerSchema,
  type VolumeMakerConfig,
} from "./volume-maker/schema";
export {
  adaptiveDca,
  adcaBreakEven,
  adcaDecision,
  adcaMarket,
  adcaSafetyPrice,
  regimeAllows,
  rsi,
  ADCA,
  type AdaptiveDcaState,
  type AdcaDecision,
} from "./adaptive-dca";
export { adaptiveDcaSchema, ADCA_DEFAULTS, type AdaptiveDcaConfig } from "./adaptive-dca/schema";
export {
  capTarget,
  copyLedgerTotals,
  copyNet,
  copyPositions,
  isMultiMarketCopyState,
  copyTrade,
  freshSize,
  leaderMove,
  normalizeCopyState,
  COPY,
  type CopyMarketState,
  type CopyTradeState,
  type LeaderMove,
} from "./copy-trade";
export {
  copyTradeSchema,
  leaderAddressSchema,
  COPY_DEFAULTS,
  COPY_MAX_MARKETS,
  type CopyTradeConfig,
} from "./copy-trade/schema";

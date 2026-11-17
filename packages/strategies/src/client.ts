// Entry cho trình duyệt (`@drift/strategies/client`): chỉ schema config, giá trị mặc định và hàm hiển thị thuần
// (preview, giới hạn form) vốn đã là hành vi công khai của sản phẩm. Không export, và không import, module logic bước
// (step / timer / tín hiệu / giá đặt lệnh / thoát lệnh) của chiến lược nào: chunk tĩnh của web ai cũng tải được.
// File này chỉ được import từ `./*/schema`, `./schemas`, `./common/{dca-math,grid,perps,schema,entry}`,
// `./recurring-buy/schedule` và `./rebalancing/constants`; test `apps/web/src/features/bots/__tests__/strategies-client-entry.test.ts` giữ quy tắc đó.

export { safetyOffsetPct } from "./common/dca-math";
export { gridPrices, stepCoversFees } from "./common/grid";
export { gridStopLimits, leverageCapIssue, perpsStopMaxPct } from "./common/perps";
export { REBALANCE_CHECK_MS } from "./rebalancing/constants";
export { nextRun } from "./recurring-buy/schedule";
export { STRATEGY_SCHEMAS } from "./schemas";

export { adaptiveDcaSchema, ADCA_DEFAULTS, type AdaptiveDcaConfig } from "./adaptive-dca/schema";
export {
  copyTradeSchema,
  leaderAddressSchema,
  COPY_DEFAULTS,
  COPY_MAX_MARKETS,
  type CopyTradeConfig,
} from "./copy-trade/schema";
export { fundingArbSchema } from "./funding-arb/schema";
export { futuresDcaSchema } from "./futures-dca/schema";
export { futuresGridSchema } from "./futures-grid/schema";
export { rebalancingSchema } from "./rebalancing/schema";
export { recurringBuySchema } from "./recurring-buy/schema";
export { spotDcaSchema } from "./spot-dca/schema";
export { spotGridSchema } from "./spot-grid/schema";
export { twapSchema } from "./twap/schema";
export { volumeFarmSchema, type VolumeFarmConfig } from "./volume-farm/schema";
export {
  VM_DEFAULTS,
  VM_LEVERAGE_MAX,
  vmMaxInventory,
  volumeMakerSchema,
  type VolumeMakerConfig,
} from "./volume-maker/schema";

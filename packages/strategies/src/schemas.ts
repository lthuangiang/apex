import { newsSignalConfigSchema, Strategy } from "@drift/shared";
import type { z } from "zod";

import { adaptiveDcaSchema } from "./adaptive-dca/schema";
import { copyTradeSchema } from "./copy-trade/schema";
import { fundingArbSchema } from "./funding-arb/schema";
import { futuresDcaSchema } from "./futures-dca/schema";
import { futuresGridSchema } from "./futures-grid/schema";
import { rebalancingSchema } from "./rebalancing/schema";
import { recurringBuySchema } from "./recurring-buy/schema";
import { spotDcaSchema } from "./spot-dca/schema";
import { spotGridSchema } from "./spot-grid/schema";
import { twapSchema } from "./twap/schema";
import { volumeFarmSchema } from "./volume-farm/schema";
import { volumeMakerSchema } from "./volume-maker/schema";

// Schema config của mọi chiến lược chạy được, không kèm module logic. Registry (engine, backtest) và web
// (`@drift/strategies/client`) dùng chung, để web parse form mà không kéo logic bước của chiến lược nào vào bundle.

export const STRATEGY_SCHEMAS = {
  [Strategy.spotGrid]: spotGridSchema,
  [Strategy.futuresGrid]: futuresGridSchema,
  [Strategy.spotDca]: spotDcaSchema,
  [Strategy.futuresDca]: futuresDcaSchema,
  [Strategy.recurringBuy]: recurringBuySchema,
  [Strategy.rebalancing]: rebalancingSchema,
  [Strategy.fundingArb]: fundingArbSchema,
  [Strategy.twap]: twapSchema,
  [Strategy.volumeMaker]: volumeMakerSchema,
  [Strategy.volumeFarm]: volumeFarmSchema,
  [Strategy.adaptiveDca]: adaptiveDcaSchema,
  [Strategy.copyTrade]: copyTradeSchema,
  // Bot tín hiệu tin tức mainnet (#419): chỉ có schema; module chạy và dòng trong `STRATEGIES` (engines: perps) thêm ở PR
  // strategies. Không nằm trong `BOT_STRATEGIES`, nên route tạo bot chung không tạo được.
  [Strategy.newsSignal]: newsSignalConfigSchema,
} as const satisfies Record<string, z.ZodType>;

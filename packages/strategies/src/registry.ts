import { Strategy } from "@drift/shared";
import type { z } from "zod";

import { adaptiveDca } from "./adaptive-dca";
import { adaptiveDcaSchema } from "./adaptive-dca/schema";
import type { WaitingInfo } from "./common/entry";
import { copyTrade } from "./copy-trade";
import { copyTradeSchema } from "./copy-trade/schema";
import type { StrategyModule } from "./core/types";
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
import { volumeFarm } from "./volume-farm";
import { volumeFarmSchema } from "./volume-farm/schema";
import { volumeMaker } from "./volume-maker";
import { volumeMakerSchema } from "./volume-maker/schema";

// Registry chiến lược: engine (chạy thật) và backtest (mô phỏng) dùng chung để có cùng chuỗi hành động.

export interface StrategyEntry {
  schema: z.ZodType;
  module: StrategyModule<never, unknown>;
  engines: readonly ("spot" | "perps")[];
}

export const STRATEGIES = {
  [Strategy.spotGrid]: { schema: spotGridSchema, module: spotGrid, engines: ["spot"] },
  [Strategy.futuresGrid]: { schema: futuresGridSchema, module: futuresGrid, engines: ["perps"] },
  [Strategy.spotDca]: { schema: spotDcaSchema, module: spotDca, engines: ["spot"] },
  [Strategy.futuresDca]: { schema: futuresDcaSchema, module: futuresDca, engines: ["perps"] },
  [Strategy.recurringBuy]: { schema: recurringBuySchema, module: recurringBuy, engines: ["spot"] },
  [Strategy.rebalancing]: { schema: rebalancingSchema, module: rebalancing, engines: ["spot"] },
  [Strategy.fundingArb]: {
    schema: fundingArbSchema,
    module: fundingArb,
    engines: ["spot", "perps"],
  },
  [Strategy.twap]: { schema: twapSchema, module: twap, engines: ["spot", "perps"] },
  // Bot khối lượng: chỉ cho tài khoản được admin bật (DEC-80); api và engine kiểm tra `users.volume_bots`.
  [Strategy.volumeMaker]: { schema: volumeMakerSchema, module: volumeMaker, engines: ["perps"] },
  [Strategy.volumeFarm]: { schema: volumeFarmSchema, module: volumeFarm, engines: ["perps"] },
  [Strategy.adaptiveDca]: { schema: adaptiveDcaSchema, module: adaptiveDca, engines: ["perps"] },
  // Copy Trade (DEC-161, DEC-163): chỉ cho tài khoản được bật AI Desk (`users.ai_desk`); api kiểm tra.
  [Strategy.copyTrade]: { schema: copyTradeSchema, module: copyTrade, engines: ["perps"] },
} as const;

export type LaunchedStrategy = keyof typeof STRATEGIES;

/**
 * Bot đang chờ điều kiện vào ("Waiting for price", DEC-91), tính từ config và state đã lưu của engine.
 * Chỉ để hiển thị; null khi không chờ, config không parse được hoặc chưa có state.
 */
export function waitingOf(strategy: string, config: unknown, state: unknown): WaitingInfo | null {
  const entry = (STRATEGIES as Record<string, StrategyEntry | undefined>)[strategy];
  const waiting = entry?.module.waiting as
    ((c: unknown, s: unknown) => WaitingInfo | null) | undefined;
  if (entry === undefined || waiting === undefined) return null;
  if (state === null || typeof state !== "object") return null;
  const parsed = entry.schema.safeParse(config);
  if (!parsed.success) return null;
  try {
    return waiting(parsed.data, state);
  } catch {
    return null;
  }
}

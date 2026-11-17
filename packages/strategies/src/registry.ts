import { Strategy } from "@drift/shared";
import type { z } from "zod";

import { adaptiveDca } from "./adaptive-dca";
import type { WaitingInfo } from "./common/entry";
import { copyTrade } from "./copy-trade";
import type { StrategyModule } from "./core/types";
import { fundingArb } from "./funding-arb";
import { futuresDca } from "./futures-dca";
import { futuresGrid } from "./futures-grid";
import { rebalancing } from "./rebalancing";
import { recurringBuy } from "./recurring-buy";
import { STRATEGY_SCHEMAS as S } from "./schemas";
import { spotDca } from "./spot-dca";
import { spotGrid } from "./spot-grid";
import { twap } from "./twap";
import { volumeFarm } from "./volume-farm";
import { volumeMaker } from "./volume-maker";

// Registry chiến lược: engine (chạy thật) và backtest (mô phỏng) dùng chung để có cùng chuỗi hành động.

export interface StrategyEntry {
  schema: z.ZodType;
  module: StrategyModule<never, unknown>;
  engines: readonly ("spot" | "perps")[];
}

export const STRATEGIES = {
  [Strategy.spotGrid]: { schema: S[Strategy.spotGrid], module: spotGrid, engines: ["spot"] },
  [Strategy.futuresGrid]: {
    schema: S[Strategy.futuresGrid],
    module: futuresGrid,
    engines: ["perps"],
  },
  [Strategy.spotDca]: { schema: S[Strategy.spotDca], module: spotDca, engines: ["spot"] },
  [Strategy.futuresDca]: { schema: S[Strategy.futuresDca], module: futuresDca, engines: ["perps"] },
  [Strategy.recurringBuy]: {
    schema: S[Strategy.recurringBuy],
    module: recurringBuy,
    engines: ["spot"],
  },
  [Strategy.rebalancing]: {
    schema: S[Strategy.rebalancing],
    module: rebalancing,
    engines: ["spot"],
  },
  [Strategy.fundingArb]: {
    schema: S[Strategy.fundingArb],
    module: fundingArb,
    engines: ["spot", "perps"],
  },
  [Strategy.twap]: { schema: S[Strategy.twap], module: twap, engines: ["spot", "perps"] },
  // Bot khối lượng: chỉ cho tài khoản được admin bật (DEC-80); api và engine kiểm tra `users.volume_bots`.
  [Strategy.volumeMaker]: {
    schema: S[Strategy.volumeMaker],
    module: volumeMaker,
    engines: ["perps"],
  },
  [Strategy.volumeFarm]: { schema: S[Strategy.volumeFarm], module: volumeFarm, engines: ["perps"] },
  [Strategy.adaptiveDca]: {
    schema: S[Strategy.adaptiveDca],
    module: adaptiveDca,
    engines: ["perps"],
  },
  // Copy Trade (DEC-161, DEC-163): chỉ cho tài khoản được bật AI Desk (`users.ai_desk`); api kiểm tra.
  [Strategy.copyTrade]: { schema: S[Strategy.copyTrade], module: copyTrade, engines: ["perps"] },
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

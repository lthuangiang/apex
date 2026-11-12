import { Strategy } from "@drift/shared";

// Danh sách chiến lược trên Landing (artboard "Landing · Public"): 8 chiến lược chính, cộng nhóm Volume & Liquidity
// (Market Making, Volume Farming) mở cho mọi tài khoản từ DEC-94.

export type EngineFilter = "all" | "spot" | "perps";

export const LANDING_STRATEGIES: readonly {
  key: Strategy;
  engines: readonly ("spot" | "perps")[];
}[] = [
  { key: Strategy.spotGrid, engines: ["spot"] },
  { key: Strategy.futuresGrid, engines: ["perps"] },
  { key: Strategy.spotDca, engines: ["spot"] },
  { key: Strategy.futuresDca, engines: ["perps"] },
  { key: Strategy.recurringBuy, engines: ["spot"] },
  { key: Strategy.rebalancing, engines: ["spot"] },
  { key: Strategy.fundingArb, engines: ["spot", "perps"] },
  { key: Strategy.twap, engines: ["spot", "perps"] },
];

export const LANDING_VOLUME_STRATEGIES = [Strategy.volumeMaker, Strategy.volumeFarm] as const;

export function strategiesFor(filter: EngineFilter): Strategy[] {
  return LANDING_STRATEGIES.filter((s) => filter === "all" || s.engines.includes(filter)).map(
    (s) => s.key,
  );
}

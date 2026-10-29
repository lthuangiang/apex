import { Strategy } from "@drift/shared";

// Danh sách chiến lược trên Landing (artboard "Landing · Public"): cùng 8 chiến lược của Strategy catalog.
// Volume Maker không có ở đây vì đang khoá bằng VOLUME_MAKER_ENABLED (DEC-43) và trang này không cần phiên.

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

export function strategiesFor(filter: EngineFilter): Strategy[] {
  return LANDING_STRATEGIES.filter((s) => filter === "all" || s.engines.includes(filter)).map(
    (s) => s.key,
  );
}

import { describe, expect, it } from "vitest";

import { meetsMinSize, requirementOf } from "../requirements";

const rules = { tickSize: "1", stepSize: "0.0001", minQuantity: "0.0001", minNotional: "5" };

describe("start requirements", () => {
  it("computes DCA max capital from the ladder", () => {
    const c = {
      market: "m",
      baseOrder: "50",
      safetyOrder: "50",
      maxSafetyOrders: 3,
      sizeMultiplier: "2",
    };
    // 50 + 50 + 100 + 200
    expect(requirementOf("spot_dca", c).capital).toBe("400");
  });

  it("checks grid levels against min notional after rounding", () => {
    const c = {
      market: "m",
      lowerPrice: "90",
      upperPrice: "110",
      gridLevels: 5,
      spacing: "arithmetic",
      investment: "500",
    };
    expect(meetsMinSize("spot_grid", c, rules, "100")).toBe(true);
    expect(meetsMinSize("spot_grid", { ...c, investment: "20" }, rules, "100")).toBe(false);
  });
});

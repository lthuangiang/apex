import { describe, expect, it } from "vitest";

import { gridPrices, minStepFraction, stepCoversFees } from "../common/grid";

const rules = { tickSize: "0.01", stepSize: "0.001", minQuantity: "0.001", minNotional: "5" };

describe("gridPrices", () => {
  it("spaces arithmetic levels evenly by price", () => {
    expect(gridPrices("100", "110", 6, "arithmetic", rules)).toEqual([
      "100",
      "102",
      "104",
      "106",
      "108",
      "110",
    ]);
  });

  it("spaces geometric levels evenly by percent and rounds to tick", () => {
    // 100 × 1.21^(i/2): 100, 110, 121
    expect(gridPrices("100", "121", 3, "geometric", rules)).toEqual(["100", "110", "121"]);
  });

  it("merges levels that collapse onto the same tick", () => {
    expect(gridPrices("1", "1.02", 5, "arithmetic", { ...rules, tickSize: "0.01" })).toEqual([
      "1",
      "1.01",
      "1.02",
    ]);
  });

  it("checks the step against round-trip fees", () => {
    const prices = ["100", "100.05", "100.1"];
    expect(minStepFraction(prices).toNumber()).toBeCloseTo(0.05 / 100.05, 12);
    expect(stepCoversFees(prices, "0.0005")).toBe(false);
    expect(stepCoversFees(["100", "101"], "0.0005")).toBe(true);
  });
});

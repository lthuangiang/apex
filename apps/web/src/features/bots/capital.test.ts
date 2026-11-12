import { describe, expect, it } from "vitest";

import { capitalOf } from "./capital";

describe("capitalOf (vốn gửi cho AI parameters)", () => {
  it("reads investment or margin", () => {
    expect(capitalOf("spot_grid", { investment: "500" })).toBe("500");
    expect(capitalOf("futures_grid", { margin: "200" })).toBe("200");
  });

  it("sums the DCA ladder and recurring budget", () => {
    // 100 + 50 + 50×2 + 50×4
    expect(
      capitalOf("spot_dca", {
        baseOrder: "100",
        safetyOrder: "50",
        sizeMultiplier: "2",
        maxSafetyOrders: "3",
      }),
    ).toBe("450");
    expect(capitalOf("recurring_buy", { amountPerBuy: "25", buyCount: "4" })).toBe("100");
  });

  it("returns undefined when the field is empty, zero or not a number", () => {
    expect(capitalOf("spot_grid", { investment: "" })).toBeUndefined();
    expect(capitalOf("spot_grid", { investment: "0" })).toBeUndefined();
    expect(capitalOf("spot_grid", { investment: "abc" })).toBeUndefined();
    expect(capitalOf("recurring_buy", { amountPerBuy: "" })).toBeUndefined();
  });

  it("reads the recurring budget from the chosen end condition", () => {
    expect(
      capitalOf("recurring_buy", { amountPerBuy: "25", ends: "after_budget", totalBudget: "300" }),
    ).toBe("300");
    // "Never": số lần mua mặc định của engine đề xuất (20).
    expect(capitalOf("recurring_buy", { amountPerBuy: "25", ends: "never" })).toBe("500");
  });
});

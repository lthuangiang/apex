import { describe, expect, it } from "vitest";

import { meetsMinSize, minSizeDetail } from "../requirements";

// Dữ liệu thật của draft "NVDA" trong UI_REVIEW H2 và quy tắc market `vNVDA_vUSDC` đọc từ SoDEX ngày 2026-10-29.
const rules = { tickSize: "0.01", stepSize: "0.001", minQuantity: "0.001", minNotional: "5" };
const nvda = {
  market: "vNVDA_vUSDC",
  lowerPrice: "212.64",
  upperPrice: "239.12",
  gridLevels: 10,
  spacing: "arithmetic",
  investment: "50",
  maxLoss: "10",
  onStop: "keep_base",
};

describe("minSizeDetail (UI_REVIEW H2)", () => {
  it("fails the NVDA draft because the smallest rounded order is below 5 USDC", () => {
    expect(meetsMinSize("spot_grid", nvda, rules, "225")).toBe(false);
    const d = minSizeDetail("spot_grid", nvda, rules, "225");
    expect(d.required).toBe("5");
    expect(Number(d.smallest)).toBeLessThan(5);
    expect(d.capitalField).toBe("investment");
  });

  it("suggests the smallest investment that passes, and it really passes", () => {
    const d = minSizeDetail("spot_grid", nvda, rules, "225");
    const suggested = d.suggestedCapital ?? "";
    expect(Number(suggested)).toBeGreaterThan(50);
    expect(meetsMinSize("spot_grid", { ...nvda, investment: suggested }, rules, "225")).toBe(true);
    // 0.01 thấp hơn thì không đạt: đúng là mức nhỏ nhất.
    const below = (Number(suggested) - 0.01).toFixed(2);
    expect(meetsMinSize("spot_grid", { ...nvda, investment: below }, rules, "225")).toBe(false);
  });

  it("reports no suggestion for DCA, whose total comes from two fields", () => {
    const d = minSizeDetail(
      "spot_dca",
      {
        baseOrder: "1",
        safetyOrder: "1",
        maxSafetyOrders: 3,
        firstStepPct: "1",
        stepMultiplier: "1",
      },
      rules,
      "225",
    );
    expect(d.capitalField).toBeNull();
    expect(d.suggestedCapital).toBeNull();
    expect(d.smallest).not.toBeNull();
  });
});

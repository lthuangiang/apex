import { describe, expect, it } from "vitest";

import { depthFitOf, largestPositionOf } from "../depth-hint";
import { agoParts, marketLabel, shortMarketLabel, usd } from "../shape";

import { antPerps, NOW } from "./fixtures";

// Hàm thuần của US Market (#591): tổng vị thế lớn nhất theo cấu hình (cùng quy tắc với server #590), so với sổ lệnh,
// tên market, "N days ago", tiền USD.

describe("largestPositionOf", () => {
  it("is margin × leverage for Futures Grid and investment for Spot Grid", () => {
    expect(largestPositionOf("futures_grid", { margin: "600", leverage: 2 })).toEqual({
      notional: "1200",
      kind: "grid_perps",
    });
    expect(largestPositionOf("spot_grid", { investment: "500" })).toEqual({
      notional: "500",
      kind: "grid_spot",
    });
  });

  it("adds every DCA buy (safety sizes grow by the multiplier), times leverage on perps", () => {
    const c = {
      baseOrder: "100",
      safetyOrder: "50",
      maxSafetyOrders: 3,
      sizeMultiplier: "2",
      leverage: 3,
    };
    // 100 + 50 + 100 + 200 = 450
    expect(largestPositionOf("spot_dca", c)).toEqual({ notional: "450", kind: "dca_spot" });
    expect(largestPositionOf("futures_dca", c)).toEqual({ notional: "1350", kind: "dca_perps" });
  });

  it("is null when a field is missing or the strategy has no fixed market in the form", () => {
    expect(largestPositionOf("futures_grid", { margin: "", leverage: 2 })).toBeNull();
    expect(largestPositionOf("spot_dca", { baseOrder: "100" })).toBeNull();
    expect(largestPositionOf("funding_arb", { investment: "100" })).toBeNull();
  });
});

describe("depthFitOf", () => {
  const depth = antPerps().depth;
  it("fits up to and including the thinner side, too large above it", () => {
    expect(depthFitOf("1955", "trading", depth)).toEqual({ kind: "fits", limit: "1955" });
    expect(depthFitOf("1955.01", "trading", depth)).toEqual({ kind: "too_large", limit: "1955" });
  });
  it("is empty when one side is empty or the market is halted", () => {
    expect(depthFitOf("10", "empty", depth)).toEqual({ kind: "empty" });
    expect(depthFitOf("10", "halted", null)).toEqual({ kind: "empty" });
  });
  it("has no cap on a deep book, and nothing to say without depth", () => {
    expect(
      depthFitOf("99999", "trading", depth === null ? null : { ...depth, maxPositionUsd: null }),
    ).toEqual({ kind: "no_cap" });
    expect(depthFitOf("10", null, null)).toBeNull();
  });
});

describe("labels and formats", () => {
  it("writes market names as SoDEX returns them", () => {
    expect(marketLabel("ANT-USD")).toBe("ANT-USD");
    expect(marketLabel("vANT_vUSDC")).toBe("vANT / vUSDC");
    expect(shortMarketLabel("vANT_vUSDC")).toBe("vANT");
    expect(shortMarketLabel("ANT-USD")).toBe("ANT-USD");
  });
  it("formats USD with the sign before the dollar, and null stays null", () => {
    expect(usd("2449")).toBe("$2,449.00");
    expect(usd("12.05", true)).toBe("+$12.05");
    expect(usd("-3.05", true)).toBe("−$3.05");
    expect(usd(null)).toBeNull();
  });
  it("counts minutes, hours and days ago, never negative", () => {
    expect(agoParts(new Date(NOW - 30_000).toISOString(), NOW)).toEqual({ unit: "now", n: 0 });
    expect(agoParts(new Date(NOW - 5 * 60_000).toISOString(), NOW)).toEqual({
      unit: "minutes",
      n: 5,
    });
    expect(agoParts(new Date(NOW - 3 * 3_600_000).toISOString(), NOW)).toEqual({
      unit: "hours",
      n: 3,
    });
    expect(agoParts(new Date(NOW - 11 * 86_400_000).toISOString(), NOW)).toEqual({
      unit: "days",
      n: 11,
    });
    expect(agoParts(new Date(NOW + 60_000).toISOString(), NOW)).toEqual({ unit: "now", n: 0 });
  });
});

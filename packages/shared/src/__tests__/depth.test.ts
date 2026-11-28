import { describe, expect, it } from "vitest";

import {
  copyMarkets,
  DEFAULT_DEPTH_CAP_MARKETS,
  DEPTH_LEVELS,
  DEPTH_THIN_USD,
  DEPTH_VERY_THIN_USD,
  depthCapApplies,
  depthCapLabel,
  depthLabelOf,
  ENTRY_DEPTH_SHARE,
  inDepthCapScope,
  largestPositionOf,
  maxPositionsOf,
  parseDepthCapMarkets,
  positionDepthIssue,
  raisedPositions,
  sideNotional,
  VM_MAX_INVENTORY_MULTIPLE,
} from "../index";

// Một nguồn cho độ sâu sổ lệnh (#588): ngưỡng, nhãn, phạm vi và tổng vị thế tối đa dùng chung cho api, engine và web.

const sides = (bidNotional: string, askNotional: string) => ({ bidNotional, askNotional });

describe("depth thresholds", () => {
  it("keeps DEC-402 values: 10 levels, Thin < 10,000, Very thin < 1,000, 25% per entry order", () => {
    expect(DEPTH_LEVELS).toBe(10);
    expect(DEPTH_THIN_USD).toBe("10000");
    expect(DEPTH_VERY_THIN_USD).toBe("1000");
    expect(ENTRY_DEPTH_SHARE).toBe("0.25");
    expect(VM_MAX_INVENTORY_MULTIPLE).toBe(2);
  });

  it("labels the page and the cap with the same thresholds", () => {
    const cases: [string, string, string, string][] = [
      ["50000", "10000", "ok", "deep"],
      ["50000", "9999.99", "thin", "thin"],
      ["1000", "20000", "thin", "thin"],
      ["999.99", "20000", "very_thin", "very_thin"],
    ];
    for (const [bid, ask, page, cap] of cases) {
      expect(depthLabelOf(bid, ask)).toBe(page);
      expect(depthCapLabel(sides(bid, ask))).toBe(cap);
    }
    expect(depthCapLabel(sides("0", "5000"))).toBe("empty");
    expect(depthCapLabel(null)).toBe("empty");
    expect(depthCapApplies("deep")).toBe(false);
    expect(depthCapApplies("empty")).toBe(true);
  });

  it("adds notional of the first 10 levels only", () => {
    const levels = Array.from({ length: 12 }, () => ["10", "1"] as const);
    expect(sideNotional(levels)).toBe("100");
    expect(sideNotional([])).toBe("0");
  });
});

describe("DEPTH_CAP_MARKETS", () => {
  it("defaults to Anthropic + 8 fund tokens, empty turns it off, * is every market", () => {
    expect(parseDepthCapMarkets(undefined).markets).toEqual([...DEFAULT_DEPTH_CAP_MARKETS]);
    expect(DEFAULT_DEPTH_CAP_MARKETS).toHaveLength(10);
    expect(inDepthCapScope(parseDepthCapMarkets(""), "ANT-USD")).toBe(false);
    expect(inDepthCapScope(parseDepthCapMarkets("*"), "BTC-USD")).toBe(true);
    expect(parseDepthCapMarkets(" A, ,B,A ")).toEqual({ all: false, markets: ["A", "B"] });
  });
});

describe("largestPositionOf (web hint) uses the api formula", () => {
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

  it("adds every DCA buy, times leverage on perps; a missing multiplier counts as 1", () => {
    const c = { baseOrder: "100", safetyOrder: "50", maxSafetyOrders: 3, sizeMultiplier: "2" };
    expect(largestPositionOf("spot_dca", c)).toEqual({ notional: "450", kind: "dca_spot" });
    expect(largestPositionOf("futures_dca", { ...c, leverage: 3 })).toEqual({
      notional: "1350",
      kind: "dca_perps",
    });
    expect(
      largestPositionOf("spot_dca", { baseOrder: "100", safetyOrder: "50", maxSafetyOrders: 2 }),
    ).toEqual({ notional: "200", kind: "dca_spot" });
  });

  it("is null when a required field is missing or invalid, or the strategy has no hint", () => {
    expect(largestPositionOf("futures_grid", { margin: "", leverage: 2 })).toBeNull();
    expect(largestPositionOf("spot_grid", { investment: "abc" })).toBeNull();
    expect(largestPositionOf("spot_dca", { baseOrder: "100" })).toBeNull();
    expect(largestPositionOf("funding_arb", { investment: "100" })).toBeNull();
  });

  it("matches maxPositionsOf for a complete config", () => {
    const configs: [string, Record<string, unknown>][] = [
      ["futures_grid", { market: "ANT-USD", margin: "250.5", leverage: 4 }],
      ["spot_grid", { market: "vANT_vUSDC", investment: "800" }],
      [
        "futures_dca",
        {
          market: "ANT-USD",
          baseOrder: "40",
          safetyOrder: "20",
          maxSafetyOrders: 4,
          sizeMultiplier: "1.5",
          leverage: 2,
        },
      ],
    ];
    for (const [strategy, c] of configs)
      expect(largestPositionOf(strategy, c)?.notional).toBe(
        maxPositionsOf(strategy, c)[0]?.notional,
      );
  });
});

describe("max position vs book", () => {
  const p = { market: "ANT-USD", engine: "perps" as const, notional: "5000" };
  it("checks only thin books, up to the thinner side", () => {
    expect(positionDepthIssue(p, sides("20000", "15000"))).toBeNull();
    expect(positionDepthIssue(p, sides("4200.7", "9000"))).toEqual({
      kind: "too_large",
      market: "ANT-USD",
      limit: "4200",
      notional: "5000",
    });
    expect(positionDepthIssue(p, null)).toEqual({ kind: "empty", market: "ANT-USD" });
  });
  it("re-checks an edit only where the max position goes up", () => {
    expect(raisedPositions([p], [{ ...p, notional: "5000" }])).toEqual([]);
    expect(raisedPositions([p], [{ ...p, notional: "5000.01" }])).toHaveLength(1);
  });
  it("uses Volume Maker's default inventory and every copy market", () => {
    expect(maxPositionsOf("volume_maker", { market: "ANT-USD", orderSize: "100" })).toEqual([
      { market: "ANT-USD", engine: "perps", notional: "200" },
    ]);
    expect(copyMarkets({ markets: ["A", 1, "B"] })).toEqual(["A", "B"]);
    expect(copyMarkets({ market: "C" })).toEqual(["C"]);
  });
});

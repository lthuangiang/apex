import { describe, expect, it } from "vitest";

import { chartLevels, chartModeOf } from "../chart-levels";
import { heatStep, priceScale } from "../components/market-chart";

const keys = (l: { key: string; price: string }[]) => l.map((x) => `${x.key}:${x.price}`);

describe("chartModeOf (IMP-05)", () => {
  it("hides the widget for Rebalancing and the map for Funding Arb and volume bots", () => {
    expect(chartModeOf("rebalancing")).toBe("none");
    expect(chartModeOf("funding_arb")).toBe("price");
    expect(chartModeOf("volume_farm")).toBe("price");
    expect(chartModeOf("spot_grid")).toBe("price_and_map");
    expect(chartModeOf("twap")).toBe("price_and_map");
  });
});

describe("chartLevels (IMP-05)", () => {
  it("draws grid upper, lower, entry and stop", () => {
    expect(
      keys(
        chartLevels(
          "spot_grid",
          {
            upperPrice: "110",
            lowerPrice: "90",
            entry: "at_price",
            entryPrice: "100",
            stopPrice: "85",
          },
          "101",
        ),
      ),
    ).toEqual(["upper:110", "lower:90", "entry:100", "stop:85"]);
    expect(
      keys(
        chartLevels(
          "futures_grid",
          {
            upperPrice: "110",
            lowerPrice: "90",
            entry: "in_range",
            entryLow: "95",
            entryHigh: "99",
            stopBelow: "80",
            stopAbove: "120",
          },
          null,
        ),
      ),
    ).toEqual(["upper:110", "lower:90", "entryLow:95", "entryHigh:99", "stop:80", "stopAbove:120"]);
  });

  it("skips empty or invalid values instead of guessing", () => {
    expect(chartLevels("spot_grid", { upperPrice: "", lowerPrice: "abc" }, "100")).toEqual([]);
    expect(chartLevels("spot_dca", { entry: "now", takeProfitPct: "2" }, null)).toEqual([]);
  });

  it("draws DCA long safeties below the entry, take profit above and stop below", () => {
    const l = chartLevels(
      "futures_dca",
      {
        direction: "long",
        entry: "at_price",
        entryPrice: "100",
        maxSafetyOrders: "2",
        firstStepPct: "1",
        stepMultiplier: "2",
        takeProfitPct: "2",
        stopLossPct: "10",
      },
      "105",
    );
    expect(keys(l)).toEqual(["entry:100", "safety:99", "safety:97", "takeProfit:102", "stop:90"]);
    expect(l[1]?.params).toEqual({ n: "1" });
  });

  it("mirrors DCA levels for Short and uses the range low as first entry", () => {
    const l = chartLevels(
      "futures_dca",
      {
        direction: "short",
        entry: "in_range",
        entryLow: "100",
        entryHigh: "104",
        maxSafetyOrders: "1",
        firstStepPct: "1",
        takeProfitPct: "2",
        stopLossPct: "10",
      },
      "95",
    );
    expect(keys(l)).toEqual([
      "entryLow:100",
      "entryHigh:104",
      "safety:101",
      "takeProfit:98",
      "stop:110",
    ]);
  });

  it("uses the last price for Now and caps safety lines at 10", () => {
    const l = chartLevels(
      "spot_dca",
      { entry: "now", maxSafetyOrders: "25", firstStepPct: "1", stepMultiplier: "1" },
      "200",
    );
    expect(l[0]).toEqual({ key: "entryNow", price: "200" });
    expect(l.filter((x) => x.key === "safety")).toHaveLength(10);
  });

  it("draws Skip above for Recurring Buy and Price limit for TWAP", () => {
    expect(keys(chartLevels("recurring_buy", { skipAbovePrice: "70000" }, null))).toEqual([
      "skipAbove:70000",
    ]);
    expect(keys(chartLevels("twap", { priceLimit: "3000" }, null))).toEqual(["priceLimit:3000"]);
    expect(chartLevels("funding_arb", {}, "1")).toEqual([]);
  });
});

describe("chart helpers", () => {
  it("maps band value to 7 heat steps", () => {
    expect(heatStep(0, 10)).toBe(0);
    expect(heatStep(1, 10)).toBe(1);
    expect(heatStep(10, 10)).toBe(7);
    expect(heatStep(5, 0)).toBe(0);
  });

  it("price scale covers candles and levels", () => {
    const s = priceScale([{ t: 1, o: "100", h: "105", l: "95", c: "101" }], [120]);
    expect(s.max).toBe(120);
    expect(s.min).toBe(95);
    expect(s.y(120)).toBeLessThan(s.y(95));
  });
});

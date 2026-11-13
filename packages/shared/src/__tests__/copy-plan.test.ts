import { describe, expect, it } from "vitest";

import { copyPlan, type CopyCandidate } from "../api/copy";
import { leverageSpecsOf } from "../leverage";

// Chọn market và đòn bẩy theo market (DEC-TBD-copy-pick-markets, CopyMarkets.md): đòn bẩy kẹp trong [1, min(SoDEX
// max, 5, trần Risk Center)]; cỡ mỗi lệnh không đổi theo đòn bẩy; trần tổng = budget × đòn bẩy thấp nhất (PM chốt 1B).

const tiers = [
  {
    maxNotionalValue: "100000",
    maintenanceMarginRate: "0.01",
    maxLeverage: 20,
    maintenanceDeduction: "0",
  },
];
const c = (market: string, maxLeverage: number, trades30d: number | null = 12): CopyCandidate => ({
  market,
  maxLeverage,
  tiers,
  trades30d,
});
const CANDS = [c("NEAR-USD", 10), c("ARB-USD", 10), c("FIL-USD", 1, null)];
const plan = (over: Partial<Parameters<typeof copyPlan>[0]> = {}) =>
  copyPlan({
    budget: "500",
    preset: "balanced",
    candidates: CANDS,
    riskCap: null,
    marginMode: "isolated",
    ...over,
  });

describe("copyPlan", () => {
  it("defaults to the safety level's leverage, lowered where SoDEX allows less, and caps exposure by the lowest", () => {
    const p = plan();
    expect(p.rows.map((r) => [r.market, r.leverage, r.maxLeverage])).toEqual([
      ["NEAR-USD", 2, 5],
      ["ARB-USD", 2, 5],
      ["FIL-USD", 1, 1],
    ]);
    expect(p.lowestLeverage).toBe(1);
    expect(p.mixed).toBe(true);
    // Budget 500 × 1× = 500: ký quỹ không bao giờ vượt budget.
    expect(p.fields.maxExposure).toBe("500");
    // Cỡ mỗi lệnh Balanced = 500 × 2 × 0.25 = 250, không đổi theo đòn bẩy.
    expect(p.fields.fixedNotional).toBe("250");
    expect(p.rows.map((r) => r.marginPerPosition)).toEqual(["125", "125", "250"]);
    expect(p.leverageByMarket).toEqual({ "NEAR-USD": 2, "ARB-USD": 2, "FIL-USD": 1 });
    expect(p.rows[2]?.trades30d).toBeNull();
  });

  it("keeps the old cap when every picked market uses the safety level's leverage", () => {
    const p = plan({ selected: ["NEAR-USD", "ARB-USD"] });
    expect(p.lowestLeverage).toBe(2);
    expect(p.mixed).toBe(false);
    expect(p.fields.maxExposure).toBe("1000");
    expect(p.rows.find((r) => r.market === "FIL-USD")?.selected).toBe(false);
  });

  it("clamps per-market leverage to [1, min(SoDEX max, 5, Risk Center cap)]", () => {
    const p = plan({
      selected: ["NEAR-USD", "ARB-USD"],
      leverageByMarket: { "NEAR-USD": 9, "ARB-USD": 4 },
      riskCap: 3,
    });
    expect(p.rows.map((r) => [r.market, r.leverage, r.maxLeverage])).toEqual([
      ["NEAR-USD", 3, 3],
      ["ARB-USD", 3, 3],
      ["FIL-USD", 1, 1],
    ]);
    expect(plan({ leverageByMarket: { "NEAR-USD": 9 } }).rows[0]?.leverage).toBe(5);
  });

  it("never makes a single copy bigger than the total cap", () => {
    // Bold: cỡ mỗi lệnh 500 × 3 × 0.4 = 600 > trần 500 × 1 = 500.
    const p = plan({ preset: "bold" });
    expect(p.fields.maxExposure).toBe("500");
    expect(p.fields.fixedNotional).toBe("500");
    expect(p.fields.maxNotionalPerTrade).toBe("500");
  });

  it("shows the worse liquidation distance for isolated, and Not available for cross or no tiers", () => {
    const iso = plan({ selected: ["NEAR-USD"] }).rows[0];
    // Long: (0.5 − 0.01) / 0.99 ≈ 49.4%; short: (0.5 − 0.01) / 1.01 ≈ 48.5% → lấy số nhỏ hơn.
    expect(iso?.liquidationPct).toBe("48.5");
    expect(plan({ marginMode: "cross" }).rows[0]?.liquidationPct).toBeNull();
    expect(
      plan({ candidates: [{ ...c("NEAR-USD", 10), tiers: null }] }).rows[0]?.liquidationPct,
    ).toBeNull();
  });

  it("reports no lowest leverage when nothing is picked", () => {
    expect(plan({ selected: [] }).lowestLeverage).toBeNull();
  });
});

describe("leverageSpecsOf for copy bots", () => {
  it("uses leverage per market when set, the shared leverage otherwise", () => {
    expect(
      leverageSpecsOf("copy_trade", "BTC-USD", {
        markets: ["BTC-USD", "ETH-USD"],
        leverage: 2,
        marginMode: "isolated",
        leverageByMarket: { "ETH-USD": 4 },
      }),
    ).toEqual([
      { market: "BTC-USD", leverage: 2, marginMode: "isolated" },
      { market: "ETH-USD", leverage: 4, marginMode: "isolated" },
    ]);
  });
});

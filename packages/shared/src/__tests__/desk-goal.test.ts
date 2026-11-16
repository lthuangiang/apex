import { describe, expect, it } from "vitest";

import { goalGauge, goalLossOver } from "../desk/goal";

describe("desk goal gauge", () => {
  it("allows capital × max drop, with unsure as 5%", () => {
    expect(goalGauge({ capital: "5000", maxDrop: "10" }, null).limit).toBe("500");
    expect(goalGauge({ capital: "1000", maxDrop: "unsure" }, null).limit).toBe("50");
  });

  it("uses the Risk Center drawdown in USDC, never below zero, null without snapshots", () => {
    const g = { capital: "5000", maxDrop: "10" } as const;
    expect(goalGauge(g, { peakEquity: "5200", equity: "5125" }).used).toBe("75");
    expect(goalGauge(g, { peakEquity: "5000", equity: "5010" }).used).toBe("0");
    expect(goalGauge(g, { peakEquity: null, equity: "5000" }).used).toBeNull();
    expect(goalGauge(g, null).used).toBeNull();
  });
});

describe("goal loss over (RS-01, DEC-272)", () => {
  it("is over only when used passes the limit, never at the limit or without data", () => {
    expect(goalLossOver({ limit: "500", used: "500.01" })).toBe(true);
    expect(goalLossOver({ limit: "500", used: "500" })).toBe(false);
    expect(goalLossOver({ limit: "500", used: "75" })).toBe(false);
    expect(goalLossOver({ limit: "500", used: null })).toBe(false);
    expect(goalLossOver(null)).toBe(false);
  });
});

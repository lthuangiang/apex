import { describe, expect, it } from "vitest";

import {
  fillCostPerMillion,
  marketHoursQuerySchema,
  marketHoursViewSchema,
  minuteRangeBp,
  quantile,
  timeZoneSchema,
} from "../api/market-hours";
import { dec } from "../money";

// Market hours (DEC-TBD-market-hours): range 1 phút, trung vị / p90, Cost per $1M từ fill thật (markout 60 s), múi giờ.

describe("minute range", () => {
  it("is (high − low) ÷ mid in bp, and null for bad prices", () => {
    expect(minuteRangeBp("101", "99")?.toString()).toBe("200");
    expect(minuteRangeBp("100", "100")?.toString()).toBe("0");
    expect(minuteRangeBp("0", "0")).toBeNull();
    expect(minuteRangeBp("99", "101")).toBeNull();
  });
});

describe("quantile", () => {
  it("interpolates like Postgres percentile_cont", () => {
    const xs = ["1", "2", "3", "4"].map(dec);
    expect(quantile(xs, 0.5)?.toString()).toBe("2.5");
    expect(quantile(xs, 0.9)?.toString()).toBe("3.7");
    expect(quantile([], 0.5)).toBeNull();
  });
});

describe("cost per $1M from fills", () => {
  it("is fees minus the price move one minute later, per $1M of volume", () => {
    // Mua 1 @ 100, giá 1 phút sau 99.9: lỗ giá 0.1; phí 0.01. Bán 1 @ 100, giá sau 100.05: lỗ giá 0.05; phí 0.01.
    const c = fillCostPerMillion([
      { side: "buy", price: "100", size: "1", fee: "0.01", ref: "99.9" },
      { side: "sell", price: "100", size: "1", fee: "0.01", ref: "100.05" },
    ]);
    expect(c.volume.toString()).toBe("200");
    expect(c.fees.toString()).toBe("0.02");
    // (0.02 + 0.15) ÷ 200 × 1e6 = 850
    expect(c.costPerMillion?.toString()).toBe("850");
  });

  it("is Not available when more than 20% of the volume has no reference price", () => {
    const priced = { side: "buy" as const, price: "100", size: "3", fee: "0", ref: "100" };
    const missing = { side: "buy" as const, price: "100", size: "1", fee: "0", ref: null };
    expect(fillCostPerMillion([priced, missing]).costPerMillion).toBeNull();
    expect(
      fillCostPerMillion([priced, priced, priced, priced, missing]).costPerMillion?.toString(),
    ).toBe("0");
    expect(fillCostPerMillion([]).costPerMillion).toBeNull();
  });
});

describe("time zone", () => {
  it("accepts IANA names, half-hour zones and UTC, and rejects anything else", () => {
    expect(timeZoneSchema.safeParse("Asia/Ho_Chi_Minh").success).toBe(true);
    expect(timeZoneSchema.safeParse("Asia/Kolkata").success).toBe(true);
    expect(timeZoneSchema.safeParse("UTC").success).toBe(true);
    expect(timeZoneSchema.safeParse("Mars/Base").success).toBe(false);
    expect(timeZoneSchema.safeParse("Asia/Kolkata'; drop table bots; --").success).toBe(false);
  });

  it("defaults to 30 days, both strategies and UTC, and only allows 7 or 30 days", () => {
    expect(marketHoursQuerySchema.parse({})).toEqual({ days: 30, strategy: "both", tz: "UTC" });
    expect(marketHoursQuerySchema.safeParse({ days: "14" }).success).toBe(false);
    expect(marketHoursQuerySchema.parse({ days: "7", tz: "Asia/Kolkata" }).days).toBe(7);
  });
});

describe("heatmap", () => {
  it("has exactly 24 cells per day", () => {
    const cell = { ratio: null, medianBp: null };
    const day = (n: number) => [
      { date: "2026-11-02", cells: Array.from({ length: n }, () => cell) },
    ];
    const heatmap = marketHoursViewSchema.shape.heatmap;
    expect(heatmap.safeParse(day(24)).success).toBe(true);
    expect(heatmap.safeParse(day(23)).success).toBe(false);
    expect(heatmap.safeParse(day(25)).success).toBe(false);
  });
});

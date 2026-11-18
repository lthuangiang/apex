import { describe, expect, it } from "vitest";

import { compareGroups, costWindows, performanceCost } from "../api/desk-performance";
import { Decimal } from "../money";

// AI Desk "How your bots performed" (#234): tách phí, phần giá, khung giờ rẻ / đắt nhất, điều kiện hiện gợi ý.

const d = (v: number | string) => new Decimal(v);

describe("performanceCost", () => {
  it("splits SoDEX and DeskLabs fees and puts the rest of the loss on price", () => {
    // 1M volume, phí 151 (trong đó builder 45), net −214 → phần giá 63.
    const c = performanceCost({
      volume: d(1_000_000),
      fills: 500,
      fees: d(151),
      builderFee: d(45),
      net: d(-214),
    });
    expect(c.perMillion).toEqual({
      cost: "214",
      sodexFee: "106",
      builderFee: "45",
      priceMove: "63",
    });
    expect(c.cost).toBe("214");
  });

  it("shows a price move in your favour as a negative part and never a negative cost", () => {
    const c = performanceCost({
      volume: d(1_000_000),
      fills: 100,
      fees: d(100),
      builderFee: d(30),
      net: d(-40),
    });
    expect(c.priceMove).toBe("-60");
    expect(c.cost).toBe("40");
    const profit = performanceCost({
      volume: d(1_000_000),
      fills: 100,
      fees: d(100),
      builderFee: d(30),
      net: d(25),
    });
    expect(profit.cost).toBe("0");
    expect(profit.priceMove).toBe("-125");
  });

  it("leaves cost and price as Not available when a price is missing; fees stay", () => {
    const c = performanceCost({
      volume: d(500_000),
      fills: 50,
      fees: d(80),
      builderFee: d(20),
      net: null,
    });
    expect(c.cost).toBeNull();
    expect(c.priceMove).toBeNull();
    expect(c.perMillion.cost).toBeNull();
    expect(c.perMillion.sodexFee).toBe("120");
  });

  it("has no per-$1M numbers without volume", () => {
    const c = performanceCost({
      volume: d(0),
      fills: 0,
      fees: d(0),
      builderFee: d(0),
      net: d(0),
    });
    expect(c.perMillion).toEqual({ cost: null, sodexFee: null, builderFee: null, priceMove: null });
  });
});

describe("costWindows", () => {
  const hour = (fills: number, cpm: number) => ({
    fills,
    priced: d(10_000),
    costUsd: d(cpm).mul(10_000).div(1_000_000),
  });

  it("finds 3-hour windows, wraps past midnight and skips thin hours", () => {
    const sums = Array.from({ length: 24 }, (_, h) =>
      h === 5 ? hour(10, 1) : hour(40, h === 23 || h === 0 || h === 1 ? 50 : 200 + h),
    );
    const w = costWindows(sums);
    expect(w.cheapest?.from).toBe(23);
    expect(w.cheapest?.costPerMillion).toBe("50");
    expect(w.dearest?.from).toBe(20);
    // Giờ 5 có 10 fill: không khung nào chứa giờ 5.
    expect([3, 4, 5].includes(w.cheapest?.from ?? -1)).toBe(false);
  });

  it("returns only the cheapest when there is one window, and nothing without one", () => {
    const one = Array.from({ length: 24 }, (_, h) => (h >= 8 && h <= 10 ? hour(40, 100) : null));
    expect(costWindows(one)).toEqual({
      cheapest: { from: 8, costPerMillion: "100", fills: 120 },
      dearest: null,
    });
    expect(costWindows(Array.from({ length: 24 }, () => null))).toEqual({
      cheapest: null,
      dearest: null,
    });
  });
});

describe("compareGroups", () => {
  const g = (trades: number, cpm: number) => ({
    trades,
    volume: d(1_000_000),
    net: d(-cpm),
  });

  it("shows an idea only with 30 trades a side, 1.5× the cost and 20% of trades", () => {
    const c = compareGroups(g(40, 400), g(60, 200), 100);
    expect(c?.worseCost.toString()).toBe("400");
    expect(c?.betterCost.toString()).toBe("200");
    expect(c?.worseShare).toBe(0.4);
    expect(compareGroups(g(29, 400), g(60, 200), 100)).toBeNull();
    expect(compareGroups(g(40, 290), g(60, 200), 100)).toBeNull();
    expect(compareGroups(g(30, 400), g(170, 200), 200)).toBeNull();
  });
});

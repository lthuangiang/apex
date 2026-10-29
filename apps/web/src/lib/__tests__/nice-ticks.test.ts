import { describe, expect, it } from "vitest";

import { niceTicks } from "../nice-ticks";

describe("niceTicks", () => {
  it("rounds the review example 24.48–266 to hundreds", () => {
    expect(niceTicks(24.48, 266)).toEqual({ ticks: [0, 100, 200, 300], decimals: 0 });
  });

  it("covers the whole range with even steps", () => {
    const { ticks } = niceTicks(39_420, 40_180);
    expect(ticks[0]).toBeLessThanOrEqual(39_420);
    expect(ticks.at(-1)).toBeGreaterThanOrEqual(40_180);
    const steps = new Set(ticks.slice(1).map((v, i) => v - (ticks[i] ?? 0)));
    expect(steps.size).toBe(1);
  });

  it("uses shared decimals for small ranges", () => {
    expect(niceTicks(1.02, 1.07)).toEqual({ ticks: [1.02, 1.04, 1.06, 1.08], decimals: 2 });
  });

  it("handles a flat series", () => {
    const { ticks } = niceTicks(50, 50);
    expect(ticks[0]).toBeLessThan(50);
    expect(ticks.at(-1)).toBeGreaterThan(50);
  });

  it("keeps 2.5 steps at one decimal", () => {
    expect(niceTicks(0, 7)).toEqual({ ticks: [0, 2.5, 5, 7.5], decimals: 1 });
  });
});

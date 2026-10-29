import { describe, expect, it } from "vitest";

import { computeMarketStats, percentile, type DailyClose } from "../market-stats";

const DAY = 86_400_000;
const series = (prices: number[]): DailyClose[] =>
  prices.map((p, i) => ({ day: i * DAY, close: String(p) }));

describe("percentile", () => {
  it("interpolates linearly like numpy", () => {
    expect(percentile(["1", "2", "3", "4", "5"], 50)).toBe("3");
    expect(percentile(["10", "20"], 5)).toBe("10.5");
    expect(percentile([], 50)).toBeNull();
    // 30 giá: rank = 0.05 × 29 = 1.45, không được lẫn sai số float.
    const prices = Array.from({ length: 30 }, (_, i) => String(80000 + i * 10.1));
    expect(percentile(prices, 5)).toBe("80014.645");
  });
});

describe("computeMarketStats", () => {
  it("needs 31 closes for σ and 30 for percentiles", () => {
    const s = computeMarketStats(series(Array.from({ length: 29 }, () => 100)), [], 0);
    expect(s).toMatchObject({ sigma30: null, p5: null, trend: null, rangeScore: null });
  });

  it("computes σ, trend and percentiles on a hand-checked alternating series", () => {
    // Giá xen kẽ 100, 110 (31 ngày): log return ±ln(1.1); 30 return, 15 dương 15 âm.
    const prices = Array.from({ length: 31 }, (_, i) => (i % 2 === 0 ? 100 : 110));
    const s = computeMarketStats(series(prices), [], 31 * DAY);
    const r = Math.log(1.1);
    // stdev mẫu: mean 0, Σx² = 30r², /29
    expect(s.sigma30).toBeCloseTo(Math.sqrt((30 * r * r) / 29), 12);
    // Giá đầu và cuối đều 100 → trend 0.
    expect(s.trend).toBeCloseTo(0, 12);
    // 30 giá cuối: 15 giá 110 và 15 giá 100.
    expect(s.p5).toBe("100");
    expect(s.p50).toBe("105");
    expect(s.p95).toBe("110");
    expect(s.rangeScore).toBe(1);
  });

  it("drops rangeScore when prices break out of the band", () => {
    // Breakout nằm xa trong 180 ngày; 40 ngày gần nhất yên ắng nên σ nhỏ và các ngày 150 nằm ngoài dải.
    const calm = (n: number) => Array.from({ length: n }, (_, i) => 100 + (i % 2));
    const prices = [...calm(60), ...Array.from({ length: 10 }, () => 150), ...calm(40)];
    const s = computeMarketStats(series(prices), [], prices.length * DAY);
    expect(s.rangeScore).not.toBeNull();
    expect(s.rangeScore ?? 1).toBeLessThan(1);
  });

  it("summarizes funding over 7 days and the last 21 periods", () => {
    const now = 30 * DAY;
    const points = Array.from({ length: 21 }, (_, i) => ({
      at: now - (21 - i) * 8 * 3_600_000,
      rate: i < 14 ? "0.0001" : "-0.0001",
    }));
    const s = computeMarketStats(series([100, 100]), points, now);
    // Kỳ đầu nằm đúng mốc now − 7 ngày nên bị loại: 20 kỳ, 13 dương, 7 âm → 6 × 0.0001 / 20
    expect(s.fundingAvg7d).toBe("0.00003");
    expect(s.fundingPos21).toBeCloseTo(14 / 21, 12);
    expect(computeMarketStats(series([100]), points.slice(1), now).fundingPos21).toBeNull();
  });
});

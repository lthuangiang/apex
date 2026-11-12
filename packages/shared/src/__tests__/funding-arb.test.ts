import { describe, expect, it } from "vitest";

import {
  arbBreakEvenHours,
  arbEnterPct,
  arbFit,
  arbRoundTripFeePct,
  ARB_FIT,
} from "../funding-arb";

// Số liệu thật trên SoDEX ngày 2026-11-11 (DEC-160): mọi perp trả funding mỗi giờ.
describe("funding arb asset fit (DEC-160)", () => {
  it("prices a maker round trip on both legs with the builder fee", () => {
    // Spot 0.035 × 2 + 0.01 (bán) + Perps 0.012 × 2 + 0.01 × 2 = 0.124%.
    expect(arbRoundTripFeePct({}).toString()).toBe("0.124");
    expect(arbRoundTripFeePct({ builderRate: 3 }).toString()).toBe("0.103");
    expect(
      arbRoundTripFeePct({ spotMakerPct: "0", perpMakerPct: "0", builderRate: 0 }).toString(),
    ).toBe("0");
  });

  it("counts the hours of past funding needed to cover the fees", () => {
    expect(arbBreakEvenHours("0.0038", 1, "0.124")).toBeCloseTo(32.63, 2);
    expect(arbBreakEvenHours("0.0011", 8, "0.124")).toBeCloseTo(901.8, 1);
    expect(arbBreakEvenHours("0", 1, "0.124")).toBeNull();
    expect(arbBreakEvenHours("-0.0001", 1, "0.124")).toBeNull();
  });

  it("fits only steady funding that covers the fees within 72 hours", () => {
    const fit = (avg: string | null, pos: number | null) =>
      arbFit({ avg7dPct: avg, positiveShare21: pos, intervalHours: 1, feePct: "0.124" }).eligible;
    expect(fit("0.0038", 1)).toBe(true); // GOOGL: ~33 h
    expect(fit("0.0011", 1)).toBe(false); // BTC: ~113 h
    expect(fit("0.0038", 18 / 21)).toBe(false); // dưới 90% kỳ dương
    expect(fit("0.0038", null)).toBe(false); // chưa đủ 21 kỳ
    expect(fit(null, 1)).toBe(false);
    expect(ARB_FIT.maxBreakEvenHours).toBe(72);
  });

  it("sets the default entry at the funding that covers the fees in 72 hours", () => {
    expect(arbEnterPct("0.124", 1)).toBe("0.0018");
    expect(arbEnterPct("0.124", 8)).toBe("0.0138");
  });
});

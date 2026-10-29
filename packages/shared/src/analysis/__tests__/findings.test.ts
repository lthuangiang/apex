import { describe, expect, it } from "vitest";

import { analyzeAccount } from "../account";
import { findings } from "../findings";

const H = 3_600_000;
const pos = (
  side: "LONG" | "SHORT",
  entry: string,
  close: string,
  lev: number,
  hold: number,
  at: number,
) => ({
  market: "BTC-USD",
  side,
  entryPrice: entry,
  closePrice: close,
  closedSize: "1",
  fees: "10",
  leverage: lev,
  openedAt: at - hold,
  closedAt: at,
});

describe("findings", () => {
  it("flags costs, short-hold losses, slow exits and high leverage when they apply", () => {
    const m = analyzeAccount({
      perpsPositions: [
        pos("LONG", "100", "150", 2, 2 * 24 * H, 10 * H), // +40 net, giữ 2 ngày
        pos("LONG", "100", "95", 10, 5 * 60_000, 20 * H), // −15 net, giữ 5 phút, 10×
        pos("LONG", "100", "90", 2, 5 * 24 * H, 30 * H), // −20 net, giữ 5 ngày
      ],
      perpsFundings: [],
      perpsFills: [],
      spotFills: [],
      equity: null,
    });
    const kinds = findings(m).map((f) => f.kind);
    // gross 50 − 5 − 10 = 35; phí 30 → 86% gross
    expect(kinds).toContain("costs");
    expect(kinds).toContain("holding");
    // thua giữ trung bình (5m + 5d)/2 ≈ 2.5 ngày vs thắng 2 ngày → 1.25×: không đủ ngưỡng
    expect(kinds).not.toContain("exits");
    // lỗ ≥8×: 15 / 35 < 50% → không
    expect(kinds).not.toContain("leverage");
  });

  it("returns nothing for an empty history", () => {
    expect(
      findings(
        analyzeAccount({
          perpsPositions: [],
          perpsFundings: [],
          perpsFills: [],
          spotFills: [],
          equity: null,
        }),
      ),
    ).toEqual([]);
  });
});

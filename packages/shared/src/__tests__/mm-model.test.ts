import { describe, expect, it } from "vitest";

import {
  blendPnlBps,
  capacityPerDay,
  fitModel,
  MM_MODEL_SEED,
  modelPnlBps,
  rankMmMarkets,
  windowPnl,
} from "../mm-model";
import { dec } from "../money";

// Mô hình chi phí Market Making v1 (DEC-TBD-mm-cost-v1).

describe("model price PnL", () => {
  it("is a × step − k × swing, never above 0", () => {
    // XAUT-like: 0,25 × 0,26 − 0,095 × 2,84 = −0,2048
    expect(modelPnlBps(dec("0.26"), dec("2.84"), "0.25", "0.095").toFixed(4)).toBe("-0.2048");
    // KORU-like: big step → capped at 0 (no expected gain from price).
    expect(modelPnlBps(dec("13.44"), dec("5"), "0.25", "0.095").toString()).toBe("0");
    // The seed reproduces the ETH bot: 0,25 × 0,52 − 0,095 × 9,53 ≈ −0,775
    expect(modelPnlBps(dec("0.52"), dec("9.53"), MM_MODEL_SEED.a, MM_MODEL_SEED.k).toFixed(2)).toBe(
      "-0.78",
    );
  });

  it("blends the viewer's own result with the model as if the model were 50 round trips", () => {
    expect(blendPnlBps(dec("-0.2"), dec("-1.2"), 50).toString()).toBe("-0.7");
    expect(blendPnlBps(dec("-0.2"), null, 10).toString()).toBe("-0.2");
    expect(blendPnlBps(dec("-0.2"), dec("-1"), 0).toString()).toBe("-0.2");
  });

  it("counts open inventory at the current mid in the window's price PnL", () => {
    const fills = [
      { at: 1, side: "buy" as const, price: "100", size: "1" },
      { at: 2, side: "sell" as const, price: "99.9", size: "1" }, // −0,1
      { at: 3, side: "buy" as const, price: "100", size: "1" }, // still open
    ];
    // cash −100,1, open 1 at mid 99,8 → −0,3 on volume 299,9 → −10,003 bps
    const w = windowPnl(fills, "99.8");
    expect(w.bps?.toFixed(3)).toBe("-10.003");
    expect(w.rounds).toBe(1);
    expect(windowPnl(fills, null).bps).toBeNull();
    expect(windowPnl([], "1").bps).toBeNull();
  });

  it("gives up to 5% of 24-hour volume as capacity", () => {
    expect(capacityPerDay("3000000")?.toString()).toBe("150000");
    expect(capacityPerDay(null)).toBeNull();
  });
});

describe("daily fit", () => {
  it("keeps a and fits only k with fewer than 5 points", () => {
    const f = fitModel([{ stepBps: "0.52", swingBps: "9.53", pnlBps: "-0.78", weight: "1" }]);
    expect(f?.a.toString()).toBe("0.25");
    expect(f?.k.toFixed(4)).toBe("0.0955");
    expect(f?.points).toBe(1);
    expect(fitModel([])).toBeNull();
  });

  it("recovers a and k from enough points, and keeps a within 0–0.5 and k ≥ 0", () => {
    const truth = (s: number, w: number) => String(0.2 * s - 0.1 * w);
    const pts = [
      [0.5, 9],
      [1, 3],
      [2, 6],
      [0.3, 2],
      [3, 12],
    ].map(([s, w]) => ({
      stepBps: String(s),
      swingBps: String(w),
      pnlBps: truth(s ?? 0, w ?? 0),
      weight: "1",
    }));
    const f = fitModel(pts);
    expect(f?.a.toFixed(6)).toBe("0.200000");
    expect(f?.k.toFixed(6)).toBe("0.100000");
    // Data that would need a > 0,5 → capped, k refitted.
    const steep = pts.map((p) => ({ ...p, pnlBps: String(Number(p.stepBps) * 2) }));
    expect(fitModel(steep)?.a.toString()).toBe("0.5");
    expect(fitModel(steep)?.k.toString()).toBe("0");
  });
});

describe("ranking", () => {
  const row = (market: string, cost: string | null, cap: string | null, tooLittle = false) => ({
    market,
    totalCostPerMillion: cost,
    capacityPerDay: cap,
    tooLittleVolume: tooLittle,
  });

  it("puts cheapest first, ties every '0 or less' and orders them by capacity, then thin markets, then no data", () => {
    const { ranked, suggested } = rankMmMarkets([
      row("NODATA", null, "900000"),
      row("THIN", "10", "40000", true),
      row("ETH", "228", "5000000"),
      row("NKE", "110", "200000"),
      row("ZERO_SMALL", "-30", "150000"),
      row("ZERO_BIG", "0", "800000"),
    ]);
    expect(ranked.map((r) => r.market)).toEqual([
      "ZERO_BIG",
      "ZERO_SMALL",
      "NKE",
      "ETH",
      "THIN",
      "NODATA",
    ]);
    expect(suggested).toEqual(["ZERO_BIG", "ZERO_SMALL", "NKE"]);
  });

  it("suggests nothing when no market has enough data and volume", () => {
    expect(rankMmMarkets([row("A", null, null), row("B", "5", "1", true)]).suggested).toEqual([]);
  });
});

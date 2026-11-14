import { describe, expect, it } from "vitest";

import {
  avgMarkout,
  medianMidMove,
  medianTicks,
  midNear,
  roundTrips,
  swingBps,
  type MidPoint,
} from "../mm-markout";

// Chi phí làm market (DEC-TBD-mm-cost): markout theo notional, mid trong ±2 s, vòng mua bán đóng lỗ, spread trung vị,
// dao động 1 phút. Thiếu dữ liệu → null.

const T = 1_700_000_000_000;
const mids: MidPoint[] = [
  { at: T, mid: "100" },
  { at: T + 5_000, mid: "100.1" },
  { at: T + 30_000, mid: "99.9" },
  { at: T + 60_000, mid: "99.8" },
];

describe("mm markout helpers", () => {
  it("finds the mid within 2 s, else null", () => {
    expect(midNear(mids, T + 4_000)?.toString()).toBe("100.1");
    expect(midNear(mids, T + 15_000)).toBeNull();
  });

  it("averages markout by notional, buys and sells with opposite signs", () => {
    const fills = [
      { at: T, side: "buy" as const, price: "100", size: "1" },
      { at: T, side: "sell" as const, price: "100", size: "3" },
    ];
    // 30 s: mua (99.9 − 100)/100 = −10 bps; bán (100 − 99.9)/100 = +10 bps → (100×−10 + 300×10)/400 = +5.
    expect(avgMarkout(fills, mids, 30_000)?.toString()).toBe("5");
    expect(avgMarkout(fills, mids, 120_000)).toBeNull();
    // |Δmid 30 s| = 10 bps.
    expect(medianMidMove(fills, mids, 30_000)?.toString()).toBe("10");
  });

  it("counts round trips from flat to flat, splitting a flip, at a loss by price only", () => {
    expect(roundTrips([])).toBeNull();
    const r = roundTrips([
      { at: 1, side: "buy", price: "100", size: "1" },
      { at: 2, side: "sell", price: "99", size: "1" }, // vòng 1: lỗ
      { at: 3, side: "sell", price: "100", size: "1" },
      { at: 4, side: "buy", price: "99", size: "2" }, // đóng short (lời) rồi mở long 1
      { at: 5, side: "sell", price: "98", size: "1" }, // vòng 3: lỗ
    ]);
    // Lỗ 1 / đơn vị và lãi 1 / đơn vị: vòng lỗ không mất nhiều hơn.
    expect(r).toEqual({ losing: 2, total: 3, losersLoseMore: false });
    const bigger = roundTrips([
      { at: 1, side: "buy", price: "100", size: "2" },
      { at: 2, side: "sell", price: "100.5", size: "2" }, // lãi 0,5 / đơn vị
      { at: 3, side: "buy", price: "100", size: "1" },
      { at: 4, side: "sell", price: "98", size: "1" }, // lỗ 2 / đơn vị
    ]);
    expect(bigger).toEqual({ losing: 1, total: 2, losersLoseMore: true });
    expect(
      roundTrips([
        { at: 1, side: "buy", price: "1", size: "1" },
        { at: 2, side: "sell", price: "2", size: "1" },
      ])?.losersLoseMore,
    ).toBeNull();
  });

  it("takes the median spread in ticks and the 1-minute swing", () => {
    expect(medianTicks({ "1": 70, "2": 30 })).toBe(1);
    expect(medianTicks({ "1": 30, "2": 70 })).toBe(2);
    expect(medianTicks({})).toBeNull();
    expect(swingBps(["100"])).toBeNull();
    // +100 bps rồi −99.01 bps: độ lệch chuẩn mẫu ≈ 140.72.
    expect(swingBps(["100", "101", "100"])?.toDecimalPlaces(2).toString()).toBe("140.72");
  });
});

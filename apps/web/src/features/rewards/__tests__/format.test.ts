import { describe, expect, it } from "vitest";

import {
  decimalOf,
  formatCoefficient,
  formatCount,
  formatDayTime,
  formatUsd,
  formatVolume,
  sortByCoefficient,
} from "../format";

// Định dạng SoDEX rewards (#548): thiếu / lạ → null ("Not available"), không bao giờ thành 0.

describe("rewards format", () => {
  it("reads numbers and numeric strings, rejects the rest", () => {
    expect(decimalOf(48210)).toBe("48210");
    expect(decimalOf(" 41880.5 ")).toBe("41880.5");
    expect(decimalOf(null)).toBeNull();
    expect(decimalOf(undefined)).toBeNull();
    expect(decimalOf("")).toBeNull();
    expect(decimalOf("n/a")).toBeNull();
    expect(decimalOf(Number.NaN)).toBeNull();
    expect(decimalOf(1e21)).toBeNull();
  });

  it("formats counts, volumes, USD and coefficients", () => {
    expect(formatCount(48210)).toBe("48,210");
    expect(formatCount("1000000")).toBe("1,000,000");
    expect(formatCount(null)).toBeNull();
    expect(formatVolume(84300)).toBe("$84,300");
    expect(formatVolume(undefined)).toBeNull();
    expect(formatUsd("110.891")).toBe("$110.89");
    expect(formatCoefficient("1.20")).toBe("×1.2");
    expect(formatCoefficient("x")).toBeNull();
  });

  it("formats day + time in the given time zone", () => {
    expect(formatDayTime(Date.UTC(2026, 11, 4, 12, 0), "Asia/Ho_Chi_Minh")).toBe("Dec 4, 19:00");
    expect(formatDayTime(Date.UTC(2026, 11, 4, 12, 0), "Not/AZone")).toBe("Dec 4, 12:00");
  });

  it("sorts multipliers highest first, ties keep the API order, unreadable last", () => {
    const w = (symbol: string, coefficient: string) => ({ symbol, coefficient });
    expect(
      sortByCoefficient([
        w("A", "1.1"),
        w("B", "1.2"),
        w("C", "bad"),
        w("D", "1.20"),
        w("E", "1.15"),
      ]).map((x) => x.symbol),
    ).toEqual(["B", "D", "E", "A", "C"]);
  });
});

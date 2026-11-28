import { createTranslator } from "next-intl";
import { describe, expect, it } from "vitest";

import messages from "../../../../messages/en.json";
import { tierProgress } from "../components/sopoints-tab";
import {
  capitalizeRaw,
  formatRank,
  formatUsdAmount,
  weekPoints,
  weekState,
  weekVolumeTotal,
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
    expect(formatVolume(84300)).toBe("$84,300.00");
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

  it("tier progress: nextTierPoints is the total threshold", () => {
    expect(tierProgress(48210, 60000)).toEqual({ pct: 80.35, left: "11790", threshold: "60000" });
    expect(tierProgress(60000, 60000)).toBeNull();
    expect(tierProgress(70000, "60000")).toBeNull();
    expect(tierProgress(48210, null)).toBeNull();
    expect(tierProgress(null, 60000)).toBeNull();
  });

  it("count strings use the singular for 1", () => {
    const t = createTranslator({ locale: "en", messages: { r: messages.rewards } });
    expect(t("r.card.job.opening", { count: 1 })).toBe("Opening 1 box…");
    expect(t("r.card.job.opening", { count: 5 })).toBe("Opening 5 boxes…");
    expect(t("r.card.job.claiming", { count: 1 })).toBe("Claiming 1 box…");
    expect(t("r.multipliers.showAll", { count: 1 })).toBe("Show all 1 market");
    expect(t("r.multipliers.showAll", { count: 6 })).toBe("Show all 6 markets");
    expect(t("r.summary.toNext", { points: 1, tier: "EPIC" })).toBe("1 point to EPIC");
    expect(t("r.summary.toNext", { points: 11790, tier: "EPIC" })).toBe("11,790 points to EPIC");
  });

  it("USD: always 2 decimals, whole numbers and 0 included", () => {
    expect(formatUsdAmount(296474.7)).toBe("$296,474.70");
    expect(formatUsdAmount("459.96")).toBe("$459.96");
    expect(formatUsdAmount(6.48)).toBe("$6.48");
    expect(formatUsdAmount(84300)).toBe("$84,300.00");
    expect(formatUsdAmount(0)).toBe("$0.00");
    expect(formatUsdAmount("12.40")).toBe("$12.40");
    expect(formatUsdAmount(null)).toBeNull();
  });

  it("week volume (#601): spot + futures as SoDEX returns them; one missing uses the other; both missing is null", () => {
    expect(weekVolumeTotal({ spotVolume: 1920, futuresVolume: "84300" })).toBe("86220");
    expect(weekVolumeTotal({ spotVolume: null, futuresVolume: 500.5 })).toBe("500.5");
    expect(weekVolumeTotal({ spotVolume: "12.25" })).toBe("12.25");
    expect(weekVolumeTotal({ spotVolume: 0, futuresVolume: 0 })).toBe("0");
    expect(weekVolumeTotal({})).toBeNull();
    expect(weekVolumeTotal({ spotVolume: "n/a", futuresVolume: null })).toBeNull();
    expect(formatUsdAmount(weekVolumeTotal({ spotVolume: 0, futuresVolume: 0 }))).toBe("$0.00");
  });

  it("week state: isLive → live, ended non-CONFIRMED → snapshot, CONFIRMED 0 is a real 0", () => {
    expect(weekState({ isLive: true, pointsStatus: "CONFIRMED" })).toBe("live");
    expect(weekState({ isLive: false, pointsStatus: "PENDING" })).toBe("snapshot");
    expect(weekState({ isLive: false, pointsStatus: "confirmed" })).toBe("confirmed");
    expect(weekState({})).toBe("unknown");
    expect(weekPoints({ isLive: true, points: 0, pointsStatus: "PENDING" })).toEqual({
      state: "live",
      text: null,
      hide: true,
    });
    expect(weekPoints({ isLive: false, points: 0, pointsStatus: "SNAPSHOT" }).hide).toBe(true);
    expect(weekPoints({ points: 0, pointsStatus: "CONFIRMED" })).toEqual({
      state: "confirmed",
      text: "0",
      hide: false,
    });
  });

  it("rank 0 or missing is no rank; unknown sources keep SoDEX's string, capitalised", () => {
    expect(formatRank(0)).toBeNull();
    expect(formatRank(null)).toBeNull();
    expect(formatRank(1284)).toBe("1,284");
    expect(capitalizeRaw("manual")).toBe("Manual");
    expect(capitalizeRaw("")).toBe("");
  });
});

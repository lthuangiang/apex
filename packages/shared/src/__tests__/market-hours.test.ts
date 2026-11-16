import { describe, expect, it } from "vitest";

import {
  calibrationRatio,
  cutShareOf,
  cutStats,
  fillCostPerMillion,
  marketHoursQuerySchema,
  marketHoursViewSchema,
  minuteRangeBp,
  mmCutBasis,
  moveBp,
  quantile,
  timeZoneSchema,
} from "../api/market-hours";
import { dec } from "../money";

// Market hours (DEC-283): range 1 phút, trung vị / p90, Cost per $1M từ fill thật (markout 60 s), múi giờ.

describe("minute range", () => {
  it("is (high − low) ÷ mid in bp, and null for bad prices", () => {
    expect(minuteRangeBp("101", "99")?.toString()).toBe("200");
    expect(minuteRangeBp("100", "100")?.toString()).toBe("0");
    expect(minuteRangeBp("0", "0")).toBeNull();
    expect(minuteRangeBp("99", "101")).toBeNull();
  });
});

describe("window move", () => {
  it("is (highest − lowest) ÷ lowest in bp, and null for bad prices", () => {
    expect(moveBp("101.5", "100")?.toString()).toBe("150");
    expect(moveBp("100", "100")?.toString()).toBe("0");
    expect(moveBp("1", "0")).toBeNull();
    expect(moveBp("99", "100")).toBeNull();
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

describe("cutStats (DEC-TBD-market-hours-shock)", () => {
  const cut = (orderId: string, side: "buy" | "sell", price: string, ref: string | null) => ({
    orderId,
    side,
    price,
    size: "2",
    ref,
  });

  it("measures notional-weighted slippage against the price before the cut, adverse is positive", () => {
    // Bán thấp hơn 100 là bất lợi (+); mua cao hơn 100 là bất lợi (+). Bốn lệnh bán 99.98 (2 bp), một lệnh mua 100.04 (4 bp).
    const s = cutStats([
      cut("a", "sell", "99.98", "100"),
      cut("b", "sell", "99.98", "100"),
      cut("c", "sell", "99.98", "100"),
      cut("d", "sell", "99.98", "100"),
      cut("e", "buy", "100.04", "100"),
    ]);
    expect(s.cuts).toBe(5);
    // Σ slip × notional ÷ Σ notional = (4 × 0.0002 × 199.96 + 0.0004 × 200.08) ÷ 999.92 × 1e4.
    const expected = dec("0.0002")
      .mul("799.84")
      .add(dec("0.0004").mul("200.08"))
      .div("999.92")
      .mul(10_000);
    expect(s.slippageBps?.toFixed(6)).toBe(expected.toFixed(6));
    expect(s.notional?.toString()).toBe("199.984");
  });

  it("has no slippage or size with fewer than 5 priced cuts, so the estimate uses the taker fee only", () => {
    const s = cutStats([
      cut("a", "sell", "99.98", "100"),
      cut("a", "sell", "99.97", "100"),
      cut("b", "sell", "99.98", null),
      cut("c", "sell", "99.98", "100"),
      cut("d", "sell", "99.98", "100"),
      cut("e", "sell", "99.98", "100"),
    ]);
    expect(s.cuts).toBe(5);
    expect(s).toMatchObject({ slippageBps: null, notional: null });
    expect(cutStats([])).toEqual({ cuts: 0, slippageBps: null, notional: null });
  });
});

describe("calibrationRatio", () => {
  const p = (real: string, est: string) => ({ real: dec(real), est: dec(est) });
  it("is the median of real ÷ estimate over the hours with an estimate above 0", () => {
    expect(calibrationRatio([p("140", "100"), p("120", "100"), p("300", "100")])?.toString()).toBe(
      "1.4",
    );
    expect(
      calibrationRatio([
        p("100", "100"),
        p("200", "100"),
        p("150", "100"),
        p("50", "0"),
      ])?.toString(),
    ).toBe("1.5");
  });
  it("is not available with fewer than 3 hours", () => {
    expect(calibrationRatio([p("140", "100"), p("120", "100"), p("1", "0")])).toBeNull();
    expect(calibrationRatio([])).toBeNull();
  });
});

describe("cut size share (DEC-TBD-market-hours-shock)", () => {
  it("averages volume per bot-hour over every hour and max position weighted by bot-hours", () => {
    // Bot 1: 21 bot-hour, $14 700, max $20. Bot 2: 3 bot-hour, chưa có fill, max $100. Bot 3: cấu hình hỏng.
    const b = mmCutBasis([
      { botHours: 21, volume: "14700", maxPosition: "20" },
      { botHours: 3, volume: null, maxPosition: "100" },
      { botHours: 6, volume: "300", maxPosition: null },
      { botHours: 0, volume: "999", maxPosition: "999" },
    ]);
    // (14 700 + 300) ÷ 30 = 500; (20 × 21 + 100 × 3) ÷ 24 = 30.
    expect(b.botHourVolume?.toString()).toBe("500");
    expect(b.maxPosition?.toString()).toBe("30");
    expect(mmCutBasis([])).toEqual({ botHourVolume: null, maxPosition: null });
    expect(mmCutBasis([{ botHours: 2, volume: null, maxPosition: "20" }])).toEqual({
      botHourVolume: null,
      maxPosition: dec("20"),
    });
  });

  it("sizes a cut from real cuts when there are enough, else from max open position, else leaves it out", () => {
    const v = dec("500");
    expect(
      cutShareOf({ cutNotional: dec("100"), maxPosition: dec("30"), botHourVolume: v }),
    ).toEqual({ share: dec("0.2"), source: "cuts" });
    expect(cutShareOf({ cutNotional: null, maxPosition: dec("30"), botHourVolume: v })).toEqual({
      share: dec("0.06"),
      source: "position",
    });
    expect(cutShareOf({ cutNotional: null, maxPosition: null, botHourVolume: v })).toEqual({
      share: null,
      source: null,
    });
    // Không có volume bot-hour: không chia được → không tính phần cắt, kể cả khi đủ lệnh cắt.
    expect(
      cutShareOf({ cutNotional: dec("100"), maxPosition: dec("30"), botHourVolume: null }),
    ).toEqual({ share: null, source: null });
  });
});

import { describe, expect, it } from "vitest";

import {
  calibrationOf,
  calibrationRatio,
  cutSizing,
  cutStats,
  fillCostPerMillion,
  marketHoursQuerySchema,
  marketHoursViewSchema,
  minuteRangeBp,
  moveBp,
  positionStats,
  quantile,
  timeZoneSchema,
  type MmBotWindow,
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

describe("cutStats (DEC-289)", () => {
  const cut = (
    orderId: string,
    side: "buy" | "sell",
    price: string,
    ref: string | null,
    orderSize: string | null = "100",
  ) => ({
    orderId,
    side,
    price,
    size: "2",
    ref,
    orderSize,
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
    // Order size $100: mỗi lệnh cắt ≈ 2× order size → trung bình 199.984 ÷ 100.
    expect(s.sizeRatio?.toString()).toBe("1.99984");
  });

  it("averages cut notional ÷ the bot's order size per cut order, skipping cuts without an order size", () => {
    const s = cutStats([
      // Lệnh "a" khớp hai fill: notional 199.96 + 199.94 = 399.9 ÷ order size 100.
      cut("a", "sell", "99.98", "100"),
      cut("a", "sell", "99.97", "100"),
      cut("b", "sell", "99.98", "100", "50"),
      cut("c", "sell", "99.98", "100", null),
      cut("d", "sell", "99.98", "100"),
      cut("e", "sell", "99.98", "100"),
    ]);
    // (3.999 + 3.9992 + 1.9996 + 1.9996) ÷ 4
    expect(s.sizeRatio?.toString()).toBe("2.99935");
    expect(
      cutStats(["a", "b", "c", "d", "e"].map((id) => cut(id, "sell", "99.98", "100", null)))
        .sizeRatio,
    ).toBeNull();
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
    expect(s).toMatchObject({ slippageBps: null, notional: null, sizeRatio: null });
    expect(cutStats([])).toEqual({ cuts: 0, slippageBps: null, notional: null, sizeRatio: null });
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

describe("cut size from position ÷ order size (DEC-TBD-market-hours-calibrated)", () => {
  const bot = (
    market: string,
    botHours: number,
    volume: string | null,
    maxPosition: string | null,
    orderSize: string | null,
  ): MmBotWindow => ({ market, botHours, volume, maxPosition, orderSize });

  it("takes the median of max position ÷ order size and volume per bot-hour in order-size units", () => {
    const s = positionStats([
      // $20 order size, max $40 → 2×; $700 over 1 bot-hour → 35 order sizes.
      bot("ETH-USD", 1, "700", "40", "20"),
      // $10 order size, max $35 → 3.5×; $300 over 2 bot-hours → 30 order sizes.
      bot("BTC-USD", 2, "300", "35", "10"),
      // $50 order size, max $60 → 1.2×; no fills in volume (null) but still counts its bot-hours.
      bot("BTC-USD", 3, null, "60", "50"),
      // Unreadable config, or no bot-hours: left out.
      bot("SOL-USD", 4, "999", "999", null),
      bot("SOL-USD", 0, "999", "999", "10"),
    ]);
    expect(s.ratio?.toString()).toBe("2");
    // (35 + 30) ÷ (1 + 2 + 3)
    expect(s.fillsPerBotHour?.toFixed(4)).toBe("10.8333");
    expect(s.botHours).toBe(6);
    expect(s.markets).toEqual(["BTC-USD", "ETH-USD"]);
    expect(positionStats([])).toEqual({
      ratio: null,
      fillsPerBotHour: null,
      botHours: 0,
      markets: [],
    });
  });

  it("uses this market's bots, then all markets pooled, then the defaults R = 2 and F = 80", () => {
    const bots = [bot("ETH-USD", 2, "800", "60", "20"), bot("BTC-USD", 4, "400", "10", "10")];
    // ETH: R = 3, 800 ÷ 20 ÷ 2 = 20 order sizes per bot-hour → share = 3 ÷ 20.
    expect(cutSizing(bots, "ETH-USD", null)).toEqual({
      ratio: dec("3"),
      ratioSource: "market",
      fillsPerBotHour: dec("20"),
      cutShare: dec("0.15"),
      scope: { source: "market", botHours: 2, marketBotHours: 2, markets: [] },
    });
    // No bots on SOL: pooled R = median(3, 1) = 2, fills = (40 + 40) ÷ 6.
    const pooled = cutSizing(bots, "SOL-USD", null);
    expect(pooled).toMatchObject({
      ratio: dec("2"),
      ratioSource: "pooled",
      scope: { source: "pooled", botHours: 6, marketBotHours: 0, markets: ["BTC-USD", "ETH-USD"] },
    });
    expect(pooled.cutShare.toString()).toBe(dec("2").div(dec("80").div("6")).toString());
    // No bot data at all: R = 2 and F = 80 by default, so the cut share still exists: 2 ÷ 80.
    expect(cutSizing([], "SOL-USD", null)).toEqual({
      ratio: dec("2"),
      ratioSource: "default",
      fillsPerBotHour: dec("80"),
      cutShare: dec("0.025"),
      scope: { source: "default", botHours: 0, marketBotHours: 0, markets: [] },
    });
  });

  it("pools when this market has bots but none usable, and remembers that it had bots", () => {
    // SOL bot has no readable order size: not usable, but SOL did have 5 bot-hours.
    const sol = bot("SOL-USD", 5, "100", "20", null);
    const bots = [sol, bot("BTC-USD", 4, "400", "10", "10")];
    expect(cutSizing(bots, "SOL-USD", null).scope).toEqual({
      source: "pooled",
      botHours: 4,
      marketBotHours: 5,
      markets: ["BTC-USD"],
    });
    // Only unusable bots anywhere: defaults, still with this market's bot-hours.
    expect(cutSizing([sol], "SOL-USD", null)).toMatchObject({
      fillsPerBotHour: dec("80"),
      scope: { source: "default", botHours: 0, marketBotHours: 5, markets: [] },
    });
  });

  it("uses the measured cut size ÷ order size instead of R when there are enough real cuts", () => {
    const s = cutSizing([bot("ETH-USD", 2, "800", "60", "20")], "ETH-USD", dec("1.5"));
    expect(s).toMatchObject({ ratio: dec("1.5"), ratioSource: "cuts" });
    expect(s.cutShare.toString()).toBe("0.075");
  });
});

describe("calibration factor C with fallbacks (DEC-TBD-market-hours-calibrated)", () => {
  const p = (real: string, est: string) => ({ real: dec(real), est: dec(est) });
  const three = [p("150", "100"), p("200", "100"), p("250", "100")];

  it("uses this market's hours when there are enough, without loading other markets", async () => {
    let loaded = false;
    const c = await calibrationOf({ pairs: three, botHours: 12 }, () => {
      loaded = true;
      return Promise.resolve({ pairs: [], botHours: 0, markets: [] });
    });
    expect(loaded).toBe(false);
    expect(c).toEqual({
      factor: dec("2"),
      hours: 3,
      scope: { source: "market", botHours: 12, marketBotHours: 12, markets: [] },
    });
  });

  it("pools every market when this one has too few hours, else falls back to C = 1.0", async () => {
    const pooled = await calibrationOf({ pairs: [p("100", "100")], botHours: 1 }, () =>
      Promise.resolve({ pairs: three, botHours: 30, markets: ["BTC-USD", "ETH-USD"] }),
    );
    expect(pooled).toEqual({
      factor: dec("2"),
      hours: 3,
      // This market had bots (1 bot-hour) but too few cells: "Not enough bot data on this market".
      scope: { source: "pooled", botHours: 30, marketBotHours: 1, markets: ["BTC-USD", "ETH-USD"] },
    });
    const noBots = await calibrationOf({ pairs: [], botHours: 0 }, () =>
      Promise.resolve({ pairs: three, botHours: 30, markets: ["BTC-USD", "ETH-USD"] }),
    );
    expect(noBots.scope.marketBotHours).toBe(0);
    const fallback = await calibrationOf({ pairs: [], botHours: 0 }, () =>
      Promise.resolve({ pairs: [p("100", "100")], botHours: 1, markets: ["BTC-USD"] }),
    );
    expect(fallback).toEqual({
      factor: dec("1"),
      hours: 0,
      scope: { source: "default", botHours: 0, marketBotHours: 0, markets: [] },
    });
  });
});

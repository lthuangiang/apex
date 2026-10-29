import { dec } from "@drift/shared";
import { describe, expect, it } from "vitest";

import { emptyValues } from "../fields";
import {
  fmt,
  fmtPrice,
  gridLevels,
  liveHints,
  previewModel,
  priceMarketOf,
  unitsOf,
} from "../preview";

const NOW = Date.parse("2026-10-28T03:00:00Z");

describe("previewModel", () => {
  it("returns null until the required fields are filled (no invented numbers)", () => {
    for (const s of [
      "spot_grid",
      "futures_grid",
      "spot_dca",
      "futures_dca",
      "recurring_buy",
      "rebalancing",
      "funding_arb",
      "twap",
    ] as const) {
      expect(previewModel(s, emptyValues(s), "100", NOW)).toBeNull();
    }
  });

  it("spot grid: levels, smallest step, per-level capital and fees", () => {
    const v = {
      ...emptyValues("spot_grid"),
      market: "vADA_vUSDT",
      lowerPrice: "0.32",
      upperPrice: "0.39",
      gridLevels: "8",
      investment: "300",
      stopPrice: "0.30",
    };
    const m = previewModel("spot_grid", v, "0.3528", NOW);
    expect(m?.kind).toBe("grid");
    if (m?.kind !== "grid") return;
    expect(m.levels).toHaveLength(8);
    expect(m.levels[0]).toBe("0.32");
    expect(m.levels[7]).toBe("0.39");
    expect(m.stop).toBe("0.3");
    expect(m.last).toBe("0.3528");
    const params = Object.fromEntries(m.tiles.map((t) => [t.key, t.params]));
    expect(params.perLevel).toEqual({ value: "37.5", unit: "vUSDT" });
    // Bước nhỏ nhất ở mức trên cùng: 0.01 / 0.38 = 2.63%.
    expect(params.step).toEqual({ value: "2.63" });
    expect(params.ordersAtStart).toEqual({ count: "8" });
    expect(params.roundTrip).toEqual({ value: "0.1" });
  });

  it("geometric grid has equal % gaps", () => {
    const l = gridLevels(dec("100"), dec("400"), 3, "geometric");
    expect(l.map((x) => x.toString())).toEqual(["100", "200", "400"]);
  });

  it("futures grid per level uses margin × leverage and has no per-level value without leverage", () => {
    const v = {
      ...emptyValues("futures_grid"),
      market: "BTC-USD",
      lowerPrice: "62000",
      upperPrice: "72000",
      gridLevels: "20",
      margin: "5000",
      leverage: "2",
    };
    const m = previewModel("futures_grid", v, null, NOW);
    if (m?.kind !== "grid") throw new Error("grid expected");
    expect(m.tiles.find((t) => t.key === "perLevel")?.params).toEqual({
      value: "500",
      unit: "USDC",
    });
    expect(m.last).toBeNull();
    const noLev = previewModel("futures_grid", { ...v, leverage: "" }, null, NOW);
    if (noLev?.kind !== "grid") throw new Error("grid expected");
    expect(noLev.tiles.find((t) => t.key === "perLevel")?.params).toBeNull();
  });

  it("DCA ladder follows the engine's size and offset formulas", () => {
    const v = {
      ...emptyValues("spot_dca"),
      market: "vETH_vUSDT",
      baseOrder: "50",
      safetyOrder: "50",
      maxSafetyOrders: "3",
      firstStepPct: "2",
      stepMultiplier: "1.2",
      sizeMultiplier: "1.5",
      takeProfitPct: "1.5",
    };
    const m = previewModel("spot_dca", v, "2000", NOW);
    if (m?.kind !== "dca") throw new Error("dca expected");
    expect(m.rows.map((r) => r.size)).toEqual(["50", "50", "75", "112.5"]);
    expect(m.rows.map((r) => r.offsetPct)).toEqual(["0", "2", "4.4", "7.28"]);
    expect(m.rows[1]?.price).toBe("1960");
    const params = Object.fromEntries(m.tiles.map((t) => [t.key, t.params]));
    expect(params.maxCapital).toEqual({ value: "287.5", unit: "vUSDT" });
    expect(params.coversDrop).toEqual({ value: "7.28" });
  });

  it("short futures DCA places safeties above the price", () => {
    const v = {
      ...emptyValues("futures_dca"),
      market: "BTC-USD",
      direction: "short",
      baseOrder: "100",
      safetyOrder: "100",
      maxSafetyOrders: "1",
      firstStepPct: "1.5",
      stepMultiplier: "1",
      sizeMultiplier: "1",
    };
    const m = previewModel("futures_dca", v, "1000", NOW);
    if (m?.kind !== "dca") throw new Error("dca expected");
    expect(m.rows[1]?.price).toBe("1015");
  });

  it("recurring buy: count from budget, schedule from nextRun", () => {
    const v = {
      ...emptyValues("recurring_buy"),
      market: "vBTC_vUSDC",
      amountPerBuy: "150",
      frequency: "daily",
      time: "09:00",
      ends: "after_budget",
      totalBudget: "1000",
      timeZone: "UTC",
    };
    const m = previewModel("recurring_buy", v, null, NOW);
    if (m?.kind !== "schedule") throw new Error("schedule expected");
    expect(m.total).toBe(6);
    expect(m.buys[0]?.at).toBe(Date.parse("2026-10-28T09:00:00Z"));
    expect(m.buys).toHaveLength(6);
    expect(m.tiles.find((t) => t.key === "ends")?.params).toEqual({
      at: String(Date.parse("2026-11-02T09:00:00Z")),
    });
  });

  it("recurring buy that never ends has no total and no end date", () => {
    const v = {
      ...emptyValues("recurring_buy"),
      amountPerBuy: "10",
      time: "21:30",
      ends: "never",
      timeZone: "UTC",
    };
    const m = previewModel("recurring_buy", v, null, NOW);
    if (m?.kind !== "schedule") throw new Error("schedule expected");
    expect(m.total).toBeNull();
    expect(m.tiles.find((t) => t.key === "ends")?.params).toBeNull();
  });

  it("rebalancing bands are target ± threshold, never below 0", () => {
    const v = {
      ...emptyValues("rebalancing"),
      assets: [
        { asset: "BTC", market: "vBTC_vUSDC", weightPct: "97" },
        { asset: "USDC", market: "", weightPct: "3" },
      ],
      thresholdPct: "5",
    };
    const m = previewModel("rebalancing", v, null, NOW);
    if (m?.kind !== "weights") throw new Error("weights expected");
    expect(m.rows[0]?.band).toEqual(["92", "102"]);
    expect(m.rows[1]?.band).toEqual(["0", "8"]);
  });

  it("funding arb splits capital in half; quantity needs a price", () => {
    const v = { ...emptyValues("funding_arb"), asset: "BTC", investment: "10000" };
    const m = previewModel("funding_arb", v, "50000", NOW);
    if (m?.kind !== "arb") throw new Error("arb expected");
    expect(m.half).toBe("5000");
    expect(m.qty).toBe("0.1");
    const noPrice = previewModel("funding_arb", v, null, NOW);
    if (noPrice?.kind !== "arb") throw new Error("arb expected");
    expect(noPrice.tiles.find((t) => t.key === "spotLeg")?.params).toBeNull();
  });

  it("twap slice size and interval", () => {
    const v = {
      ...emptyValues("twap"),
      market: "vBTC_vUSDC",
      totalSize: "2",
      durationMinutes: "240",
      slices: "48",
    };
    const m = previewModel("twap", v, null, NOW);
    if (m?.kind !== "twap") throw new Error("twap expected");
    const params = Object.fromEntries(m.tiles.map((t) => [t.key, t.params]));
    expect(params.slice).toEqual({ value: "0.041667", unit: "vBTC" });
    expect(params.interval).toEqual({ seconds: "300" });
  });
});

describe("helpers", () => {
  it("formats with grouping and trims zeros", () => {
    expect(fmt(dec("1234567.5000"), 2)).toBe("1,234,567.5");
    expect(fmt(dec("-0.12345"), 4)).toBe("-0.1235");
  });
  it("reads units and price market", () => {
    expect(unitsOf("vBTC_vUSDC")).toEqual({ base: "vBTC", quote: "vUSDC" });
    expect(unitsOf("ETH-USD")).toEqual({ base: "ETH", quote: "USDC" });
    expect(priceMarketOf("funding_arb", { spotMarket: "vBTC_vUSDC" })).toBe("vBTC_vUSDC");
    expect(priceMarketOf("spot_grid", { market: "" })).toBeNull();
  });
});

describe("liveHints", () => {
  it("compares grid bounds with the last price and describes the step", () => {
    const v = {
      ...emptyValues("spot_grid"),
      lowerPrice: "0.32",
      upperPrice: "0.39",
      gridLevels: "8",
    };
    const h = liveHints("spot_grid", v, "0.3528");
    expect(h.lowerPrice).toEqual({ key: "belowLast", params: { pct: "9.3" } });
    expect(h.upperPrice).toEqual({ key: "aboveLast", params: { pct: "10.5" } });
    expect(h.gridLevels).toEqual({
      key: "levelsArithmetic",
      params: { step: "0.01", pct: "2.63" },
    });
  });
  it("has no price hints without a last price and nothing for other strategies", () => {
    const v = { ...emptyValues("spot_grid"), lowerPrice: "1", upperPrice: "2", gridLevels: "1" };
    expect(liveHints("spot_grid", v, null)).toEqual({});
    expect(liveHints("twap", emptyValues("twap"), "1")).toEqual({});
  });
});

describe("fmtPrice", () => {
  it("keeps precision for small prices", () => {
    expect(fmtPrice("0.196234")).toBe("0.196234");
    expect(fmtPrice("80476.123")).toBe("80,476.12");
    expect(fmtPrice("2753.92")).toBe("2,753.92");
  });
});

describe("TWAP duration hint (UI_REVIEW G4)", () => {
  it("shows hours from 60 minutes", () => {
    expect(liveHints("twap", { durationMinutes: "45" }, null)).toEqual({});
    expect(liveHints("twap", { durationMinutes: "240" }, null).durationMinutes).toEqual({
      key: "durationHours",
      params: { h: "4" },
    });
    expect(liveHints("twap", { durationMinutes: "90" }, null).durationMinutes).toEqual({
      key: "durationHoursMinutes",
      params: { h: "1", m: "30" },
    });
  });
});

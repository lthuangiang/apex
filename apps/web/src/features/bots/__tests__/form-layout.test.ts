import { describe, expect, it } from "vitest";

import { FIELDS } from "../fields";
import { advancedSummary, defaultBotName, fallbackQuote, sectionOf } from "../form-layout";
import type { Market } from "../pickers";

const spot = (name: string, displayName: string, trading = true) =>
  ({ name, displayName, engine: "spot", trading }) as unknown as Market;

describe("sectionOf", () => {
  it("puts amount and advanced flags ahead of the original group", () => {
    expect(sectionOf({ group: 3, amount: true })).toBe("amount");
    expect(sectionOf({ group: 2, advanced: true })).toBe("advanced");
    expect(sectionOf({ group: 2 })).toBe("market");
    expect(sectionOf({ group: 3 })).toBe("strategy");
    expect(sectionOf({ group: 4 })).toBe("risk");
  });

  it("gives every strategy an amount field (Volume Maker excepted)", () => {
    for (const [s, fields] of Object.entries(FIELDS)) {
      if (s === "volume_maker") continue;
      const amounts = fields.filter((f) => sectionOf(f) === "amount");
      expect(amounts.length, s).toBeGreaterThan(0);
    }
  });
});

describe("advancedSummary", () => {
  const adv = FIELDS.spot_grid.filter((f) => sectionOf(f) === "advanced");
  const label = (k: string, v: string) => `${k}:${v}`;

  it("lists enum choices and counts unset optional fields", () => {
    const r = advancedSummary(adv, { spacing: "geometric" }, {}, label);
    expect(r.enums).toContain("spacing:geometric");
    expect(r.optionalUnset).toBe(3);
    expect(r.needValue).toBe(0);
  });

  it("counts fields with server errors as needing a value", () => {
    const r = advancedSummary(adv, {}, { triggerPrice: ["Required"] }, label);
    expect(r.needValue).toBe(1);
    expect(r.optionalUnset).toBe(2);
  });

  it("counts empty required fields as needing a value", () => {
    const f = FIELDS.rebalancing.filter((x) => sectionOf(x) === "advanced");
    expect(advancedSummary(f, { maxTradePct: "" }, {}, label).needValue).toBe(1);
  });
});

describe("fallbackQuote", () => {
  it("uses USDC for perps and the chosen asset for Rebalancing", () => {
    expect(fallbackQuote("futures_grid", {}, [])).toBe("USDC");
    expect(fallbackQuote("twap", { engine: "perps" }, [])).toBe("USDC");
    expect(fallbackQuote("rebalancing", { quoteAsset: "USDT" }, [])).toBe("USDT");
  });

  it("only picks a Spot quote when every trading market shares it", () => {
    const one = [spot("vBTC_vUSDC", "BTC/USDC"), spot("vETH_vUSDC", "ETH/USDC")];
    expect(fallbackQuote("spot_grid", {}, one)).toBe("USDC");
    const two = [...one, spot("vBTC_vUSDT", "BTC/USDT")];
    expect(fallbackQuote("spot_grid", {}, two)).toBeUndefined();
    const halted = [...one, spot("vBTC_vUSDT", "BTC/USDT", false)];
    expect(fallbackQuote("spot_grid", {}, halted)).toBe("USDC");
  });
});

describe("defaultBotName", () => {
  const markets = [
    { name: "BNB-USD", displayName: "BNB-USD", engine: "perps" },
    { name: "vNVDA_vUSDC", displayName: "NVDA/USDC", engine: "spot" },
  ] as unknown as Parameters<typeof defaultBotName>[2];

  it("prefixes the base asset of the chosen market", () => {
    expect(defaultBotName("Futures Grid", { market: "BNB-USD" }, markets)).toBe("BNB Futures Grid");
    expect(defaultBotName("Spot Grid", { market: "vNVDA_vUSDC" }, markets)).toBe("NVDA Spot Grid");
  });

  it("uses the perps market for two-engine strategies", () => {
    expect(
      defaultBotName(
        "Funding Arbitrage",
        { spotMarket: "vNVDA_vUSDC", perpMarket: "BNB-USD" },
        markets,
      ),
    ).toBe("BNB Funding Arbitrage");
  });

  it("falls back to the strategy name without a known market", () => {
    expect(defaultBotName("Rebalancing", {}, markets)).toBe("Rebalancing");
    expect(defaultBotName("Futures Grid", { market: "XYZ-USD" }, markets)).toBe("Futures Grid");
  });
});

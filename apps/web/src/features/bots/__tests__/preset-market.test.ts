import { describe, expect, it } from "vitest";

import { presetMarket } from "../fields";

describe("presetMarket", () => {
  it("prefills strategies with one market field of the same engine", () => {
    expect(presetMarket("spot_grid", "vBTC_vUSDC", "spot")).toEqual({ market: "vBTC_vUSDC" });
    expect(presetMarket("futures_grid", "BTC-USD", "perps")).toEqual({ market: "BTC-USD" });
    expect(presetMarket("twap", "BTC-USD", "perps")).toEqual({
      engine: "perps",
      market: "BTC-USD",
    });
    // DEC-157: Market Making nhận mọi perp.
    expect(presetMarket("volume_maker", "SOL-USD", "perps")).toEqual({ market: "SOL-USD" });
  });
  it("skips strategies that can't use the market", () => {
    expect(presetMarket("spot_grid", "BTC-USD", "perps")).toBeNull();
    expect(presetMarket("futures_dca", "vBTC_vUSDC", "spot")).toBeNull();
    expect(presetMarket("rebalancing", "vBTC_vUSDC", "spot")).toBeNull();
    expect(presetMarket("funding_arb", "BTC-USD", "perps")).toBeNull();
    expect(presetMarket("volume_maker", "vBTC_vUSDC", "spot")).toBeNull();
  });
});

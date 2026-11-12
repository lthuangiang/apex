import { describe, expect, it } from "vitest";

import { botCapitalOf, requirementOf } from "../requirements";

// Vốn của bot (cột Capital ở Strategy Lab, tin "Bot started" gửi team): cùng một hàm cho api và engine.

describe("botCapitalOf", () => {
  it("uses the strategy's capital requirement in USDC", () => {
    const grid = {
      market: "BTC-USD",
      direction: "long",
      leverage: 2,
      marginMode: "cross",
      lowerPrice: "90",
      upperPrice: "110",
      gridLevels: 5,
      spacing: "arithmetic",
      margin: "200",
      maxLoss: "50",
      stopBelow: "80",
      onStop: "keep_position",
    };
    expect(botCapitalOf("futures_grid", grid)).toEqual({
      capital: requirementOf("futures_grid", grid).capital,
      capitalUnit: "quote",
    });
  });

  it("gives TWAP's total size in the base asset", () => {
    expect(botCapitalOf("twap", { totalSize: "0.5" })).toEqual({
      capital: "0.5",
      capitalUnit: "base",
    });
  });

  it("returns null instead of zero when it can't tell", () => {
    expect(botCapitalOf("twap", { totalSize: "0" }).capital).toBeNull();
    expect(botCapitalOf("futures_grid", null).capital).toBeNull();
    expect(botCapitalOf("unknown_strategy", { foo: 1 }).capital).toBeNull();
  });
});

import { describe, expect, it } from "vitest";

import { botFeeRate, botTakerFeeRate } from "../src/engine";

const rules = (makerFee?: string) => ({
  tickSize: "0.1",
  stepSize: "0.001",
  minQuantity: "0.001",
  minNotional: "10",
  ...(makerFee === undefined ? {} : { makerFee }),
});

describe("botFeeRate (DEC-112)", () => {
  it("uses the market maker fee plus the strategy's builder fee instead of a flat 0.05%", () => {
    // Volume Farm trên Perps: 0.012% + 0.005% mỗi chiều.
    expect(botFeeRate("volume_farm", {}, rules("0.00012"), false)).toBe("0.00017");
    expect(botFeeRate("volume_maker", {}, rules("0.00012"), false)).toBe("0.00015");
    expect(botFeeRate("adaptive_dca", {}, rules("0.00012"), false)).toBe("0.00022");
  });

  it("charges the Spot builder fee on the sell leg only", () => {
    expect(botFeeRate("spot_grid", {}, rules("0.00035"), false)).toBe("0.0004");
    expect(botFeeRate("twap", { engine: "perps" }, rules("0.00012"), false)).toBe("0.00022");
  });

  it("falls back to the published base fee when the market does not list one", () => {
    expect(botFeeRate("volume_farm", {}, undefined, false)).toBe("0.00017");
    expect(botFeeRate("spot_dca", {}, rules(), false)).toBe("0.0004");
  });

  it("charges no builder fee on the builder's own account (DEC-47)", () => {
    expect(botFeeRate("volume_farm", {}, rules("0.00012"), true)).toBe("0.00012");
  });
});

describe("botTakerFeeRate (DEC-117)", () => {
  it("uses the market taker fee plus the strategy's builder fee", () => {
    // Volume Farm trên Perps: 0.04% + 0.005% mỗi chiều.
    expect(botTakerFeeRate("volume_farm", {}, { ...rules(), takerFee: "0.0004" }, false)).toBe(
      "0.00045",
    );
    expect(botTakerFeeRate("volume_farm", {}, undefined, false)).toBe("0.00045");
    expect(botTakerFeeRate("volume_farm", {}, { ...rules(), takerFee: "0.0004" }, true)).toBe(
      "0.0004",
    );
  });
});

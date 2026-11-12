import { describe, expect, it } from "vitest";

import {
  builderFeeRateFor,
  builderFeeRateOf,
  builderRateOnFill,
  DRIFT_BUILDER_FEE_RATE,
  feeRateToFraction,
  feeRateToPercent,
  isBuilderAccount,
  isBuilderFeeApproved,
  oneWayFeeFraction,
  roundTripFeePct,
} from "../fees";
import { toDecimalString } from "../money";

describe("fees", () => {
  it("treats DRIFT's maxFeeRate 10 as 0.01% in tenths of a basis point (DEC-46)", () => {
    expect(DRIFT_BUILDER_FEE_RATE).toBe(10);
    expect(toDecimalString(feeRateToPercent(10))).toBe("0.01");
    expect(toDecimalString(feeRateToFraction(10))).toBe("0.0001");
    expect(toDecimalString(feeRateToPercent(50))).toBe("0.05");
  });

  it("converts other unit values consistently", () => {
    expect(toDecimalString(feeRateToPercent(10))).toBe("0.01");
    expect(toDecimalString(feeRateToPercent(1))).toBe("0.001");
    expect(toDecimalString(feeRateToPercent(0))).toBe("0");
  });

  it("rejects non-integer or negative rates", () => {
    expect(() => feeRateToPercent(0.5)).toThrow(RangeError);
    expect(() => feeRateToPercent(-1)).toThrow(RangeError);
  });

  it("counts an approval at or above DRIFT's rate as approved; SoDEX charges the lower of the two", () => {
    expect(isBuilderFeeApproved(10)).toBe(true);
    expect(isBuilderFeeApproved(50)).toBe(true);
    expect(isBuilderFeeApproved(9)).toBe(false);
    expect(isBuilderFeeApproved(0)).toBe(false);
    expect(isBuilderFeeApproved(null)).toBe(false);
  });

  describe("round-trip fee (DEC-112)", () => {
    const rt = (engine: "spot" | "perps", strategy: string, makerPct?: string) =>
      toDecimalString(
        roundTripFeePct({ engine, makerPct, builderRate: builderFeeRateOf(strategy) }),
      );

    it("charges the builder fee on both legs for Perps, per strategy", () => {
      expect(rt("perps", "volume_farm")).toBe("0.034");
      expect(rt("perps", "volume_maker")).toBe("0.03");
      expect(rt("perps", "futures_grid")).toBe("0.044");
    });

    it("charges the builder fee only on the Spot sell", () => {
      expect(rt("spot", "spot_grid")).toBe("0.08");
      expect(builderRateOnFill("spot", "buy", 10)).toBe(0);
      expect(builderRateOnFill("spot", "sell", 10)).toBe(10);
      expect(builderRateOnFill("perps", "buy", 10)).toBe(10);
    });

    it("uses the market's listed maker fee when given, including fee-free Spot markets", () => {
      expect(rt("perps", "volume_farm", "0.0108")).toBe("0.0316");
      expect(rt("spot", "spot_grid", "0")).toBe("0.01");
    });

    it("charges no builder fee on the builder's own account (DEC-47)", () => {
      expect(toDecimalString(roundTripFeePct({ engine: "perps", builderRate: 0 }))).toBe("0.024");
    });

    it("treats the builder's own account as exempt only while the exemption is on (DEC-124)", () => {
      expect(isBuilderAccount(1645n, 1645n)).toBe(true);
      expect(isBuilderAccount(1645n, 1645n, false)).toBe(false);
      expect(isBuilderAccount(7n, 1645n)).toBe(false);
    });

    it("gives the strategy step context half the round trip as a raw fraction", () => {
      const f = oneWayFeeFraction({
        engine: "perps",
        builderRate: builderFeeRateOf("volume_farm"),
      });
      expect(toDecimalString(f)).toBe("0.00017");
    });
  });
});

describe("builder fee per user (DEC-159)", () => {
  it("uses the team's rate for the user, else the strategy default", () => {
    expect(builderFeeRateFor("volume_maker")).toBe(3);
    expect(builderFeeRateFor("volume_maker", { volume_maker: 10 })).toBe(10);
    expect(builderFeeRateFor("volume_maker", { volume_maker: 0 })).toBe(0);
    expect(builderFeeRateFor("volume_farm", { volume_maker: 10 })).toBe(5);
  });

  it("never goes above what the user approved on SoDEX", () => {
    expect(builderFeeRateFor("spot_grid", { spot_grid: 25 })).toBe(DRIFT_BUILDER_FEE_RATE);
    expect(builderFeeRateFor("spot_grid", { spot_grid: -1 })).toBe(0);
  });
});

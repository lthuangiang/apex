import { describe, expect, it } from "vitest";

import {
  DRIFT_BUILDER_FEE_RATE,
  feeRateToFraction,
  feeRateToPercent,
  isBuilderFeeApproved,
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
});

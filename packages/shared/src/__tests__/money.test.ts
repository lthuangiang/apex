import { describe, expect, it } from "vitest";

import {
  add,
  dec,
  div,
  eq,
  gt,
  gte,
  isNegative,
  isZero,
  lt,
  lte,
  mul,
  roundToStep,
  sub,
  sum,
  toDecimalString,
} from "../money";

describe("money", () => {
  it("adds decimal strings without float error", () => {
    expect(toDecimalString(add("0.1", "0.2"))).toBe("0.3");
    expect(toDecimalString(sum(["0.1", "0.2", "0.3"]))).toBe("0.6");
  });

  it("keeps precision for large prices and tiny sizes", () => {
    expect(toDecimalString(mul("129948.11", "0.00012345"))).toBe("16.0420941795");
    expect(toDecimalString(sub("1000000000000.000000000001", "1"))).toBe(
      "999999999999.000000000001",
    );
  });

  it("rejects number-like strings that are not plain decimals", () => {
    for (const bad of ["", "1e5", "0x10", "1.", ".5", "01", "NaN", "Infinity", " 1"]) {
      expect(() => dec(bad)).toThrow(RangeError);
    }
  });

  it("throws on division by zero instead of returning Infinity", () => {
    expect(() => div("1", "0")).toThrow(RangeError);
    expect(toDecimalString(div("1", "8"))).toBe("0.125");
  });

  it("compares with helpers instead of ===", () => {
    expect(eq("1.50", "1.5")).toBe(true);
    expect(gt("2", "1.9999")).toBe(true);
    expect(gte("2", "2.0")).toBe(true);
    expect(lt("-1", "0")).toBe(true);
    expect(lte("0.0", "0")).toBe(true);
    expect(isZero("0.000")).toBe(true);
    expect(isNegative("-0")).toBe(false);
    expect(isNegative("-0.01")).toBe(true);
  });

  it("rounds to tick and lot steps", () => {
    expect(toDecimalString(roundToStep("100.37", "0.05", "down"))).toBe("100.35");
    expect(toDecimalString(roundToStep("100.37", "0.05", "up"))).toBe("100.4");
    expect(toDecimalString(roundToStep("100.375", "0.05", "nearest"))).toBe("100.4");
    expect(toDecimalString(roundToStep("0.123456", "0.001", "down"))).toBe("0.123");
    expect(toDecimalString(roundToStep("-1.26", "0.1", "down"))).toBe("-1.3");
  });

  it("rejects a non-positive step", () => {
    expect(() => roundToStep("1", "0", "down")).toThrow(RangeError);
    expect(() => roundToStep("1", "-0.1", "down")).toThrow(RangeError);
  });

  it("prints decimal strings without exponent notation", () => {
    expect(toDecimalString(dec("0.0000000001"))).toBe("0.0000000001");
    expect(toDecimalString(mul("1000000", "1000000000000000000000"))).toBe(
      "1000000000000000000000000000",
    );
    expect(toDecimalString(sub("1", "1"))).toBe("0");
  });
});

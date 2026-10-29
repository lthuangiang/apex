import { describe, expect, it } from "vitest";

import { plainDecimals } from "../src/plugins/plain-decimals";

describe("plainDecimals", () => {
  it("rewrites exponent numbers and leaves other strings alone", () => {
    expect(
      plainDecimals({
        a: "2.47775e-7",
        b: ["1E+3", "-5e-9", "0e-7"],
        c: "12.5",
        d: "vMAG7.ssi",
        e: "e10",
        f: null,
        g: 3,
      }),
    ).toEqual({
      a: "0.000000247775",
      b: ["1000", "-0.000000005", "0"],
      c: "12.5",
      d: "vMAG7.ssi",
      e: "e10",
      f: null,
      g: 3,
    });
  });

  it("keeps identifier fields that look like exponents", () => {
    expect(
      plainDecimals({ apiKey: { last4: "4e43" }, clOrdID: "1e5", builderId: "2e3", qty: "1e2" }),
    ).toEqual({ apiKey: { last4: "4e43" }, clOrdID: "1e5", builderId: "2e3", qty: "100" });
  });
});

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

  it("keeps account tails and group keys, and never expands a huge exponent (review #246 B3)", () => {
    expect(
      plainDecimals({
        tail: "23e51022",
        label: "9e999999",
        key: "123456e7",
        groups: [{ label: "23e51022", net: "1e2" }],
        odd: "9e999999",
        dust: "2.5e-21",
      }),
    ).toEqual({
      tail: "23e51022",
      label: "9e999999",
      key: "123456e7",
      groups: [{ label: "23e51022", net: "100" }],
      odd: "9e999999",
      dust: "0.0000000000000000000025",
    });
  });

  it("keeps who-did-it tails and wallet tails that look like exponents (#400)", () => {
    expect(
      plainDecimals({
        items: [{ createdBy: "1e05", net: "1e2" }],
        myLabel: { labeledBy: "42e3" },
        walletTail: "12345e67",
        hiddenBy: { stale: 2 },
      }),
    ).toEqual({
      items: [{ createdBy: "1e05", net: "100" }],
      myLabel: { labeledBy: "42e3" },
      walletTail: "12345e67",
      hiddenBy: { stale: 2 },
    });
  });

  it("keeps API key and coin identifiers whose value looks like an exponent (#400 review)", () => {
    expect(
      plainDecimals({
        apiKey: { last4: "1e05", status: "active" },
        keys: [{ last4: "42e3" }],
        tokenLast6: "12e345",
        positions: [{ coin: "1E3", size: "1e2" }],
      }),
    ).toEqual({
      apiKey: { last4: "1e05", status: "active" },
      keys: [{ last4: "42e3" }],
      tokenLast6: "12e345",
      positions: [{ coin: "1E3", size: "100" }],
    });
  });
});

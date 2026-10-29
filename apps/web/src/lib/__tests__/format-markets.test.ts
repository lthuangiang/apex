import { describe, expect, it } from "vitest";

import { formatAmount, stepDecimals } from "../format";
import { marketNames } from "../markets";

const spot = (name: string, displayName: string, base: string, quote: string) => ({
  name,
  engine: "spot" as const,
  displayName,
  base,
  quote,
  tickSize: "0.01",
  stepSize: "0.00001",
  trading: true,
  minNotional: "5",
  maxLeverage: null,
  last: null,
});

describe("formatAmount (UI_REVIEW E1.5)", () => {
  it("adds thousands separators and rounds to the given digits", () => {
    expect(formatAmount("80761.4", 2)).toEqual({ text: "80,761.40", full: null });
    expect(formatAmount("-1234.5678", 2)).toEqual({ text: "−1,234.57", full: "-1234.5678" });
  });

  it("shows tiny balances as < 0.0001 with the full value for a tooltip", () => {
    expect(formatAmount("0.000000982052580096")).toEqual({
      text: "< 0.0001",
      full: "0.000000982052580096",
    });
    expect(formatAmount("0")).toEqual({ text: "0", full: null });
  });

  it("caps free-form amounts at 8 decimals", () => {
    expect(formatAmount("0.00246926")).toEqual({ text: "0.00246926", full: null });
    expect(formatAmount("1.123456789")?.full).toBe("1.123456789");
  });

  it("reads digits from tick / lot sizes", () => {
    expect(stepDecimals("0.01")).toBe(2);
    expect(stepDecimals("1")).toBe(0);
    expect(stepDecimals("0.000010")).toBe(5);
  });
});

describe("marketNames (UI_REVIEW E1.6)", () => {
  const names = marketNames([
    spot("vBTC_vUSDC", "BTC/USDC", "vBTC", "vUSDC"),
    {
      name: "BTC-USD",
      engine: "perps",
      displayName: "BTC-USD",
      base: "BTC",
      quote: null,
      tickSize: "1",
      stepSize: "0.0001",
      trading: true,
      minNotional: "5",
      maxLeverage: 20,
      last: null,
    },
  ]);

  it("uses SoDEX display names for markets and keeps unknown codes", () => {
    expect(names.market("vBTC_vUSDC")).toBe("BTC/USDC");
    expect(names.market("BTC-USD")).toBe("BTC-USD");
    expect(names.market("vXYZ_vUSDC")).toBe("vXYZ_vUSDC");
  });

  it("derives asset names from spot markets, never guessing others", () => {
    expect(names.asset("vBTC")).toBe("BTC");
    expect(names.asset("vUSDC")).toBe("USDC");
    expect(names.asset("vMAG7.ssi")).toBe("vMAG7.ssi");
  });

  it("gives price / quantity digits from tick and lot sizes", () => {
    expect(names.priceDigits("vBTC_vUSDC")).toBe(2);
    expect(names.qtyDigits("BTC-USD")).toBe(4);
    expect(names.priceDigits("nope")).toBeNull();
  });
});

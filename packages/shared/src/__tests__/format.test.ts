import { describe, expect, it } from "vitest";

import { formatDateTime, formatDecimal, formatFeeRate, formatPercent, maskKey } from "../format";

describe("format", () => {
  it("returns null for missing values instead of 0", () => {
    expect(formatDecimal(null, { locale: "en-US" })).toBeNull();
    expect(formatDecimal(undefined, { locale: "en-US" })).toBeNull();
    expect(formatPercent(null, { locale: "en-US" })).toBeNull();
    expect(formatFeeRate(undefined, "en-US")).toBeNull();
    expect(formatDateTime(null, { locale: "en-US", timeZone: "UTC" })).toBeNull();
  });

  it("formats decimal strings exactly by locale", () => {
    expect(formatDecimal("129948.11", { locale: "en-US" })).toBe("129,948.11");
    expect(formatDecimal("129948.11", { locale: "de-DE" })).toBe("129.948,11");
    expect(formatDecimal("12345678901234567.89", { locale: "en-US" })).toBe(
      "12,345,678,901,234,567.89",
    );
  });

  it("applies fraction digits and sign display", () => {
    expect(
      formatDecimal("1.5", { locale: "en-US", minimumFractionDigits: 2, signDisplay: "always" }),
    ).toBe("+1.50");
    expect(formatDecimal("-0.126", { locale: "en-US", maximumFractionDigits: 2 })).toBe("-0.13");
  });

  it("supports compact notation for narrow screens", () => {
    expect(formatDecimal("1250000", { locale: "en-US", notation: "compact" })).toBe("1.3M");
  });

  it("formats the builder fee rate as 0.05%", () => {
    expect(formatFeeRate(50, "en-US")).toBe("0.05%");
    expect(formatFeeRate(0, "en-US")).toBe("0%");
  });

  it("masks keys to the last 4 characters", () => {
    expect(maskKey("0x9a1be0c4f2a")).toBe("••4f2a");
    expect(maskKey("4f2a")).toBe("••4f2a");
    expect(maskKey("abc")).toBeNull();
    expect(maskKey(null)).toBeNull();
  });

  it("formats times in the user's IANA time zone", () => {
    const iso = "2026-10-26T14:02:09Z";
    expect(formatDateTime(iso, { locale: "en-US", timeZone: "UTC" })).toBe("Oct 26, 2026, 2:02 PM");
    expect(formatDateTime(iso, { locale: "en-US", timeZone: "Asia/Ho_Chi_Minh" })).toBe(
      "Oct 26, 2026, 9:02 PM",
    );
    expect(formatDateTime("not a date", { locale: "en-US", timeZone: "UTC" })).toBeNull();
  });
});

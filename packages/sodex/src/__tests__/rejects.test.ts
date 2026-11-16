import { describe, expect, it } from "vitest";

import { isInsufficientMarginReject } from "../rejects";

describe("isInsufficientMarginReject", () => {
  it("matches code -1 with the SoDEX margin message seen on mainnet", () => {
    expect(isInsufficientMarginReject("-1", "insufficient margin")).toBe(true);
    expect(isInsufficientMarginReject(-1, "insufficient margin")).toBe(true);
  });

  it("ignores case and extra spaces", () => {
    expect(isInsufficientMarginReject("-1", "Insufficient Margin")).toBe(true);
    expect(isInsufficientMarginReject(" -1 ", "order rejected: INSUFFICIENT   margin")).toBe(true);
  });

  it("needs both the code and the message", () => {
    expect(isInsufficientMarginReject("-1", null)).toBe(false);
    expect(isInsufficientMarginReject("-1", undefined)).toBe(false);
    expect(isInsufficientMarginReject("-1", "position not found: 2")).toBe(false);
    expect(isInsufficientMarginReject("-1", "insufficient balance")).toBe(false);
    expect(isInsufficientMarginReject("-2", "insufficient margin")).toBe(false);
    expect(isInsufficientMarginReject("1", "insufficient margin")).toBe(false);
  });

  it("never treats a post-only reject as a margin reject", () => {
    expect(isInsufficientMarginReject("PostOnly", null)).toBe(false);
    expect(isInsufficientMarginReject("PostOnly", "insufficient margin")).toBe(false);
    expect(isInsufficientMarginReject("POST_ONLY_WOULD_TRADE", null)).toBe(false);
  });
});

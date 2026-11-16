import { describe, expect, it } from "vitest";

import { signedPct } from "../components/visual-panel";

// BT-01: % của kết quả backtest có dấu, tối đa 2 chữ số thập phân, dùng dấu trừ "−".

describe("backtest percent (BT-01)", () => {
  it("signs gains and losses and leaves zero unsigned", () => {
    expect(signedPct("-62.9")).toBe("−62.9%");
    expect(signedPct("12.456")).toBe("+12.46%");
    expect(signedPct("0")).toBe("0%");
    // Lỗ rất nhỏ làm tròn về 0: không "−0%" (review #150).
    expect(signedPct("-0.001")).toBe("0%");
  });
});

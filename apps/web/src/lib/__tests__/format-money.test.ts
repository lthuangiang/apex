import { describe, expect, it } from "vitest";

import { formatMoney } from "../format";

// Review #150: một số tiền rất nhỏ làm tròn về 0 không bao giờ ra "−0.00".

describe("formatMoney", () => {
  it("never shows −0.00 for a tiny loss rounded to zero", () => {
    expect(formatMoney("-0.001")).toBe("0.00");
    expect(formatMoney("-0.001", true)).toBe("0.00");
  });

  it("keeps the minus sign for real losses and + only when signed", () => {
    expect(formatMoney("-5.2")).toBe("−5.20");
    expect(formatMoney("-5.2", true)).toBe("−5.20");
    expect(formatMoney("5.2")).toBe("5.20");
    expect(formatMoney("5.2", true)).toBe("+5.20");
  });
});

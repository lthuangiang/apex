import { describe, expect, it } from "vitest";

import { limitsSet, serverLimitsSet } from "../components/risk-page";

// RS-01: không đặt giới hạn nào thì không được ghi "Within limits", và câu "N server-enforced limits pass" chỉ đếm
// giới hạn server đã đặt.

const none = {
  dailyLossPct: null,
  maxDrawdownPct: null,
  perTradePct: null,
  maxLeverage: null,
  maxPositions: null,
};

describe("risk limits that are set (RS-01)", () => {
  it("counts nothing when no limit is set", () => {
    expect(limitsSet({ limits: none })).toBe(0);
    expect(serverLimitsSet({ limits: none })).toBe(0);
  });

  it("counts only the server-enforced limits that are set", () => {
    const limits = { ...none, dailyLossPct: "5", maxLeverage: "10" };
    expect(limitsSet({ limits })).toBe(2);
    expect(serverLimitsSet({ limits })).toBe(1);
  });
});

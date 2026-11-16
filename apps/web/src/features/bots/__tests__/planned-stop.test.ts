import { describe, expect, it } from "vitest";

import { plannedStop } from "../components/bots-page";

// MM-01: bot dừng đúng kế hoạch không hiện "Needs attention" (không có việc gì để làm).

describe("planned stop (MM-01)", () => {
  it("is a stop for budget used up or target / run time reached, nothing else", () => {
    expect(plannedStop({ state: "stopped", reasonCode: "BUDGET_DONE" })).toBe(true);
    expect(plannedStop({ state: "stopped", reasonCode: "MAX_CYCLES" })).toBe(true);
    expect(plannedStop({ state: "stopped", reasonCode: "STOP_LOSS" })).toBe(false);
    expect(plannedStop({ state: "stopped", reasonCode: null })).toBe(false);
    expect(plannedStop({ state: "paused", reasonCode: "BUDGET_DONE" })).toBe(false);
  });
});

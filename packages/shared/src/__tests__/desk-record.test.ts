import { describe, expect, it } from "vitest";

import { changesOf, recordDue, RECORD_CONFIG, verdictOf } from "../desk/record";

describe("desk track record", () => {
  it("labels helped, made it worse, and no clear effect under 0.50 USDC", () => {
    expect(verdictOf("-4.10", "-9.40")).toBe("helped");
    expect(verdictOf("0.60", "1.80")).toBe("made_worse");
    expect(verdictOf("-3.31", "-3.70")).toBe("no_clear_effect");
    expect(verdictOf("-3.20", "-3.70")).toBe("helped");
    expect(verdictOf("-4.20", "-3.70")).toBe("made_worse");
  });

  it("is due only after 7 days", () => {
    const at = Date.parse("2026-11-01T00:00:00Z");
    expect(recordDue(at, at + RECORD_CONFIG.measureMs - 1)).toBe(false);
    expect(recordDue(at, at + RECORD_CONFIG.measureMs)).toBe(true);
  });

  it("lists the changed fields with old and new values", () => {
    expect(changesOf({ leverage: 40, slMarginPct: "80" }, { leverage: 10 })).toEqual([
      { key: "leverage", from: "40", to: "10" },
    ]);
    expect(changesOf({ slPct: "5" }, { slMarginPct: "50", slPct: null })).toEqual([
      { key: "slMarginPct", from: null, to: "50" },
      { key: "slPct", from: "5", to: null },
    ]);
  });
});

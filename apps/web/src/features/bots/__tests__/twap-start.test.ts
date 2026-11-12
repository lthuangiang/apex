import { twapSchema } from "@drift/strategies";
import { describe, expect, it } from "vitest";

import { emptyValues, fromConfig, toConfig } from "../fields";

const base = {
  ...emptyValues("twap"),
  engine: "perps",
  market: "BTC-USD",
  side: "buy",
  totalSize: "1",
  durationMinutes: "60",
  slices: "6",
  maxSlippagePct: "0.3",
  onSkip: "add_to_end",
  timeZone: "Asia/Ho_Chi_Minh",
};

describe("TWAP Start at form (IMP-03)", () => {
  it("defaults to Now and sends no start time", () => {
    const c = toConfig("twap", base);
    expect(c.start).toBe("now");
    expect(c.startDate).toBeUndefined();
    expect(c.timeZone).toBeUndefined();
    expect(twapSchema.safeParse(c).success).toBe(true);
  });

  it("sends date, time and the Settings time zone for At a time, and reads them back", () => {
    const v = { ...base, start: "at", startDate: "2026-11-01", startTime: "09:00" };
    const c = toConfig("twap", v);
    expect(c).toMatchObject({
      start: "at",
      startDate: Date.UTC(2026, 10, 1),
      startTime: "09:00",
      timeZone: "Asia/Ho_Chi_Minh",
    });
    expect(twapSchema.safeParse(c).success).toBe(true);
    expect(fromConfig("twap", c)).toMatchObject({
      start: "at",
      startDate: "2026-11-01",
      startTime: "09:00",
    });
  });

  it("opens an old config without start as Now", () => {
    const old = { ...toConfig("twap", base) };
    delete old.start;
    expect(fromConfig("twap", old).start).toBe("now");
  });
});

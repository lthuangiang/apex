import { describe, expect, it } from "vitest";

import { costPerMillionOfSums, fillCostPerMillion } from "../api/market-hours";
import { dec } from "../money";
import { opsCostMedian, opsHealth, sortOpsRows, type OpsHealthInput } from "../ops-health";

// Nhãn của trang Bot Monitor (docs/mockups/ops, quyết định 2–3).

const base: OpsHealthInput = {
  strategy: "volume_maker",
  state: "running",
  reasonCode: null,
  activeAlerts: [],
  resolvedAlert: null,
  requestsPerMinute: null,
  maxQuoteGapSec: null,
  positionCutsHour: 0,
  untracked: { count: 0, at: null },
  marketRejects: { count: 0, at: null },
  rejectedPauseAt: null,
  costPerMillion: null,
  costMedian: null,
  staleCandlesAt: null,
};
const T = "2026-11-16T10:00:00.000Z";

describe("Bot Monitor health", () => {
  it("is Healthy with nothing over a threshold, also when paused by its owner", () => {
    expect(opsHealth(base)).toEqual({ health: "healthy", reasons: [] });
    expect(opsHealth({ ...base, state: "paused" }).health).toBe("healthy");
  });

  it("is Problem for an active alert, a refused-entries pause, or a quoting gap above 5 min", () => {
    expect(
      opsHealth({ ...base, activeAlerts: [{ invariant: "P1", since: T, detail: "d" }] }).health,
    ).toBe("problem");
    expect(
      opsHealth({
        ...base,
        strategy: "volume_farm",
        state: "paused",
        reasonCode: "ORDER_REJECTED",
        marketRejects: { count: 3, at: T },
      }),
    ).toEqual({ health: "problem", reasons: [{ code: "rejected_pause", at: null }] });
    expect(opsHealth({ ...base, maxQuoteGapSec: "301" }).reasons).toEqual([
      { code: "gap_problem", value: "301" },
    ]);
    // Volume Builder không báo giá: không có quy tắc khoảng báo giá.
    expect(opsHealth({ ...base, strategy: "volume_farm", maxQuoteGapSec: "301" }).health).toBe(
      "check",
    );
  });

  it("is Check for each rule at its threshold, and not at the limit itself", () => {
    const check = (i: Partial<OpsHealthInput>) => opsHealth({ ...base, ...i }).health;
    expect(check({ requestsPerMinute: "55" })).toBe("healthy");
    expect(check({ requestsPerMinute: "55.1" })).toBe("check");
    expect(check({ maxQuoteGapSec: "60" })).toBe("healthy");
    expect(check({ maxQuoteGapSec: "60.5" })).toBe("check");
    expect(check({ positionCutsHour: 1 })).toBe("healthy");
    expect(check({ positionCutsHour: 2 })).toBe("check");
    expect(check({ untracked: { count: 1, at: T } })).toBe("check");
    expect(check({ marketRejects: { count: 1, at: T } })).toBe("check");
    expect(check({ staleCandlesAt: T })).toBe("check");
    expect(check({ resolvedAlert: { invariant: "P5", failedAt: T, resolvedAt: T } })).toBe("check");
    expect(check({ costPerMillion: "400", costMedian: "200" })).toBe("healthy");
    expect(check({ costPerMillion: "400.01", costMedian: "200" })).toBe("check");
    expect(check({ costPerMillion: "400.01", costMedian: null })).toBe("healthy");
  });

  it("shows Not running / Archived for stopped bots unless an alert is still open", () => {
    const busy = { requestsPerMinute: "90", untracked: { count: 2, at: T } };
    expect(opsHealth({ ...base, ...busy, state: "stopped" })).toEqual({
      health: "not_running",
      reasons: [],
    });
    expect(opsHealth({ ...base, state: "archived" }).health).toBe("archived");
    expect(
      opsHealth({
        ...base,
        state: "stopped",
        activeAlerts: [{ invariant: "P3", since: T, detail: "" }],
      }).health,
    ).toBe("problem");
  });

  it("applies the median rule only with 3 or more bots", () => {
    expect(opsCostMedian(["100", null, "300"])).toBeNull();
    expect(opsCostMedian(["100", "200", "900"])).toBe("200");
  });

  it("orders Problem, Check, Healthy, Not running, Archived, then by volume in the last hour", () => {
    const r = (
      id: string,
      health: "problem" | "check" | "healthy" | "not_running" | "archived",
      v: string | null,
    ) => ({
      id,
      health,
      volumeHour: v,
    });
    const out = sortOpsRows([
      r("a", "archived", "9"),
      r("b", "healthy", "5"),
      r("c", "check", null),
      r("d", "problem", "1"),
      r("e", "healthy", "50"),
      r("f", "not_running", null),
      r("g", "check", "2"),
    ]);
    expect(out.map((x) => x.id)).toEqual(["d", "g", "c", "e", "b", "f", "a"]);
  });

  it("computes cost per $1M from sums the same way as from fills", () => {
    const fills = [
      { side: "buy" as const, price: "100", size: "10", fee: "0.5", ref: "99" },
      { side: "sell" as const, price: "100", size: "10", fee: "0.5", ref: "99" },
    ];
    expect(fillCostPerMillion(fills).costPerMillion?.toString()).toBe("500");
    expect(
      costPerMillionOfSums({
        volume: dec("2000"),
        priced: dec("2000"),
        pricedFees: dec("1"),
        pnl: dec("0"),
      })?.toString(),
    ).toBe("500");
  });
});

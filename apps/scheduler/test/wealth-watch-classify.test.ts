import { describe, expect, it } from "vitest";

import {
  classifyExecutions,
  classifyFundEntries,
  executionKey,
  fundEntryKey,
  planMarkKey,
  shouldReadPlans,
  whatOf,
  type Execution,
  type FundEntry,
} from "../src/wealth-watch/classify";
import { parseWealthWatchInterval } from "../src/wealth-watch/interval";

// #594 (DEC-404): logic thuần của job cảnh báo SoDEX Wealth.

const entry = (over: Partial<FundEntry> = {}): FundEntry => ({
  fundId: "fund-a",
  entryId: null,
  kind: "subscribe",
  status: "processing",
  transactionType: null,
  channel: null,
  source: null,
  requestedAt: "2026-11-27T10:00:00Z",
  at: "2026-11-27T10:00:00Z",
  shares: null,
  requestedShares: null,
  proceeds: null,
  cost: "500.000000",
  costEstimated: null,
  planIndex: null,
  ...over,
});

const exec = (over: Partial<Execution> = {}): Execution => ({
  scheduledLocalDate: "2026-11-27",
  scheduledAt: null,
  status: "completed",
  reasonCode: null,
  amount: "25",
  attemptedAt: null,
  executedAt: null,
  ...over,
});

describe("fundEntryKey (dedupe key)", () => {
  it("uses entryId when SoDEX gives one, and ignores status / at changes", () => {
    const a = fundEntryKey(entry({ entryId: "e-1", status: "processing" }));
    const b = fundEntryKey(
      entry({ entryId: "e-1", status: "completed", at: "2026-11-28T00:00:00Z" }),
    );
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{24}$/);
    expect(fundEntryKey(entry({ entryId: "e-2" }))).not.toBe(a);
  });

  it("builds a key from fundId + kind + requestedAt + requestedShares/cost + planIndex without an id", () => {
    const base = fundEntryKey(entry());
    expect(fundEntryKey(entry({ status: "completed", at: "2026-11-28T00:00:00Z" }))).toBe(base);
    expect(fundEntryKey(entry({ fundId: "fund-b" }))).not.toBe(base);
    expect(fundEntryKey(entry({ kind: "redeem" }))).not.toBe(base);
    expect(fundEntryKey(entry({ requestedAt: "2026-11-27T10:00:01Z" }))).not.toBe(base);
    expect(fundEntryKey(entry({ cost: "499" }))).not.toBe(base);
    expect(fundEntryKey(entry({ planIndex: "3" }))).not.toBe(base);
    // requestedShares wins over cost when present.
    const shares = fundEntryKey(entry({ requestedShares: "10", cost: "1" }));
    expect(fundEntryKey(entry({ requestedShares: "10", cost: "2" }))).toBe(shares);
  });

  it("never contains the amount or the date in clear", () => {
    const k = fundEntryKey(entry({ cost: "123456.78" }));
    expect(k).not.toContain("123456");
    expect(k).not.toContain("2026");
  });
});

describe("whatOf", () => {
  it("maps transactionType first, then source, then kind; ignores airdrops and transfers", () => {
    expect(whatOf(entry({ transactionType: "recurring_buy" }))).toBe("recurring_buy");
    expect(whatOf(entry({ source: "recurring_buy" }))).toBe("recurring_buy");
    expect(whatOf(entry({ kind: "deposit" }))).toBe("invest");
    expect(whatOf(entry({ kind: "redeem" }))).toBe("redeem");
    expect(whatOf(entry({ kind: "airdrop" }))).toBeNull();
    expect(whatOf(entry({ kind: "transfer_in" }))).toBeNull();
    expect(whatOf(entry({ kind: "something_new" }))).toBeNull();
  });
});

describe("classifyFundEntries", () => {
  it("first pass only sets marks", () => {
    const r = classifyFundEntries([entry({ status: "completed" })], {}, true);
    expect(r.notices).toHaveLength(0);
    expect(Object.values(r.marks)).toEqual(["completed"]);
  });

  it("reports exactly once when a request moves to a final status", () => {
    const first = classifyFundEntries([entry()], {}, true);
    const second = classifyFundEntries([entry({ status: "completed" })], first.marks, false);
    expect(second.notices).toHaveLength(1);
    expect(second.notices[0]).toMatchObject({ what: "invest", status: "completed" });
    const third = classifyFundEntries([entry({ status: "completed" })], second.marks, false);
    expect(third.notices).toHaveLength(0);
  });

  it("reports a new row that is already final, and each final status once", () => {
    const r = classifyFundEntries([entry({ kind: "redeem", status: "failed" })], {}, false);
    expect(r.notices.map((n) => n.status)).toEqual(["failed"]);
    for (const s of ["rejected", "cancelled"])
      expect(classifyFundEntries([entry({ status: s })], {}, false).notices).toHaveLength(1);
  });

  it("does not report an unknown status and returns it for logging", () => {
    const r = classifyFundEntries([entry({ status: "settled_weird" })], {}, false);
    expect(r.notices).toHaveLength(0);
    expect(r.unknown).toEqual([{ field: "fund_status", value: "settled_weird" }]);
    // processing is known: no log.
    expect(classifyFundEntries([entry()], {}, false).unknown).toHaveLength(0);
  });

  it("keeps only marks of rows still in the response", () => {
    const old = { stale: "completed" };
    const r = classifyFundEntries([entry()], old, false);
    expect(r.marks).not.toHaveProperty("stale");
  });
});

describe("classifyExecutions", () => {
  const plan = "7";
  const dca = "0x2222222222222222222222222222222222222222";

  it("a plan seen for the first time only sets marks", () => {
    const r = classifyExecutions(plan, dca, [exec({ status: "SKIPPED" })], {}, false);
    expect(r.notices).toHaveLength(0);
    expect(r.marks[planMarkKey(plan)]).toBe("seen");
  });

  it("reports a skipped / failed run once, case-insensitive", () => {
    const seen = { [planMarkKey(plan)]: "seen" };
    const r = classifyExecutions(plan, dca, [exec({ status: "SKIPPED" })], seen, false);
    expect(r.notices).toHaveLength(1);
    expect(r.notices[0]?.status).toBe("skipped");
    const again = classifyExecutions(plan, dca, [exec({ status: "SKIPPED" })], r.marks, false);
    expect(again.notices).toHaveLength(0);
    const failed = classifyExecutions(plan, dca, [exec({ status: "failed" })], r.marks, false);
    expect(failed.notices.map((n) => n.status)).toEqual(["failed"]);
  });

  it("does not report an unknown status or an unknown reasonCode; returns them for logging", () => {
    const seen = { [planMarkKey(plan)]: "seen" };
    const s = classifyExecutions(plan, dca, [exec({ status: "WEIRD" })], seen, false);
    expect(s.notices).toHaveLength(0);
    expect(s.unknown).toEqual([{ field: "exec_status", value: "WEIRD" }]);
    const r = classifyExecutions(
      plan,
      dca,
      [exec({ status: "skipped", reasonCode: "NEW_REASON" })],
      seen,
      false,
    );
    expect(r.notices).toHaveLength(0);
    expect(r.unknown).toEqual([{ field: "exec_reason", value: "NEW_REASON" }]);
  });

  it("execution key is per plan and date, not per status", () => {
    expect(executionKey(plan, dca, "2026-11-27")).toBe(
      executionKey(plan, dca.toUpperCase(), "2026-11-27"),
    );
    expect(executionKey(plan, dca, "2026-11-27")).not.toBe(executionKey(plan, dca, "2026-11-28"));
    expect(executionKey(plan, dca, "2026-11-27").startsWith(`${plan}:`)).toBe(true);
  });
});

describe("shouldReadPlans", () => {
  const now = Date.parse("2026-11-28T08:00:00Z");
  it("reads when the user has plans or fund-details shows a recurring buy", () => {
    expect(shouldReadPlans(true, [], new Date(now), now)).toBe(true);
    expect(shouldReadPlans(false, [entry({ planIndex: "1" })], new Date(now), now)).toBe(true);
  });
  it("otherwise re-checks at most once a day", () => {
    expect(shouldReadPlans(false, [entry()], null, now)).toBe(true);
    expect(shouldReadPlans(false, [entry()], new Date(now - 3600_000), now)).toBe(false);
    expect(shouldReadPlans(false, [entry()], new Date(now - 25 * 3600_000), now)).toBe(true);
  });
});

describe("parseWealthWatchInterval", () => {
  it("accepts 5 and 60; defaults to 10 without a warning", () => {
    expect(parseWealthWatchInterval("5")).toEqual({ minutes: 5, invalid: null });
    expect(parseWealthWatchInterval(" 60 ")).toEqual({ minutes: 60, invalid: null });
    expect(parseWealthWatchInterval(undefined)).toEqual({ minutes: 10, invalid: null });
    expect(parseWealthWatchInterval("")).toEqual({ minutes: 10, invalid: null });
  });

  it.each(["4", "61", "0", "abc", "7.5"])("falls back to 10 and flags %j for a warning", (raw) => {
    expect(parseWealthWatchInterval(raw)).toEqual({ minutes: 10, invalid: { received: raw } });
  });
});

import { describe, expect, it } from "vitest";

import {
  backoffMs,
  baselineMark,
  freshItems,
  ledgerItemKey,
  levelCounts,
  MAX_BACKOFF_MS,
  nextCheckAt,
  nextMark,
  prizeRounds,
  prizesByRound,
  receivedItems,
  rememberRounds,
  type LedgerItem,
} from "../src/rewards-watch/classify";

// #558 (DEC-398): phân loại ledger CHỈ theo trường SoDEX trả, mốc "đã thấy", chu kỳ và lùi (rewards-confirmed-fields.md).

const transfer = (tsMs: number, tokenId: number, extra: Partial<LedgerItem> = {}): LedgerItem => ({
  kind: "transfer",
  tsMs,
  tokenId,
  level: "Common",
  direction: "in",
  ...extra,
});

describe("freshItems / nextMark", () => {
  it("returns rows newer than the mark, including rows at the same ms not seen yet", () => {
    const seenAtMark = transfer(1000, 1);
    const sameMs = transfer(1000, 2);
    const newer = transfer(2000, 3);
    const older = transfer(500, 4);
    const mark = { tsMs: 1000, ids: [ledgerItemKey(seenAtMark)] };
    const { fresh, reachedMark } = freshItems([newer, sameMs, seenAtMark, older], mark);
    expect(fresh).toEqual([newer, sameMs]);
    expect(reachedMark).toBe(true);
    expect(nextMark(mark, fresh)).toEqual({ tsMs: 2000, ids: [ledgerItemKey(newer)] });
  });

  it("keeps the mark when nothing is new and merges ids at the same ms", () => {
    const mark = { tsMs: 1000, ids: ["a"] };
    expect(nextMark(mark, [])).toEqual(mark);
    const same = transfer(1000, 9);
    expect(nextMark(mark, [same]).ids).toEqual(["a", ledgerItemKey(same)]);
  });

  it("asks for another page only when a whole page is new", () => {
    const mark = { tsMs: 0, ids: [] };
    expect(freshItems([transfer(5, 1), transfer(4, 2)], mark).reachedMark).toBe(false);
  });
});

describe("baselineMark", () => {
  it("is the newest row, or now when the ledger is empty", () => {
    expect(baselineMark([], 42)).toEqual({ tsMs: 42, ids: [] });
    const a = transfer(3000, 1);
    expect(baselineMark([a, transfer(2000, 2)], 99_999)).toEqual({
      tsMs: 3000,
      ids: [ledgerItemKey(a)],
    });
  });
});

describe("classification by `reason` only", () => {
  const items: LedgerItem[] = [
    transfer(10, 1, { reason: "lottery_prize", round: 10 }),
    transfer(9, 2, { reason: "lottery_prize", round: 10, level: "Common" }),
    transfer(8, 3, { reason: "lottery_prize" }),
    transfer(7, 4, { level: "Uncommon" }),
    transfer(6, 5, { reason: "something_else", level: null }),
    transfer(5, 6, { direction: "out" }),
    { kind: "open", tsMs: 4, tokenId: 7 },
    { kind: "treasure", tsMs: 3, tokenId: 8 },
    { kind: "merge", tsMs: 2 },
  ];

  it("received = incoming transfers that are not lottery_prize", () => {
    expect(receivedItems(items).map((i) => i.tokenId)).toEqual([4, 5]);
    expect(levelCounts(receivedItems(items))).toEqual([
      { level: "Uncommon", count: 1 },
      { level: null, count: 1 },
    ]);
  });

  it("prizes = incoming lottery_prize, grouped by round (missing round grouped as null)", () => {
    const byRound = prizesByRound(items);
    expect([...byRound.keys()]).toEqual([10, null]);
    expect(byRound.get(10)?.map((i) => i.tokenId)).toEqual([1, 2]);
    expect(byRound.get(null)?.map((i) => i.tokenId)).toEqual([3]);
    expect(prizeRounds(items)).toEqual([10]);
  });

  it("ignores own actions (open, treasure claim, merge) and outgoing transfers", () => {
    const own = items.filter((i) => i.kind !== "transfer" || i.direction === "out");
    expect(receivedItems(own)).toEqual([]);
    expect(prizesByRound(own).size).toBe(0);
  });
});

describe("rememberRounds / nextCheckAt / backoffMs", () => {
  it("keeps the 20 newest rounds", () => {
    const many = Array.from({ length: 25 }, (_, i) => i + 1);
    expect(rememberRounds([], many)).toEqual(many.slice(-20));
    expect(rememberRounds([3, 4], [4, 5])).toEqual([3, 4, 5]);
  });

  it("spreads users within ±10% of the interval, deterministically", () => {
    const now = new Date("2026-11-26T08:00:00Z");
    const interval = 15 * 60_000;
    for (const user of ["a", "b", "c", "d"]) {
      const at = nextCheckAt(now, interval, user).getTime() - now.getTime();
      expect(at).toBeGreaterThanOrEqual(interval * 0.9);
      expect(at).toBeLessThanOrEqual(interval * 1.1);
      expect(nextCheckAt(now, interval, user).getTime() - now.getTime()).toBe(at);
    }
    expect(nextCheckAt(now, interval, "a")).not.toEqual(nextCheckAt(now, interval, "b"));
  });

  it("backs off exponentially up to 6 hours", () => {
    expect(backoffMs(60_000, 1)).toBe(120_000);
    expect(backoffMs(60_000, 2)).toBe(240_000);
    expect(backoffMs(15 * 60_000, 10)).toBe(MAX_BACKOFF_MS);
  });
});

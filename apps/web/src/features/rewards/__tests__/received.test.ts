import type { LotteryLedgerItem } from "@drift/shared";
import { describe, expect, it } from "vitest";

import {
  drawResultOf,
  initialSeen,
  levelCounts,
  markSeen,
  newEvents,
  type DrawResult,
} from "../received";

// Logic popup box mới nhận / vé trúng (#556): phân loại chỉ theo `reason`, mốc "đã xem", lần ký đầu, gộp theo round.

const tr = (tsMs: number, extra: Partial<LotteryLedgerItem> = {}): LotteryLedgerItem => ({
  kind: "transfer",
  tsMs,
  direction: "in",
  level: "Common",
  tokenId: tsMs,
  ...extra,
});

const draw: DrawResult = {
  round: 10,
  status: "distributed",
  wins: 1,
  tickets: 27,
  won: [{ tokenId: 188201, level: "Rare", prizeLevel: "Common" }],
};

describe("newEvents", () => {
  it("classifies only by reason: lottery_prize → draw section by round, anything else in → Received", () => {
    const items = [
      tr(10, { reason: "lottery_prize", round: 10 }),
      tr(11, { reason: "lottery_prize", round: 10 }),
      tr(12, { reason: "campaign_bonus" }),
      tr(13),
      tr(14, { direction: "out" }),
      { kind: "open", tsMs: 15, level: "Common", tokenId: 1 },
      tr(5),
    ] as LotteryLedgerItem[];
    const e = newEvents(items, draw, { ledgerTsMs: 9, drawRounds: [] });
    expect(e.received.map((r) => r.tsMs)).toEqual([13, 12]);
    expect(e.prizes).toEqual([{ round: 10, items: [items[0], items[1]] }]);
    expect(e.draw).toBe(draw);
  });

  it("nothing new after the seen mark; a seen round is not shown again; wins 0 is not a win", () => {
    const items = [tr(10), tr(11, { reason: "lottery_prize", round: 10 })];
    const e = newEvents(items, draw, { ledgerTsMs: 11, drawRounds: [10] });
    expect(e).toEqual({ received: [], prizes: [], draw: null });
    expect(newEvents([], { ...draw, wins: 0 }, { ledgerTsMs: 0, drawRounds: [] }).draw).toBeNull();
  });
});

describe("seen mark", () => {
  it("first sign-in marks everything as seen (or now when the ledger is empty)", () => {
    expect(initialSeen([tr(5), tr(9)], draw, 1000)).toEqual({ ledgerTsMs: 9, drawRounds: [10] });
    expect(initialSeen([], null, 1000)).toEqual({ ledgerTsMs: 1000, drawRounds: [] });
  });

  it("closing marks the newest shown tsMs and the shown rounds", () => {
    const e = newEvents([tr(20), tr(30, { reason: "lottery_prize", round: 9 })], draw, {
      ledgerTsMs: 10,
      drawRounds: [8],
    });
    expect(markSeen({ ledgerTsMs: 10, drawRounds: [8] }, e)).toEqual({
      ledgerTsMs: 30,
      drawRounds: [8, 9, 10],
    });
  });
});

describe("drawResultOf / levelCounts", () => {
  it("uses wins only when it is a number; keeps won tickets", () => {
    expect(drawResultOf({ round: 11, status: "snapshot", wins: undefined })).toBeNull();
    expect(
      drawResultOf({
        round: 10,
        status: "distributed",
        wins: 1,
        tickets: 3,
        entries: [
          { tokenId: 1, level: "Rare", won: true, prizeLevel: "Common" },
          { tokenId: 2, level: "Common", won: false },
        ],
      }),
    ).toEqual({
      round: 10,
      status: "distributed",
      wins: 1,
      tickets: 3,
      won: [{ tokenId: 1, level: "Rare", prizeLevel: "Common" }],
    });
  });

  it("counts by level, Common → SuperRare, unknown last", () => {
    const rows = [
      tr(1, { level: "Rare" }),
      tr(2, { level: "Mythic" }),
      tr(3),
      tr(4),
      tr(5, { level: "Uncommon" }),
      tr(6, { level: null }),
    ];
    expect(levelCounts(rows)).toEqual([
      { level: "Common", n: 2 },
      { level: "Uncommon", n: 1 },
      { level: "Rare", n: 1 },
      { level: "Mythic", n: 1 },
    ]);
  });
});

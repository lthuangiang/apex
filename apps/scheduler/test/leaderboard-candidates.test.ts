import type { HlLeaderboardRow } from "@drift/hyperliquid";
import { describe, expect, it } from "vitest";

import { pickCandidates } from "../src/leaderboard";

// Chọn ứng viên leaderboard (DEC-TBD-copy-candidates): sàn an toàn rồi xếp theo ROI 30 ngày.

const row = (
  address: string,
  accountValue: string,
  month: { pnl: string; roi: string },
  weekPnl = "100",
): HlLeaderboardRow => ({
  ethAddress: address,
  accountValue,
  displayName: null,
  windowPerformances: [
    ["week", { pnl: weekPnl, roi: "0.01", vlm: "1" }],
    ["month", { pnl: month.pnl, roi: month.roi, vlm: "1" }],
  ],
});

describe("pickCandidates", () => {
  it("ranks by 30-day ROI, not by PnL", () => {
    const out = pickCandidates(
      [
        row("0xwhale", "9000000", { pnl: "900000", roi: "0.1" }),
        row("0xsmall", "50000", { pnl: "40000", roi: "0.8" }),
        row("0xmid", "400000", { pnl: "120000", roi: "0.3" }),
      ],
      10,
    );
    expect(out.map((c) => c.row.ethAddress)).toEqual(["0xsmall", "0xmid", "0xwhale"]);
  });

  it("drops wallets outside the safety floor", () => {
    const out = pickCandidates(
      [
        row("0xtiny", "10000", { pnl: "20000", roi: "2" }),
        row("0xhuge", "25000000", { pnl: "3000000", roi: "0.2" }),
        row("0xlowpnl", "100000", { pnl: "5000", roi: "0.05" }),
        row("0xbadweek", "100000", { pnl: "50000", roi: "0.5" }, "-1"),
        row("0xok", "100000", { pnl: "50000", roi: "0.5" }),
      ],
      10,
    );
    expect(out.map((c) => c.row.ethAddress)).toEqual(["0xok"]);
  });

  it("skips rows without a month or week window, and keeps the limit", () => {
    const noWeek: HlLeaderboardRow = {
      ethAddress: "0xnoweek",
      accountValue: "100000",
      displayName: null,
      windowPerformances: [["month", { pnl: "50000", roi: "0.5", vlm: "1" }]],
    };
    const many = Array.from({ length: 5 }, (_, i) =>
      row(`0x${String(i)}`, "100000", { pnl: "50000", roi: String(i) }),
    );
    const out = pickCandidates([noWeek, ...many], 3);
    expect(out.map((c) => c.row.ethAddress)).toEqual(["0x4", "0x3", "0x2"]);
    expect(out[0]?.pnl).toBe("50000");
  });
});

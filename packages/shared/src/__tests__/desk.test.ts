import { describe, expect, it } from "vitest";

import {
  deskNotes,
  goalCheck,
  holdResult,
  lossLimitOf,
  paperReasons,
  paperVerdict,
  recommend,
  type RecoInput,
} from "..";
import { MARKETS, NEW_TRADER } from "../reco/__tests__/fixtures";

// AI Desk (DEC-105): Goal check, một bot cho Recommended, mức lỗ trên thẻ, kết luận Test results, Your bots.

const NOW = Date.UTC(2026, 9, 27, 7, 0, 0);
const DAY = 86_400_000;
const input = (over: Partial<RecoInput> = {}): RecoInput => ({
  account: NEW_TRADER,
  goals: { goal: "automate", capital: "8000", maxDrop: "10", assets: ["BTC", "ETH"] },
  markets: MARKETS,
  accountLeverageCap: 3,
  now: NOW,
  ...over,
});

describe("goal check", () => {
  it("turns a daily target into a yearly % with the documented bands", () => {
    expect(goalCheck("2", "100")).toMatchObject({ annualPct: "730", band: "unrealistic" });
    expect(goalCheck("2", "1000")).toMatchObject({ annualPct: "73", band: "ambitious" });
    expect(goalCheck("2", "5000")).toMatchObject({ annualPct: "14.6", band: "reasonable" });
    // Biên: đúng 20% vẫn là vừa phải, đúng 100% vẫn là tham vọng.
    expect(goalCheck("1", "1825")?.band).toBe("reasonable");
    expect(goalCheck("1", "365")?.band).toBe("ambitious");
    expect(goalCheck("2", "5000")?.examples).toEqual([
      { annualPct: "10", capital: "7300" },
      { annualPct: "20", capital: "3650" },
    ]);
    expect(goalCheck("0", "100")).toBeNull();
    expect(goalCheck("abc", "100")).toBeNull();
  });

  it("is never an input of recommend(): the plan is the same whatever the goal", () => {
    // recommend() không nhận mục tiêu tiền mỗi ngày; kiểm tra bằng cách chạy Goal check giữa hai lần gọi.
    const a = JSON.stringify(recommend(input(), "UTC"));
    goalCheck("50", "8000");
    const b = JSON.stringify(recommend(input(), "UTC"));
    expect(a).toBe(b);
    expect(Object.keys(input())).not.toContain("daily");
  });
});

describe("single-bot recommendation", () => {
  it("gives the whole capital to the main bot and no add-on", () => {
    const split = recommend(input(), "UTC");
    const single = recommend(input({ single: true }), "UTC");
    expect(single.addOns).toEqual([]);
    expect(single.best?.capital).toBe("8000");
    expect(single.best?.strategy).toBe(split.best?.strategy);
  });

  it("keeps onboarding unchanged when the option is off", () => {
    const plan = recommend(input(), "UTC");
    expect(plan.addOns.length).toBe(1);
    expect(Number(plan.best?.capital)).toBeLessThan(8000);
  });
});

describe("loss limit on the card", () => {
  it("shows maxLoss when the strategy has one, and no limit otherwise", () => {
    expect(lossLimitOf({ maxLoss: "500" })).toEqual({ kind: "limit", amount: "500" });
    expect(lossLimitOf({ amountPerBuy: "50" })).toEqual({ kind: "none" });
    expect(lossLimitOf({ maxLoss: "" })).toEqual({ kind: "none" });
  });

  it("matches each recommended strategy", () => {
    for (const goal of ["automate", "range", "accumulate", "steady"] as const) {
      const s = recommend(input({ goals: { ...input().goals, goal }, single: true }), "UTC").best;
      if (s === null) continue;
      const limit = lossLimitOf(s.values);
      if (s.strategy === "recurring_buy" || s.strategy === "rebalancing")
        expect(limit.kind).toBe("none");
      else expect(limit).toEqual({ kind: "limit", amount: "800" });
    }
  });
});

describe("test results verdict", () => {
  const base = { startedAt: NOW, now: NOW + 20 * DAY, net: "10", stoppedByLossLimit: false };
  it("checks the rules in order", () => {
    expect(paperVerdict({ ...base, stoppedByLossLimit: true, now: NOW + DAY })).toBe("loss_limit");
    expect(paperVerdict({ ...base, now: NOW + 13 * DAY })).toBe("too_early");
    expect(paperVerdict({ ...base, net: "-5" })).toBe("lost");
    expect(paperVerdict(base)).toBe("made");
    expect(paperVerdict({ ...base, net: "0" })).toBe("lost");
  });

  it("compares with just holding the coin and explains the result", () => {
    expect(holdResult("5000", "100000", "106800")).toBe("340");
    expect(holdResult("5000", null, "1")).toBeNull();
    expect(
      paperReasons({
        fills: 168,
        net: "212.3",
        fees: "58.4",
        maxDrawdown: "186",
        lossLimit: { kind: "limit", amount: "500" },
        stoppedByLossLimit: false,
      }),
    ).toEqual([
      { key: "feeShareOfProfit", pct: "22" },
      { key: "limitUsed", pct: "37" },
      { key: "fills", count: 168 },
    ]);
    expect(
      paperReasons({
        fills: 0,
        net: "0",
        fees: "0",
        maxDrawdown: "0",
        lossLimit: { kind: "none" },
        stoppedByLossLimit: false,
      }),
    ).toEqual([{ key: "noFills" }]);
  });
});

describe("your bots notes", () => {
  const bot = {
    id: "b1",
    name: "Grid",
    state: "running",
    needsAttention: false,
    attentionSince: null,
    netPnl: "-4.1",
    fees: "3.2",
    fills: 86,
    firstFillAt: NOW - 5 * DAY,
    quote: "USDC",
  };
  it("reuses the analyst rules", () => {
    const notes = deskNotes(
      [
        bot,
        { ...bot, id: "b2", needsAttention: true, attentionSince: NOW - DAY },
        { ...bot, id: "b3", netPnl: "10", fees: "1" },
      ],
      NOW,
    );
    expect(notes.map((n) => n.kind)).toEqual(["fees", "attention", "fine"]);
    expect(notes[1]?.since).toBe(NOW - DAY);
  });
});

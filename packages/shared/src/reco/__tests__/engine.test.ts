import { describe, expect, it } from "vitest";

import { recommend } from "../engine";
import { RECO_GOALS, type RecoInput } from "../types";

import { EXPERIENCED, MARKETS, NEW_TRADER } from "./fixtures";

// Golden test (RECO_ENGINE.md mục 10.6): mỗi goal × người mới / có kinh nghiệm, các ca biên, và tất định.

const NOW = Date.UTC(2026, 9, 27, 7, 0, 0);
const base = (over: Partial<RecoInput["goals"]> = {}, account = EXPERIENCED): RecoInput => ({
  account,
  goals: { goal: "automate", capital: "8000", maxDrop: "10", assets: ["BTC", "ETH"], ...over },
  markets: MARKETS,
  accountLeverageCap: 3,
  now: NOW,
});

describe("reco engine golden files", () => {
  for (const goal of RECO_GOALS) {
    for (const [who, account] of [
      ["experienced", EXPERIENCED],
      ["new", NEW_TRADER],
    ] as const) {
      it(`${goal} · ${who}`, async () => {
        const plan = recommend(base({ goal }, account), "Asia/Ho_Chi_Minh");
        await expect(JSON.stringify(plan, null, 2) + "\n").toMatchFileSnapshot(
          `./golden/${goal}-${who}.json`,
        );
      });
    }
  }

  it("returns the empty message when no strategy fits", () => {
    const plan = recommend(base({ goal: "range", assets: ["SOL"] }), "UTC");
    expect(plan.best).toBeNull();
    expect(plan.empty).toBe(
      "No strategy fits your answers yet. Try a larger capital or a different goal.",
    );
  });

  it("returns nothing when every market is excluded", () => {
    expect(recommend(base({ assets: ["DOGE"] }), "UTC").best).toBeNull();
  });

  it("returns nothing when capital is below every minimum", () => {
    expect(recommend(base({ capital: "20" }), "UTC").best).toBeNull();
  });

  it("explains what it didn't suggest from history", () => {
    const plan = recommend(base(), "UTC");
    expect(plan.notSuggested.map((n) => n.reason)).toEqual(
      expect.arrayContaining([
        "Your trades under 15 minutes lost 1,240.55 after fees.",
        "SOL: -2,234.38 net with a 38% win rate.",
      ]),
    );
    expect(plan.notes.join(" ")).toContain("Positions at 8× or more caused 63% of your losses");
  });

  it("forces 1× on perp bots when high leverage drove losses", () => {
    const plan = recommend(base(), "UTC");
    for (const s of [plan.best, ...plan.addOns]) {
      if (s !== null && "leverage" in s.values) expect(s.values.leverage).toBe(1);
    }
  });

  it("is byte-for-byte deterministic", () => {
    const a = JSON.stringify(recommend(base(), "UTC"));
    const b = JSON.stringify(recommend(JSON.parse(JSON.stringify(base())) as RecoInput, "UTC"));
    expect(a).toBe(b);
  });

  it("never returns a profit or yield figure", () => {
    const text = JSON.stringify(recommend(base({ goal: "steady" }), "UTC"));
    expect(text).not.toMatch(/APR|APY|expected (profit|return)|yield/i);
  });
});

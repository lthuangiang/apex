import { describe, expect, it } from "vitest";

import { rewardsWeekMessage, weekdayTime } from "../src/rewards-week-render";
import { renderTelegram } from "../src/telegram-render";

// #567: tin tuần trên Telegram theo mẫu chủ sản phẩm duyệt; thiếu trường thì bỏ dòng, 0 thật hiện "$0.00"; giờ theo
// múi giờ người nhận; không ví, không squad.

const APP = "https://desklabs.test";
// Mẫu: Week 13 = Nov 24 – Dec 1, chia điểm Fri, Dec 4 · 19:00 giờ Việt Nam (12:00 UTC).
const START = Date.parse("2026-11-24T12:00:00Z") / 1000;
const END = Date.parse("2026-12-01T12:00:00Z") / 1000;
const DIST = Date.parse("2026-12-04T12:00:00Z") / 1000;

const snapshot = (over: Record<string, unknown> = {}) => ({
  weekNo: 13,
  weekName: "Week 13",
  weekStartTime: START,
  weekEndTime: END,
  futuresVolume: "70722.87",
  spotVolume: "7.65",
  oi: "17.62",
  accountValue: "208.33",
  vaultHolding: "0",
  wealthTvl: "2.57",
  boosted: { symbol: "NVDA-USD", coefficient: "1.2", more: 2 },
  distributionTime: DIST,
  timeZone: "Asia/Ho_Chi_Minh",
  ...over,
});
const points = (over: Record<string, unknown> = {}) => ({
  weekNo: 13,
  weekName: "Week 13",
  points: "521",
  rank: "1410",
  totalUser: "226582",
  rankPercentile: "Top 0.06%",
  totalPoints: "29556",
  currentTier: "DIAMOND",
  nextTier: "EPIC",
  nextTierPoints: "50000",
  timeZone: "Asia/Ho_Chi_Minh",
  ...over,
});

describe("week snapshot message", () => {
  it("matches the approved template", () => {
    const r = renderTelegram(
      [{ type: "rewards_week_snapshot", data: snapshot(), botName: null }],
      APP,
    );
    expect(r.text).toBe(
      [
        "📊 <b>SoDEX · Week 13 snapshot</b>",
        "Nov 24 – Dec 1",
        "",
        "<pre>Perps volume    $70,722.87",
        "Spot volume          $7.65",
        "Open interest       $17.62",
        "Account value      $208.33",
        "Vault                $0.00",
        "Wealth TVL           $2.57</pre>",
        "",
        "Boosted volume: NVDA-USD ×1.2 and 2 more",
        "Points for this week arrive Fri, Dec 4 · 19:00",
      ].join("\n"),
    );
    expect(r.button).toEqual({ text: "Open Rewards", url: `${APP}/rewards` });
  });

  it("drops each missing field's line, keeps a real 0", () => {
    for (const field of [
      "futuresVolume",
      "spotVolume",
      "oi",
      "accountValue",
      "vaultHolding",
      "wealthTvl",
    ]) {
      const m = rewardsWeekMessage("rewards_week_snapshot", snapshot({ [field]: null }));
      expect(m?.body).not.toBeUndefined();
      expect((m?.body?.match(/\$/g) ?? []).length).toBe(5);
    }
    const noBoost = rewardsWeekMessage("rewards_week_snapshot", snapshot({ boosted: null }));
    expect(noBoost?.body).not.toContain("Boosted");
    const noDist = rewardsWeekMessage(
      "rewards_week_snapshot",
      snapshot({ distributionTime: null }),
    );
    expect(noDist?.body).not.toContain("Points for this week");
    const one = rewardsWeekMessage(
      "rewards_week_snapshot",
      snapshot({ boosted: { symbol: "A-USD", coefficient: "1.1", more: 0 } }),
    );
    expect(one?.body).toContain("Boosted volume: A-USD ×1.1\n");
    expect(
      rewardsWeekMessage("rewards_week_snapshot", snapshot({ vaultHolding: "0" }))?.body,
    ).toContain("$0.00");
  });

  it("uses the recipient's time zone", () => {
    expect(weekdayTime(DIST, "Asia/Ho_Chi_Minh")).toBe("Fri, Dec 4 · 19:00");
    expect(weekdayTime(DIST, "UTC")).toBe("Fri, Dec 4 · 12:00");
  });
});

describe("week points message", () => {
  it("matches the approved template", () => {
    const r = renderTelegram([{ type: "rewards_week_points", data: points(), botName: null }], APP);
    expect(r.text).toBe(
      [
        "🏆 <b>Week 13 SoPoints: +521</b>",
        "Rank 1,410 of 226,582 · Top 0.06%",
        "",
        "<pre>Total   29,556 SoPoints",
        "Tier    DIAMOND",
        "Next    EPIC at 50,000 · 20,444 to go</pre>",
      ].join("\n"),
    );
  });

  it("drops the to-go part when the threshold is reached or missing, and lines with no data", () => {
    expect(
      rewardsWeekMessage("rewards_week_points", points({ nextTierPoints: "20000" }))?.body,
    ).toContain("EPIC at 20,000</pre>");
    expect(
      rewardsWeekMessage("rewards_week_points", points({ nextTierPoints: null }))?.body,
    ).not.toContain("Next");
    expect(
      rewardsWeekMessage("rewards_week_points", points({ totalPoints: null }))?.body,
    ).toContain("EPIC at 50,000</pre>");
    const bare = rewardsWeekMessage(
      "rewards_week_points",
      points({
        rank: null,
        rankPercentile: null,
        totalPoints: null,
        currentTier: null,
        nextTier: null,
      }),
    );
    expect(bare?.body).toBeNull();
    expect(rewardsWeekMessage("rewards_week_points", points({ points: null }))?.title).toBe(
      "🏆 <b>Week 13 SoPoints</b>",
    );
  });

  it("treats rank 0 (not ranked yet) as missing, never 'Rank 0'", () => {
    const m = rewardsWeekMessage(
      "rewards_week_points",
      points({ rank: "0", rankPercentile: null }),
    );
    expect(m?.body).not.toContain("Rank");
    expect(rewardsWeekMessage("rewards_week_points", points({ totalUser: "0" }))?.body).toContain(
      "Rank 1,410 · Top 0.06%",
    );
  });

  it("never contains a wallet address or squad fields, and escapes SoDEX strings", () => {
    const m = rewardsWeekMessage("rewards_week_points", points({ currentTier: "<b>X" }));
    expect(m?.body).toContain("&lt;b&gt;X");
    const text = JSON.stringify([m, rewardsWeekMessage("rewards_week_snapshot", snapshot())]);
    expect(text).not.toMatch(/0x[0-9a-fA-F]{40}|team|Bonus/);
  });
});

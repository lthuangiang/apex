import { describe, expect, it } from "vitest";

import {
  boostedOf,
  planWeekly,
  pointsData,
  POINTS_GIVE_UP_MS,
  POINTS_LEAD_MS,
  SNAPSHOT_GIVE_UP_MS,
  snapshotData,
  WEEKLY_POLL_MS,
  type WeekRow,
} from "../src/rewards-watch/weekly";

// #567: lịch tin tuần bám mốc SoDEX (trước / sau mốc, quá hạn), dữ liệu tin (null giữ null, 0 giữ "0").

const NOW = Date.parse("2026-12-01T13:00:00Z");
const S = (ms: number) => Math.floor(ms / 1000);
const H = 3_600_000;

function week(over: Partial<WeekRow> = {}): WeekRow {
  return {
    weekNo: 13,
    weekName: "Week 13",
    status: "COMPLETED",
    isLive: false,
    weekStartTime: S(NOW - 7 * 24 * H - H),
    weekEndTime: S(NOW - H),
    distributionTime: S(NOW + 3 * 24 * H),
    pointsStatus: "PENDING",
    ...over,
  };
}
const live: WeekRow = {
  weekNo: 14,
  weekName: "Week 14",
  status: "LIVE",
  isLive: true,
  weekStartTime: S(NOW - H),
  weekEndTime: S(NOW + 7 * 24 * H - H),
};
const none = { snapshotSent: null, pointsSent: null };

describe("planWeekly: snapshot", () => {
  it("sends after the week ends and is COMPLETED, once", () => {
    const p = planWeekly([week(), live], none, NOW);
    expect(p.snapshot?.weekNo).toBe(13);
    expect(p.snapshotSent).toBe(13);
    const again = planWeekly([week(), live], { snapshotSent: 13, pointsSent: null }, NOW);
    expect(again.snapshot).toBeNull();
  });

  it("does nothing before the week ends; next read at the end of the live week", () => {
    const p = planWeekly([live], none, NOW);
    expect(p.snapshot).toBeNull();
    expect(p.nextCheckMs).toBe(Math.min(live.weekEndTime * 1000, NOW + 6 * H));
  });

  it("polls every 10 minutes while not completed, gives up after 24 hours", () => {
    const p = planWeekly([week({ status: "SETTLING" }), live], none, NOW);
    expect(p.snapshot).toBeNull();
    expect(p.nextCheckMs).toBe(NOW + WEEKLY_POLL_MS);
    const late = NOW + SNAPSHOT_GIVE_UP_MS + 2 * H;
    const g = planWeekly([week({ status: "SETTLING" })], none, late);
    expect(g.snapshot).toBeNull();
    expect(g.snapshotSent).toBe(13);
  });

  it("a still-LIVE week is never a snapshot", () => {
    expect(planWeekly([week({ isLive: true })], none, NOW).snapshot).toBeNull();
  });
});

describe("planWeekly: points", () => {
  const dist = NOW + 2 * H;

  it("waits until 30 minutes before distributionTime", () => {
    const p = planWeekly(
      [week({ distributionTime: S(dist) })],
      { snapshotSent: 13, pointsSent: null },
      NOW,
    );
    expect(p.points).toBeNull();
    expect(p.nextCheckMs).toBe(dist - POINTS_LEAD_MS);
  });

  it("in the window: every 10 minutes until CONFIRMED, then sends once", () => {
    const at = dist - 10 * 60_000;
    const pending = planWeekly(
      [week({ distributionTime: S(dist) })],
      { snapshotSent: 13, pointsSent: null },
      at,
    );
    expect(pending.points).toBeNull();
    expect(pending.nextCheckMs).toBe(at + WEEKLY_POLL_MS);
    const ok = planWeekly(
      [week({ distributionTime: S(dist), pointsStatus: "CONFIRMED" })],
      { snapshotSent: 13, pointsSent: null },
      at,
    );
    expect(ok.points?.weekNo).toBe(13);
    expect(ok.pointsSent).toBe(13);
    expect(
      planWeekly(
        [week({ distributionTime: S(dist), pointsStatus: "CONFIRMED" })],
        { snapshotSent: 13, pointsSent: 13 },
        at,
      ).points,
    ).toBeNull();
  });

  it("gives up 6 hours after distributionTime without a message", () => {
    const at = dist + POINTS_GIVE_UP_MS + 60_000;
    const p = planWeekly(
      [week({ distributionTime: S(dist) })],
      { snapshotSent: 13, pointsSent: null },
      at,
    );
    expect(p.points).toBeNull();
    expect(p.pointsSent).toBe(13);
  });
});

describe("message data", () => {
  it("keeps missing fields null and a real 0 as '0', no squad fields", () => {
    const d = snapshotData(
      week({ spotVolume: 0, futuresVolume: "70722.87", oi: null, accountValue: undefined }),
      "Asia/Ho_Chi_Minh",
    );
    expect(d).toMatchObject({
      spotVolume: "0",
      futuresVolume: "70722.87",
      oi: null,
      accountValue: null,
    });
    expect(Object.keys(d).join(",")).not.toMatch(/team|Bonus/);
  });

  it("boosted: highest coefficient above 1, ties in API order, and how many more", () => {
    expect(
      boostedOf(
        week({
          futuresVolumeWeightDetails: [
            { symbol: "A", coefficient: "1" },
            { symbol: "B", coefficient: "1.2" },
            { symbol: "C", coefficient: 1.2 },
            { symbol: "D", coefficient: "1.05" },
          ],
        }),
      ),
    ).toEqual({ symbol: "B", coefficient: "1.2", more: 2 });
    expect(
      boostedOf(week({ futuresVolumeWeightDetails: [{ symbol: "A", coefficient: "1" }] })),
    ).toBeNull();
    expect(boostedOf(week({ futuresVolumeWeightDetails: null }))).toBeNull();
  });

  it("points data: summary missing keeps totals null", () => {
    expect(pointsData(week({ points: 521 }), null, "UTC")).toMatchObject({
      points: "521",
      totalPoints: null,
      currentTier: null,
    });
  });
});

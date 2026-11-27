import { describe, expect, it } from "vitest";

import { backoffMs, MAX_BACKOFF_MS, nextCheckAt } from "../src/rewards-watch/classify";
import { parseRewardsWatchInterval } from "../src/rewards-watch/interval";
import { planWeekly, WEEKLY_IDLE_MS, WEEKLY_POLL_MS } from "../src/rewards-watch/weekly";

// #558: chu kỳ báo box mới xuống 1–2 phút (biên dưới 1, mặc định 15, trần 60).

describe("parseRewardsWatchInterval", () => {
  it("accepts 1, 2 and 60 minutes", () => {
    expect(parseRewardsWatchInterval("1")).toEqual({ minutes: 1, invalid: null });
    expect(parseRewardsWatchInterval("2")).toEqual({ minutes: 2, invalid: null });
    expect(parseRewardsWatchInterval(" 60 ")).toEqual({ minutes: 60, invalid: null });
  });

  it("uses 15 without a warning when unset or empty", () => {
    expect(parseRewardsWatchInterval(undefined)).toEqual({ minutes: 15, invalid: null });
    expect(parseRewardsWatchInterval("")).toEqual({ minutes: 15, invalid: null });
  });

  it.each(["0", "61", "abc", "1.5", "-2"])("falls back to 15 and flags %j", (raw) => {
    expect(parseRewardsWatchInterval(raw)).toEqual({ minutes: 15, invalid: { received: raw } });
  });

  it("truncates a long invalid value", () => {
    const r = parseRewardsWatchInterval("x".repeat(100));
    expect(r.minutes).toBe(15);
    expect(r.invalid?.received).toHaveLength(32);
  });
});

describe("short intervals (1 and 2 minutes)", () => {
  const now = new Date("2026-11-27T08:00:00Z");

  it.each([1, 2])("nextCheckAt stays within ±10%% of %i minute(s)", (min) => {
    const interval = min * 60_000;
    for (const user of ["a", "b", "c", "d", "e"]) {
      const at = nextCheckAt(now, interval, user).getTime() - now.getTime();
      expect(at).toBeGreaterThanOrEqual(interval * 0.9);
      expect(at).toBeLessThanOrEqual(interval * 1.1);
    }
  });

  it.each([1, 2])("backoff is never shorter than the %i-minute cycle and still caps at 6 h", (min) => {
    const interval = min * 60_000;
    expect(backoffMs(interval, 1)).toBe(2 * interval);
    for (let e = 1; e <= 30; e += 1) {
      expect(backoffMs(interval, e)).toBeGreaterThan(interval);
      expect(backoffMs(interval, e)).toBeLessThanOrEqual(MAX_BACKOFF_MS);
    }
    expect(backoffMs(interval, 30)).toBe(MAX_BACKOFF_MS);
  });

  it("weekly schedule does not depend on the box interval (idle 6 h, 10 min while waiting)", () => {
    const nowMs = now.getTime();
    const week = (no: number, endMs: number, extra: Record<string, unknown> = {}) => ({
      weekNo: no,
      weekName: `Week ${String(no)}`,
      weekStartTime: (endMs - 7 * 24 * 3600_000) / 1000,
      weekEndTime: endMs / 1000,
      ...extra,
    });
    // Tuần trước đã gửi đủ, tuần đang chạy còn xa: đọc lại sau 6 giờ.
    const idle = planWeekly(
      [week(9, nowMs - 3 * 24 * 3600_000), week(10, nowMs + 3 * 24 * 3600_000, { isLive: true })],
      { snapshotSent: 9, pointsSent: 9 },
      nowMs,
    );
    expect(idle.nextCheckMs).toBe(nowMs + WEEKLY_IDLE_MS);
    // Tuần vừa kết thúc, chưa COMPLETED: đọc lại sau 10 phút (không theo chu kỳ 1–2 phút).
    const waiting = planWeekly(
      [week(9, nowMs - 60_000, { status: "PENDING" })],
      { snapshotSent: 8, pointsSent: 9 },
      nowMs,
    );
    expect(waiting.nextCheckMs).toBe(nowMs + WEEKLY_POLL_MS);
  });
});

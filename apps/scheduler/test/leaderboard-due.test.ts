import { describe, expect, it } from "vitest";

import { LEADERBOARD_STALE_MS, leaderboardDue } from "../src/leaderboard";

// Khi nào bắt đầu (hoặc chạy lại) lượt leaderboard trong ngày (sửa review Copy Trading: lượt kẹt "running" 8 giờ).

const NOW = Date.parse("2026-11-12T03:00:00Z");
const ago = (ms: number) => new Date(NOW - ms);

describe("leaderboardDue", () => {
  it("runs when today has no run yet", () => {
    expect(leaderboardDue(undefined, NOW)).toBe(true);
  });

  it("never reruns a good run", () => {
    expect(leaderboardDue({ status: "ok", updatedAt: ago(10 * 3_600_000) }, NOW)).toBe(false);
  });

  it("leaves a running run alone while its heartbeat is fresh", () => {
    expect(leaderboardDue({ status: "running", updatedAt: ago(60_000) }, NOW)).toBe(false);
    expect(
      leaderboardDue({ status: "running", updatedAt: ago(LEADERBOARD_STALE_MS - 1) }, NOW),
    ).toBe(false);
  });

  it("restarts a running run whose process died (no heartbeat for 20 minutes)", () => {
    expect(leaderboardDue({ status: "running", updatedAt: ago(LEADERBOARD_STALE_MS) }, NOW)).toBe(
      true,
    );
  });

  it("retries a failed run only after an hour", () => {
    expect(leaderboardDue({ status: "failed", updatedAt: ago(30 * 60_000) }, NOW)).toBe(false);
    expect(leaderboardDue({ status: "failed", updatedAt: ago(3_600_000) }, NOW)).toBe(true);
  });
});

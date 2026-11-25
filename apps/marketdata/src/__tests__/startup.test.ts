import { describe, expect, it, vi } from "vitest";

import { backfillSymbols, startLeaderFeedsThenBackfill, type CancelFlag } from "../startup";

// #531: prod 2026-11-24 09:02 UTC, backfill nến chạy hơn 10 giờ và mọi thứ sau nó (Copy Trading SoDEX, ví Hyperliquid)
// không bao giờ được bật.

function deps(
  backfill: (flag: CancelFlag) => Promise<{ symbols: number; failed: number; cancelled: boolean }>,
) {
  const calls: string[] = [];
  const info = vi.fn();
  const warn = vi.fn();
  return {
    calls,
    info,
    warn,
    steps: {
      // Cùng các việc `startLeaderFeeds` của main.ts gọi.
      startLeaderFeeds: () => {
        calls.push(
          "allocator.refresh",
          "leaders.sync",
          "hlLeaders.sync",
          "hlLeaders.poll",
          "hlLeaders.flush",
        );
      },
      backfill,
      now: () => 1_000,
      info,
      warn,
    },
  };
}

describe("marketdata start order (#531)", () => {
  it("starts every leader feed even when the kline backfill never finishes", async () => {
    // getKlines treo mãi: backfill không bao giờ xong.
    const never = new Promise<never>(() => undefined);
    const d = deps(() => never);
    const cancel = startLeaderFeedsThenBackfill(d.steps);
    await Promise.resolve();
    expect(d.calls).toEqual([
      "allocator.refresh",
      "leaders.sync",
      "hlLeaders.sync",
      "hlLeaders.poll",
      "hlLeaders.flush",
    ]);
    // Không có dòng "xong" khi backfill còn chạy.
    expect(d.info).not.toHaveBeenCalled();
    cancel();
  });

  it("stops the backfill at the next symbol when cancelled, and logs it", async () => {
    const read = vi.fn<(symbol: string) => Promise<void>>(() => Promise.resolve());
    let flagSeen: CancelFlag | null = null;
    const d = deps(async (flag) => {
      flagSeen = flag;
      return backfillSymbols(
        ["A", "B", "C"],
        flag,
        async (s) => {
          await read(s);
          // `stop()` tới trong lúc đọc symbol đầu tiên.
          if (s === "A") cancel();
        },
        () => undefined,
      );
    });
    const cancel = startLeaderFeedsThenBackfill(d.steps);
    await vi.waitFor(() => {
      expect(d.info).toHaveBeenCalled();
    });
    expect(flagSeen).not.toBeNull();
    expect(read.mock.calls.map((c) => c[0])).toEqual(["A"]);
    expect(d.info).toHaveBeenCalledWith(
      { ms: 0, symbols: 1, failed: 0 },
      "marketdata backfill cancelled",
    );
  });

  it("counts failed symbols, keeps going, and logs the total when done", async () => {
    const errors: string[] = [];
    const d = deps((flag) =>
      backfillSymbols(
        ["A", "B", "C"],
        flag,
        (s) =>
          s === "B" ? Promise.reject(new Error("SoDEX rate limit reached")) : Promise.resolve(),
        (s) => {
          errors.push(s);
        },
      ),
    );
    startLeaderFeedsThenBackfill(d.steps);
    await vi.waitFor(() => {
      expect(d.info).toHaveBeenCalled();
    });
    expect(errors).toEqual(["B"]);
    expect(d.info).toHaveBeenCalledWith(
      { ms: 0, symbols: 3, failed: 1 },
      "marketdata backfill done",
    );
  });

  it("logs a backfill that throws instead of leaving an unhandled rejection", async () => {
    const d = deps(() => Promise.reject(new Error("boom")));
    startLeaderFeedsThenBackfill(d.steps);
    await vi.waitFor(() => {
      expect(d.warn).toHaveBeenCalled();
    });
    expect(d.warn.mock.calls[0]?.[1]).toBe("marketdata backfill stopped");
    expect(d.calls).toHaveLength(5);
  });
});

// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { RewardsError, rewardsRequest, resetRewardsRateLimit } from "../client";
import {
  REWARDS_JOB_POLL_MS,
  firstRewardsError,
  rewardsKeys,
  useRewardsActiveJobs,
  useRewardsBoxes,
  useRewardsFeed,
  useRewardsPause,
  useRewardsSummary,
  useRewardsTreasures,
  useRewardsVolumeWeights,
  useRewardsWeekInfo,
  useRewardsWeekList,
  type RewardsSession,
} from "../queries";

import { FAKE_TOKEN, MASTER, fakeGateway } from "./gateway-fixtures";

// Hook dữ liệu dùng chung của SoDEX rewards (#548; #549 dùng treasures / boxes / activeJobs). Gateway giả; `authed` giả
// gắn chuỗi token giả như `useRewardsAuth`.

let gw: ReturnType<typeof fakeGateway>;

function session(signedIn = true): RewardsSession {
  return {
    master: MASTER,
    signedIn,
    authed: (req) => rewardsRequest({ ...req, token: FAKE_TOKEN }),
  };
}

function wrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

beforeEach(() => {
  gw = fakeGateway();
  vi.stubGlobal("fetch", gw.fn);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  resetRewardsRateLimit();
});

describe("public rewards hooks", () => {
  it("read week/info, volume-weights and lottery/feed without a token", async () => {
    const w = wrapper();
    const week = renderHook(() => useRewardsWeekInfo(), { wrapper: w });
    const weights = renderHook(() => useRewardsVolumeWeights(), { wrapper: w });
    const feed = renderHook(() => useRewardsFeed(), { wrapper: w });
    await waitFor(() => {
      expect(week.result.current.data?.weekName).toBe("Week 13");
    });
    await waitFor(() => {
      expect(weights.result.current.data?.weights).toHaveLength(6);
    });
    await waitFor(() => {
      expect(feed.result.current.data?.items).toHaveLength(2);
    });
    expect(gw.calls.map((c) => c.path).sort()).toEqual([
      "lottery/feed",
      "sopoints/volume-weights",
      "sopoints/week/info",
    ]);
    expect(gw.calls.every((c) => c.auth === null)).toBe(true);
  });

  it("disabled hooks read nothing", () => {
    renderHook(() => useRewardsFeed(false), { wrapper: wrapper() });
    expect(gw.fn).not.toHaveBeenCalled();
  });
});

describe("wallet rewards hooks", () => {
  it("summary, week list, treasures, boxes and active jobs send the token to the gateway only", async () => {
    const w = wrapper();
    const s = session();
    const hooks = [
      renderHook(() => useRewardsSummary(s), { wrapper: w }),
      renderHook(() => useRewardsWeekList(s), { wrapper: w }),
      renderHook(() => useRewardsTreasures(s), { wrapper: w }),
      renderHook(() => useRewardsBoxes(s), { wrapper: w }),
      renderHook(() => useRewardsActiveJobs(s), { wrapper: w }),
    ];
    for (const h of hooks)
      await waitFor(() => {
        expect(h.result.current.isSuccess).toBe(true);
      });
    expect([...new Set(gw.calls.map((c) => c.path))].sort()).toEqual([
      "lottery/boxes",
      "lottery/jobs",
      "lottery/treasures",
      "sopoints/summary",
      "sopoints/week/list",
    ]);
    expect(gw.calls.every((c) => c.auth === `Bearer ${FAKE_TOKEN}`)).toBe(true);
    expect(gw.calls.find((c) => c.path === "lottery/jobs")?.url).toContain("active=true");
    expect(hooks[2]?.result.current.data).toMatchObject({ total: 3 });
    expect(hooks[3]?.result.current.data).toMatchObject({ total: 27 });
  });

  it("are idle while not signed in", () => {
    const w = wrapper();
    const s = session(false);
    renderHook(() => useRewardsSummary(s), { wrapper: w });
    renderHook(() => useRewardsTreasures(s), { wrapper: w });
    renderHook(() => useRewardsActiveJobs(s), { wrapper: w });
    expect(gw.fn).not.toHaveBeenCalled();
  });

  it("keys wallet data by the lower-cased master wallet", () => {
    expect(rewardsKeys.summary(MASTER.toUpperCase().replace("0X", "0x"))).toEqual(
      rewardsKeys.summary(MASTER),
    );
  });

  it("active jobs poll every 2 s while a job runs", async () => {
    gw = fakeGateway({
      "lottery/jobs": {
        body: { code: 0, data: { jobs: [{ jobId: 88231, kind: "box_open", status: "pending" }] } },
      },
    });
    vi.stubGlobal("fetch", gw.fn);
    renderHook(() => useRewardsActiveJobs(session()), { wrapper: wrapper() });
    await waitFor(() => {
      expect(gw.calls.filter((c) => c.path === "lottery/jobs")).toHaveLength(1);
    });
    await waitFor(
      () => {
        expect(gw.calls.filter((c) => c.path === "lottery/jobs").length).toBeGreaterThanOrEqual(2);
      },
      { timeout: REWARDS_JOB_POLL_MS + 1_500 },
    );
  });

  it("schema drift surfaces as a RewardsError, not as made-up numbers", async () => {
    gw = fakeGateway({ "lottery/treasures": { body: { code: 0, data: { total: "many" } } } });
    vi.stubGlobal("fetch", gw.fn);
    const h = renderHook(() => useRewardsTreasures(session()), { wrapper: wrapper() });
    await waitFor(() => {
      expect(h.result.current.isError).toBe(true);
    });
    expect(h.result.current.data).toBeUndefined();
    expect((h.result.current.error as RewardsError).kind).toBe("schema");
  });
});

describe("useRewardsPause", () => {
  it("counts down from retryAfter and ends", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    const h = renderHook(() => useRewardsPause());
    expect(h.result.current).toEqual({ active: false, seconds: null });
    await act(async () => {
      await rewardsRequest({
        path: "lottery/feed",
        schema: z.unknown(),
        fetchImpl: () =>
          Promise.resolve(
            new Response(JSON.stringify({ code: 429, data: { retryAfter: 2 } }), { status: 429 }),
          ),
      }).catch(() => undefined);
    });
    expect(h.result.current).toEqual({ active: true, seconds: 2 });
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(h.result.current).toEqual({ active: true, seconds: 1 });
    act(() => {
      vi.advanceTimersByTime(1_100);
    });
    expect(h.result.current.active).toBe(false);
  });

  it("without retryAfter: paused, no number", async () => {
    const h = renderHook(() => useRewardsPause());
    await act(async () => {
      await rewardsRequest({
        path: "lottery/feed",
        schema: z.unknown(),
        fetchImpl: () =>
          Promise.resolve(new Response(JSON.stringify({ code: 429 }), { status: 429 })),
      }).catch(() => undefined);
    });
    expect(h.result.current).toEqual({ active: true, seconds: null });
  });
});

describe("firstRewardsError", () => {
  it("returns the first error in order, normalised", () => {
    const biz = new RewardsError("business", 200, "nope");
    expect(firstRewardsError(null, undefined, biz, new Error("x"))).toBe(biz);
    expect(firstRewardsError(null, new Error("x"))?.kind).toBe("network");
    expect(firstRewardsError(null, undefined)).toBeNull();
  });
});

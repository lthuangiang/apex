"use client";

import {
  lotteryBoxesSchema,
  lotteryFeedSchema,
  lotteryJobsSchema,
  lotteryTreasuresSchema,
  sopointsSummarySchema,
  sopointsVolumeWeightsSchema,
  sopointsWeekInfoSchema,
  sopointsWeekListSchema,
} from "@drift/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";

import {
  RewardsError,
  rewardsPauseKnown,
  rewardsPausedUntil,
  rewardsRequest,
  subscribeRewardsPause,
} from "./client";
import type { useRewardsAuth } from "./use-rewards-auth";

// Hook dữ liệu SoDEX rewards dùng chung cho trang /rewards (#548) và thẻ Overview (#549). Trình duyệt gọi thẳng gateway
// SoDEX (DEC-397); endpoint cần ví đi qua `authed` của `useRewardsAuth` (401 → xoá token, báo hết hạn). Không retry tự
// động; làm mới 60 s khi trang đang hiện, job đang chạy thì 2 s (README bản phác, mục Rate limit). Trong lúc SoDEX bắt
// dừng (429) thì không hẹn làm mới. Chỉ đọc: không có hook nào gửi claim / open / merge.

export const REWARDS_KEY = ["rewards"] as const;

export const rewardsKeys = {
  weekInfo: [...REWARDS_KEY, "public", "week-info"] as const,
  volumeWeights: [...REWARDS_KEY, "public", "volume-weights"] as const,
  feed: [...REWARDS_KEY, "public", "feed"] as const,
  /** Dữ liệu theo ví: khoá theo master wallet để đổi tài khoản không lẫn cache. */
  wallet: (address: string) => [...REWARDS_KEY, "wallet", address.toLowerCase()] as const,
  summary: (address: string) => [...rewardsKeys.wallet(address), "summary"] as const,
  weekList: (address: string) => [...rewardsKeys.wallet(address), "week-list"] as const,
  treasures: (address: string) => [...rewardsKeys.wallet(address), "treasures"] as const,
  boxes: (address: string) => [...rewardsKeys.wallet(address), "boxes"] as const,
  activeJobs: (address: string) => [...rewardsKeys.wallet(address), "jobs-active"] as const,
};

export const REWARDS_REFRESH_MS = 60_000;
export const REWARDS_JOB_POLL_MS = 2_000;

/** Phần của `useRewardsAuth` mà hook dữ liệu cần (token không bao giờ ra khỏi hook đó). */
export type RewardsSession = Pick<
  ReturnType<typeof useRewardsAuth>,
  "master" | "signedIn" | "authed"
>;

function paused(now = Date.now()): boolean {
  const until = rewardsPausedUntil();
  return until !== null && now < until;
}

/** Hẹn làm mới; trả `false` khi đang dừng do 429. */
function every(ms: number): () => number | false {
  return () => (paused() ? false : ms);
}

const COMMON = {
  retry: false,
  staleTime: 30_000,
  refetchOnWindowFocus: false,
  refetchIntervalInBackground: false,
} as const;

// Công khai (không cần ví).

export function useRewardsWeekInfo(enabled = true) {
  return useQuery({
    ...COMMON,
    queryKey: rewardsKeys.weekInfo,
    queryFn: ({ signal }) =>
      rewardsRequest({ path: "sopoints/week/info", schema: sopointsWeekInfoSchema, signal }),
    refetchInterval: every(REWARDS_REFRESH_MS),
    enabled,
  });
}

export function useRewardsVolumeWeights(enabled = true) {
  return useQuery({
    ...COMMON,
    queryKey: rewardsKeys.volumeWeights,
    queryFn: ({ signal }) =>
      rewardsRequest({
        path: "sopoints/volume-weights",
        schema: sopointsVolumeWeightsSchema,
        signal,
      }),
    refetchInterval: every(REWARDS_REFRESH_MS),
    enabled,
  });
}

export function useRewardsFeed(enabled = true) {
  return useQuery({
    ...COMMON,
    queryKey: rewardsKeys.feed,
    queryFn: ({ signal }) =>
      rewardsRequest({ path: "lottery/feed", schema: lotteryFeedSchema, signal }),
    refetchInterval: every(REWARDS_REFRESH_MS),
    enabled,
  });
}

// Cần ví (JWT trong sessionStorage của tab, DEC-397).

function walletQuery(s: RewardsSession) {
  return { address: s.master ?? "", enabled: s.signedIn && s.master !== null };
}

export function useRewardsSummary(s: RewardsSession) {
  const { address, enabled } = walletQuery(s);
  return useQuery({
    ...COMMON,
    queryKey: rewardsKeys.summary(address),
    queryFn: ({ signal }) =>
      s.authed({ path: "sopoints/summary", schema: sopointsSummarySchema, signal }),
    refetchInterval: every(REWARDS_REFRESH_MS),
    enabled,
  });
}

export function useRewardsWeekList(s: RewardsSession) {
  const { address, enabled } = walletQuery(s);
  return useQuery({
    ...COMMON,
    queryKey: rewardsKeys.weekList(address),
    queryFn: ({ signal }) =>
      s.authed({ path: "sopoints/week/list", schema: sopointsWeekListSchema, signal }),
    refetchInterval: every(REWARDS_REFRESH_MS),
    enabled,
  });
}

/** Blind Box chờ claim (`total`). */
export function useRewardsTreasures(s: RewardsSession) {
  const { address, enabled } = walletQuery(s);
  return useQuery({
    ...COMMON,
    queryKey: rewardsKeys.treasures(address),
    queryFn: ({ signal }) =>
      s.authed({ path: "lottery/treasures", schema: lotteryTreasuresSchema, signal }),
    refetchInterval: every(REWARDS_REFRESH_MS),
    enabled,
  });
}

/** Box trong backpack (`total`, `byLevel`, `boxes`). */
export function useRewardsBoxes(s: RewardsSession) {
  const { address, enabled } = walletQuery(s);
  return useQuery({
    ...COMMON,
    queryKey: rewardsKeys.boxes(address),
    queryFn: ({ signal }) =>
      s.authed({ path: "lottery/boxes", schema: lotteryBoxesSchema, signal }),
    refetchInterval: every(REWARDS_REFRESH_MS),
    enabled,
  });
}

/** Job chưa xong của ví (`jobs?active=true`), chỉ đọc. Có job thì đọc lại 2 s, không có thì 60 s. */
export function useRewardsActiveJobs(s: RewardsSession) {
  const { address, enabled } = walletQuery(s);
  return useQuery({
    ...COMMON,
    staleTime: 0,
    queryKey: rewardsKeys.activeJobs(address),
    queryFn: ({ signal }) =>
      s.authed({
        path: "lottery/jobs",
        query: { active: true },
        schema: lotteryJobsSchema,
        signal,
      }),
    refetchInterval: (q) =>
      paused()
        ? false
        : (q.state.data?.jobs.length ?? 0) > 0
          ? REWARDS_JOB_POLL_MS
          : REWARDS_REFRESH_MS,
    enabled,
  });
}

/** Đọc lại mọi dữ liệu rewards (nút "Try again"). */
export function useRewardsRetry(): () => void {
  const qc = useQueryClient();
  return useCallback(() => {
    void qc.invalidateQueries({ queryKey: REWARDS_KEY });
  }, [qc]);
}

export interface RewardsPause {
  /** SoDEX đang bắt dừng (429). */
  active: boolean;
  /** Số giây còn lại để đếm ngược; null khi SoDEX không trả `retryAfter` (dừng 60 s nhưng không hiện số). */
  seconds: number | null;
}

/** Trạng thái dừng do 429, đếm ngược mỗi giây; hết hạn thì tự trở về `active: false`. */
export function useRewardsPause(): RewardsPause {
  const until = useSyncExternalStore(subscribeRewardsPause, rewardsPausedUntil, () => null);
  const [now, setNow] = useState(() => Date.now());
  const active = until !== null && now < until;
  useEffect(() => {
    if (until === null) return;
    setNow(Date.now());
    const id = setInterval(() => {
      const t = Date.now();
      setNow(t);
      if (t >= until) clearInterval(id);
    }, 1_000);
    return () => {
      clearInterval(id);
    };
  }, [until]);
  return {
    active,
    seconds: active && rewardsPauseKnown() ? Math.max(1, Math.ceil((until - now) / 1000)) : null,
  };
}

/** Lỗi đầu tiên (theo thứ tự truyền vào) của các query rewards, đã chuẩn hoá về `RewardsError`. */
export function firstRewardsError(
  ...errors: readonly (Error | null | undefined)[]
): RewardsError | null {
  for (const e of errors) {
    if (e === null || e === undefined) continue;
    return e instanceof RewardsError ? e : new RewardsError("network", 0);
  }
  return null;
}

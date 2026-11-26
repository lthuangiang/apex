"use client";

import {
  cybereatorProfileSchema,
  lotteryBoxesSchema,
  lotteryDrawEntriesSchema,
  lotteryFeedSchema,
  lotteryHistorySchema,
  lotteryJobSchema,
  lotteryJobsSchema,
  lotteryLedgerSchema,
  lotteryPfpsSchema,
  lotteryTreasuresSchema,
  sopointsSummarySchema,
  sopointsVolumeWeightsSchema,
  sopointsWeekInfoSchema,
  sopointsWeekListSchema,
} from "@drift/shared";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
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
  pfps: (address: string) => [...rewardsKeys.wallet(address), "pfps"] as const,
  ledger: (address: string) => [...rewardsKeys.wallet(address), "ledger"] as const,
  history: (address: string) => [...rewardsKeys.wallet(address), "history"] as const,
  draw: (address: string) => [...rewardsKeys.wallet(address), "draw-entries"] as const,
  job: (address: string, id: number) => [...rewardsKeys.wallet(address), "job", id] as const,
  profile: (id: number) => [...REWARDS_KEY, "public", "cybereator", id] as const,
};

/** `lottery/boxes`: tối đa 200 box mỗi trang (README bản phác, câu hỏi 8). */
export const BOXES_PAGE = 200;
/** Chặn trên số trang đọc liên tiếp, phòng gateway bỏ qua `offset`. */
const BOXES_MAX_PAGES = 25;
/** `lottery/ledger`: 100 dòng mỗi trang (dữ liệu thật). */
export const LEDGER_PAGE = 100;

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

/**
 * Box trong backpack (`total`, `byLevel`, `boxes`). Đọc hết các trang (`limit` 200 / `offset`) tới khi đủ `total`; trang
 * không có box mới (gateway bỏ qua `offset`) hoặc thiếu box thì dừng, không đọc lặp.
 */
export function useRewardsBoxes(s: RewardsSession) {
  const { address, enabled } = walletQuery(s);
  return useQuery({
    ...COMMON,
    queryKey: rewardsKeys.boxes(address),
    queryFn: async ({ signal }) => {
      const first = await s.authed({
        path: "lottery/boxes",
        query: { limit: BOXES_PAGE, offset: 0 },
        schema: lotteryBoxesSchema,
        signal,
      });
      const boxes = [...first.boxes];
      const seen = new Set(boxes.map((b) => b.tokenId));
      for (let page = 1; page < BOXES_MAX_PAGES && boxes.length < first.total; page++) {
        const next = await s.authed({
          path: "lottery/boxes",
          query: { limit: BOXES_PAGE, offset: boxes.length },
          schema: lotteryBoxesSchema,
          signal,
        });
        const fresh = next.boxes.filter((b) => !seen.has(b.tokenId));
        if (fresh.length === 0) break;
        for (const b of fresh) {
          seen.add(b.tokenId);
          boxes.push(b);
        }
      }
      return { ...first, boxes };
    },
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

/** PFP của ví (`lottery/pfps`); hình dạng phần tử còn chưa có mẫu thật. */
export function useRewardsPfps(s: RewardsSession) {
  const { address, enabled } = walletQuery(s);
  return useQuery({
    ...COMMON,
    queryKey: rewardsKeys.pfps(address),
    queryFn: ({ signal }) => s.authed({ path: "lottery/pfps", schema: lotteryPfpsSchema, signal }),
    refetchInterval: every(REWARDS_REFRESH_MS),
    enabled,
  });
}

/** Tổng phần thưởng đã mở (`lottery/history`). */
export function useRewardsHistory(s: RewardsSession) {
  const { address, enabled } = walletQuery(s);
  return useQuery({
    ...COMMON,
    queryKey: rewardsKeys.history(address),
    queryFn: ({ signal }) =>
      s.authed({ path: "lottery/history", schema: lotteryHistorySchema, signal }),
    refetchInterval: every(REWARDS_REFRESH_MS),
    enabled,
  });
}

/** Sổ box (`lottery/ledger`), 100 dòng / trang theo `limit` / `offset`; trang sau đọc khi bấm "Load more". */
export function useRewardsLedger(s: RewardsSession) {
  const { address, enabled } = walletQuery(s);
  return useInfiniteQuery({
    ...COMMON,
    queryKey: rewardsKeys.ledger(address),
    initialPageParam: 0,
    queryFn: ({ signal, pageParam }) =>
      s.authed({
        path: "lottery/ledger",
        query: { limit: LEDGER_PAGE, offset: pageParam },
        schema: lotteryLedgerSchema,
        signal,
      }),
    getNextPageParam: (last, pages, lastParam) => {
      const loaded = pages.reduce((n, p) => n + p.items.length, 0);
      return last.items.length === 0 || loaded >= last.total ? undefined : lastParam + LEDGER_PAGE;
    },
    enabled,
  });
}

/** Weekly draw của ví (`lottery/draw/entries`). */
export function useRewardsDrawEntries(s: RewardsSession) {
  const { address, enabled } = walletQuery(s);
  return useQuery({
    ...COMMON,
    queryKey: rewardsKeys.draw(address),
    queryFn: ({ signal }) =>
      s.authed({ path: "lottery/draw/entries", schema: lotteryDrawEntriesSchema, signal }),
    refetchInterval: every(REWARDS_REFRESH_MS),
    enabled,
  });
}

/** Hồ sơ Cybereator (công khai, không envelope): trạng thái mở của PFP. */
export function useCybereatorProfile(id: number) {
  return useQuery({
    ...COMMON,
    staleTime: 5 * 60_000,
    queryKey: rewardsKeys.profile(id),
    queryFn: ({ signal }) =>
      rewardsRequest({
        path: `cybereator/profile/${String(id)}`,
        envelope: false,
        schema: cybereatorProfileSchema,
        signal,
      }),
  });
}

/**
 * Một job (`lottery/job/{id}`, quy tắc 6): đọc lại 2 s khi submitting / pending, dừng khi revealed / failed hoặc khi
 * SoDEX bắt dừng (429).
 */
export function useRewardsJob(s: RewardsSession, id: number | null) {
  const { address, enabled } = walletQuery(s);
  return useQuery({
    ...COMMON,
    staleTime: 0,
    queryKey: rewardsKeys.job(address, id ?? -1),
    queryFn: ({ signal }) =>
      s.authed({ path: `lottery/job/${String(id)}`, schema: lotteryJobSchema, signal }),
    refetchInterval: (q) =>
      paused()
        ? false
        : q.state.data === undefined ||
            q.state.data.status === "submitting" ||
            q.state.data.status === "pending"
          ? REWARDS_JOB_POLL_MS
          : false,
    enabled: enabled && id !== null,
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

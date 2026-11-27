"use client";

import { rewardsWatchStateSchema, type RewardsWatchState } from "@drift/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";

import { api, ApiError } from "@/lib/api";

import { readRewardsToken } from "./token-store";

// Báo box mới SoDEX rewards phía server (#558, DEC-398). Trạng thái công tắc luôn lấy từ backend (quy tắc 6):
// `GET /api/v1/rewards/watch`. Api trả 404 khi `REWARDS_WATCH_ENABLED` tắt: web coi như tính năng chưa có và giữ hành
// vi cũ (không hiện khối đồng ý, token chỉ ở trình duyệt). Token chỉ rời trình duyệt tới DeskLabs đúng một chỗ:
// `POST /api/v1/rewards/watch` khi người dùng để công tắc bật (DEC-398). Không log, không analytics.

export const REWARDS_WATCH_KEY = ["rewards", "watch"] as const;

/** null = tính năng tắt ở server (404). */
export type RewardsWatchQuery = RewardsWatchState | null;

export function useRewardsWatch(enabled = true) {
  return useQuery({
    queryKey: REWARDS_WATCH_KEY,
    queryFn: async (): Promise<RewardsWatchQuery> => {
      try {
        return await api("GET", "/api/v1/rewards/watch", rewardsWatchStateSchema);
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) return null;
        throw e;
      }
    },
    staleTime: 30_000,
    enabled,
  });
}

/**
 * Bật: gửi JWT đang có trong tab (một lần) để server lưu. Không có token trong tab thì báo `no_token` (người dùng ký lại).
 */
export function useEnableRewardsWatch(master: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (): Promise<RewardsWatchState> => {
      const token = readRewardsToken(master);
      if (master === null || token === null)
        throw new ApiError("UNAUTHENTICATED", 0, { reason: "no_token" });
      return api("POST", "/api/v1/rewards/watch", rewardsWatchStateSchema, {
        idempotencyKey: crypto.randomUUID(),
        body: { token, address: master },
      });
    },
    onSuccess: (state) => {
      qc.setQueryData(REWARDS_WATCH_KEY, state);
    },
    onSettled: async () => {
      await qc.invalidateQueries({ queryKey: REWARDS_WATCH_KEY });
    },
  });
}

/** Tắt: xoá phiên rewards lưu ở server. Trạng thái chỉ đổi khi backend xác nhận. */
export function useDisableRewardsWatch() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api("DELETE", "/api/v1/rewards/watch", z.unknown(), {
        idempotencyKey: crypto.randomUUID(),
      }),
    onSettled: async () => {
      await qc.invalidateQueries({ queryKey: REWARDS_WATCH_KEY });
    },
  });
}

/** Lỗi bật: sai ví (token của ví khác) hay lỗi chung (chưa lưu gì). */
/**
 * #582: 8 ký tự đầu của `traceId` (UUID ngẫu nhiên của request, không lộ gì) để người dùng gửi team đối chiếu với log api.
 * null khi lỗi không đến từ api (mạng, chưa ký).
 */
export function enableErrorRef(e: unknown): string | null {
  if (!(e instanceof ApiError)) return null;
  const id: unknown = e.traceId;
  return typeof id === "string" && id !== "" ? id.slice(0, 8) : null;
}

export function enableErrorKind(e: unknown): "wallet" | "no_token" | "failed" {
  if (e instanceof ApiError) {
    if (e.code === "REWARDS_WALLET_MISMATCH") return "wallet";
    if (e.details.reason === "no_token") return "no_token";
  }
  return "failed";
}

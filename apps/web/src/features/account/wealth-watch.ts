"use client";

import { wealthWatchStateSchema, type WealthWatchState } from "@drift/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";

import { api, ApiError } from "@/lib/api";

// Công tắc "Alerts" của SoDEX Wealth (#594, DEC-404 mục 7). Trạng thái luôn lấy từ backend (quy tắc 6):
// `GET /api/v1/wealth/watch`. Api trả 404 khi user không dùng được (US Market tắt, hoặc `WEALTH_WATCH_ENABLED` tắt và
// không phải team): web coi như không có (không render). Bật / tắt chỉ cho chính user đang đăng nhập.

export const WEALTH_WATCH_KEY = ["wealth", "watch"] as const;

/** null = không dùng được (404). */
export type WealthWatchQuery = WealthWatchState | null;

export function useWealthWatch(enabled: boolean) {
  return useQuery({
    queryKey: WEALTH_WATCH_KEY,
    queryFn: async (): Promise<WealthWatchQuery> => {
      try {
        return await api("GET", "/api/v1/wealth/watch", wealthWatchStateSchema);
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) return null;
        throw e;
      }
    },
    staleTime: 30_000,
    enabled,
  });
}

/** Bật / tắt. Công tắc chỉ đổi khi backend trả lời (đọc lại `GET` sau mỗi lần). */
export function useSetWealthWatch() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (on: boolean): Promise<WealthWatchQuery> => {
      if (on)
        return api("POST", "/api/v1/wealth/watch", wealthWatchStateSchema, {
          idempotencyKey: crypto.randomUUID(),
        });
      await api("DELETE", "/api/v1/wealth/watch", z.unknown(), {
        idempotencyKey: crypto.randomUUID(),
      });
      return { status: "off", lastCheckedAt: null, delayed: false };
    },
    onSuccess: (state) => {
      qc.setQueryData(WEALTH_WATCH_KEY, state);
    },
    onSettled: async () => {
      await qc.invalidateQueries({ queryKey: WEALTH_WATCH_KEY });
    },
  });
}

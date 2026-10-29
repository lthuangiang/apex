"use client";

import { watchlistSchema, type WatchlistEntry } from "@drift/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "./api";

// Watchlist của Overview (UI_REVIEW M2, DEC-74). PUT thay toàn bộ danh sách; lưu xong làm mới Overview.

export const WATCHLIST_KEY = ["watchlist"] as const;

export function useWatchlist(enabled = true) {
  return useQuery({
    queryKey: WATCHLIST_KEY,
    queryFn: () => api("GET", "/api/v1/watchlist", watchlistSchema),
    staleTime: 60_000,
    enabled,
  });
}

export function useSaveWatchlist() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (items: readonly WatchlistEntry[]) =>
      api("PUT", "/api/v1/watchlist", watchlistSchema, {
        body: { items },
        idempotencyKey: crypto.randomUUID(),
      }),
    onSuccess: async (data) => {
      qc.setQueryData(WATCHLIST_KEY, data);
      await qc.invalidateQueries({ queryKey: ["overview"] });
    },
  });
}

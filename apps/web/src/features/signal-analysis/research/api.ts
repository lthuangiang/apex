import {
  researchSummarySchema,
  researchTradeDetailSchema,
  researchTradesPageSchema,
  type ResearchLabel,
  type ResearchShow,
  type ResearchType,
} from "@drift/shared";
import { keepPreviousData, useInfiniteQuery, useQuery } from "@tanstack/react-query";

import { api, ApiError } from "@/lib/api";

import { SIGNAL_KEY } from "../api";

// Query của tab Signal research (#273). Endpoint chỉ cho role team (403 cho người khác), API của #271.
// Hợp đồng ở `@drift/shared` (packages/shared/src/api/signal-research.ts). API trả mọi giờ ở UTC và bỏ qua `tz`, nên
// query không gửi `tz` và đổi "Show in UTC" không tải lại: web tự đổi giờ khi hiển thị.

export const RESEARCH_BASE = "/api/v1/admin/signal-research";
export const RESEARCH_PATHS = {
  summary: `${RESEARCH_BASE}/summary`,
  trades: `${RESEARCH_BASE}/trades`,
  trade: (id: string) => `${RESEARCH_BASE}/trades/${encodeURIComponent(id)}`,
} as const;

export interface ResearchFilters {
  type: ResearchType | null;
  label: ResearchLabel | null;
  asset: string | null;
  show: ResearchShow;
}
export const RESEARCH_DEFAULT: ResearchFilters = {
  type: null,
  label: null,
  asset: null,
  show: "entered",
};

const retry = (count: number, e: unknown) =>
  !(e instanceof ApiError && e.status < 500) && count < 1;

function query(f: Partial<ResearchFilters>, extra: Record<string, string> = {}) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(f)) if (typeof v === "string") p.set(k, v);
  for (const [k, v] of Object.entries(extra)) p.set(k, v);
  return p.toString();
}

const KEY = [...SIGNAL_KEY, "research"] as const;

export function useResearchSummary() {
  return useQuery({
    queryKey: [...KEY, "summary"],
    queryFn: () => api("GET", RESEARCH_PATHS.summary, researchSummarySchema),
    placeholderData: keepPreviousData,
    retry,
  });
}

export function useResearchTrades(f: ResearchFilters, enabled: boolean) {
  return useInfiniteQuery({
    queryKey: [...KEY, "trades", f],
    queryFn: ({ pageParam }) =>
      api(
        "GET",
        `${RESEARCH_PATHS.trades}?${query(f, pageParam === null ? {} : { cursor: pageParam })}`,
        researchTradesPageSchema,
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    placeholderData: keepPreviousData,
    enabled,
    retry,
  });
}

export function useResearchTrade(id: string | null) {
  return useQuery({
    queryKey: [...KEY, "trade", id],
    queryFn: () => api("GET", RESEARCH_PATHS.trade(id ?? ""), researchTradeDetailSchema),
    enabled: id !== null,
    retry,
  });
}

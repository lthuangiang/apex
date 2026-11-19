import {
  researchArticlesPageSchema,
  researchArticleTraceSchema,
  researchSummarySchema,
  researchTradeDetailSchema,
  researchTradesPageSchema,
  type RESEARCH_ARTICLE_SHOWS,
  type ResearchDropReason,
  type ResearchLabel,
  type ResearchRange,
  type ResearchShow,
  type ResearchStage,
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
  articles: `${RESEARCH_BASE}/articles`,
  trace: (id: string) => `${RESEARCH_BASE}/articles/${encodeURIComponent(id)}/trace`,
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

/** Chỉ giữ giá trị chuỗi (null = không lọc). */
function query(f: object, extra: Record<string, string> = {}) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(f) as [string, unknown][])
    if (typeof v === "string") p.set(k, v);
  for (const [k, v] of Object.entries(extra)) p.set(k, v);
  return p.toString();
}

const KEY = [...SIGNAL_KEY, "research"] as const;

/** Phễu tính theo khoảng `range` (#291): 1 ngày / 7 ngày, nút "1 day" / "7 days" của News feed (#292). */
export function useResearchSummary(range: ResearchRange) {
  return useQuery({
    queryKey: [...KEY, "summary", range],
    queryFn: () =>
      api("GET", `${RESEARCH_PATHS.summary}?${query({}, { range })}`, researchSummarySchema),
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

// News feed và trace từng bài (#292, API #291; thiết kế docs/mockups/signal-research/news-trace.html).

export interface ArticleFilters {
  range: ResearchRange;
  show: (typeof RESEARCH_ARTICLE_SHOWS)[number];
  stage: ResearchStage | null;
  reason: ResearchDropReason | null;
}

/** Số bài mỗi trang của News feed (#297): feed cuộn trong khung cố định, "Load more" theo cursor. */
export const FEED_PAGE = 20;

export function useResearchArticles(f: ArticleFilters) {
  return useInfiniteQuery({
    queryKey: [...KEY, "articles", f],
    queryFn: ({ pageParam }) =>
      api(
        "GET",
        `${RESEARCH_PATHS.articles}?${query(f, {
          limit: String(FEED_PAGE),
          ...(pageParam === null ? {} : { cursor: pageParam }),
        })}`,
        researchArticlesPageSchema,
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    placeholderData: keepPreviousData,
    retry,
  });
}

export function useResearchTrace(id: string | null) {
  return useQuery({
    queryKey: [...KEY, "trace", id],
    queryFn: () => api("GET", RESEARCH_PATHS.trace(id ?? ""), researchArticleTraceSchema),
    enabled: id !== null,
    retry,
  });
}

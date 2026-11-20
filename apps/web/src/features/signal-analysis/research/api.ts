import {
  researchArticlesPageSchema,
  researchClassifiersSchema,
  researchLabelNextSchema,
  researchLabelSavedSchema,
  researchMarketsSchema,
  researchVersionCreatedSchema,
  researchVersionSchema,
  researchVersionsSchema,
  researchArticleTraceSchema,
  researchNewArticlesSchema,
  researchSummarySchema,
  researchTradeDetailSchema,
  researchTradesPageSchema,
  researchWalletsSchema,
  type RESEARCH_ARTICLE_SHOWS,
  type ResearchDropReason,
  type ResearchLabel,
  type ResearchRange,
  type ResearchShow,
  type ResearchStage,
  type ResearchType,
  type ResearchLabelBody,
  type ResearchVersionCreateBody,
  type ResearchVersionStatusBody,
} from "@drift/shared";
import {
  keepPreviousData,
  useInfiniteQuery,
  useQuery,
  useQueryClient,
  type QueryKey,
} from "@tanstack/react-query";
import type { z } from "zod";

import { api, ApiError } from "@/lib/api";
import { useFinancialMutation } from "@/lib/financial-action";

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
  newArticles: `${RESEARCH_BASE}/articles/new`,
  trace: (id: string) => `${RESEARCH_BASE}/articles/${encodeURIComponent(id)}/trace`,
  versions: `${RESEARCH_BASE}/versions`,
  versionStatus: (id: string) => `${RESEARCH_BASE}/versions/${encodeURIComponent(id)}/status`,
  markets: `${RESEARCH_BASE}/markets`,
  classifiers: `${RESEARCH_BASE}/classifiers`,
  researchWallets: `${RESEARCH_BASE}/research-wallets`,
  labelNext: `${RESEARCH_BASE}/labels/next`,
  label: (id: string) => `${RESEARCH_BASE}/articles/${encodeURIComponent(id)}/label`,
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

/** #306: News bot version của tổng kết / feed / trace / lệnh; null = mặc định của API (Baseline). */
export type VersionId = string | null;
const ver = (versionId: VersionId): Record<string, string> =>
  versionId === null ? {} : { versionId };

/** Phễu tính theo khoảng `range` (#291): 1 ngày / 7 ngày, nút "1 day" / "7 days" của News feed (#292). */
export function useResearchSummary(range: ResearchRange, versionId: VersionId = null) {
  return useQuery({
    queryKey: [...KEY, "summary", range, versionId],
    queryFn: () =>
      api(
        "GET",
        `${RESEARCH_PATHS.summary}?${query({}, { range, ...ver(versionId) })}`,
        researchSummarySchema,
      ),
    placeholderData: keepPreviousData,
    retry,
  });
}

export function useResearchTrades(
  f: ResearchFilters,
  enabled: boolean,
  versionId: VersionId = null,
  /** #344: "Show older rules (v2)": thêm lệnh / tín hiệu của quy tắc cũ (mặc định chỉ quy tắc hiện tại). */
  olderRules = false,
) {
  return useInfiniteQuery({
    queryKey: [...KEY, "trades", f, versionId, olderRules],
    queryFn: ({ pageParam }) =>
      api(
        "GET",
        `${RESEARCH_PATHS.trades}?${query(f, {
          ...ver(versionId),
          ...(olderRules ? { olderRules: "true" } : {}),
          ...(pageParam === null ? {} : { cursor: pageParam }),
        })}`,
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

export function useResearchArticles(f: ArticleFilters, versionId: VersionId = null) {
  return useInfiniteQuery({
    queryKey: [...KEY, "articles", f, versionId],
    queryFn: ({ pageParam }) =>
      api(
        "GET",
        `${RESEARCH_PATHS.articles}?${query(f, {
          limit: String(FEED_PAGE),
          ...ver(versionId),
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

export function useResearchTrace(id: string | null, versionId: VersionId = null) {
  return useQuery({
    queryKey: [...KEY, "trace", id, versionId],
    queryFn: () =>
      api(
        "GET",
        `${RESEARCH_PATHS.trace(id ?? "")}${versionId === null ? "" : `?${query({}, ver(versionId))}`}`,
        researchArticleTraceSchema,
      ),
    enabled: id !== null,
    retry,
  });
}

/**
 * #345: bài mới sau con trỏ `since` (null = lần đầu: không có bài, chỉ lấy con trỏ). Không qua react-query: con trỏ đi
 * tới sau mỗi lần hỏi, nơi gọi (live-drop.ts) giữ con trỏ và hẹn giờ 15 s.
 */
export function fetchNewArticles(
  since: string | null,
  versionId: VersionId = null,
  /** null = mặc định của API (20). */
  limit: number | null = null,
) {
  return api(
    "GET",
    `${RESEARCH_PATHS.newArticles}?${query(
      {},
      {
        ...ver(versionId),
        ...(since === null ? {} : { since }),
        ...(limit === null ? {} : { limit: String(limit) }),
      },
    )}`,
    researchNewArticlesSchema,
  );
}

/** Key của tổng kết và feed: bài mới tới thì làm mới để số đếm và feed khớp API. */
export const LIVE_REFRESH_KEYS: readonly QueryKey[] = [
  [...KEY, "summary"],
  [...KEY, "articles"],
];

// ── News bot versions (#306, API #305; thiết kế docs/mockups/signal-research/bot-versions*.html) ─────────────────────

export const VERSIONS_KEY = [...KEY, "versions"] as const;
export const MARKETS_KEY = [...KEY, "markets"] as const;
export const CLASSIFIERS_KEY = [...KEY, "classifiers"] as const;

export function useResearchVersions() {
  return useQuery({
    queryKey: VERSIONS_KEY,
    queryFn: () => api("GET", RESEARCH_PATHS.versions, researchVersionsSchema),
    retry,
  });
}

/** Market SoDEX đang listed cho picker tài sản (bản chụp của scheduler; `items: null` = chưa có). */
export function useResearchMarkets(enabled: boolean) {
  return useQuery({
    queryKey: MARKETS_KEY,
    queryFn: () => api("GET", RESEARCH_PATHS.markets, researchMarketsSchema),
    enabled,
    retry,
  });
}

/** #353: tập ví nghiên cứu mới nhất (khu Bots & labels). Chỉ tải khi khu đang mở. */
export function useResearchWallets(enabled: boolean) {
  return useQuery({
    queryKey: [...KEY, "research-wallets"],
    queryFn: () => api("GET", RESEARCH_PATHS.researchWallets, researchWalletsSchema),
    enabled,
    retry,
  });
}

export function useResearchClassifiers() {
  return useQuery({
    queryKey: CLASSIFIERS_KEY,
    queryFn: () => api("GET", RESEARCH_PATHS.classifiers, researchClassifiersSchema),
    retry,
  });
}

/** Sau một lần ghi version: danh sách version và mọi số theo version (tổng kết, feed, lệnh) đọc lại. */
const versionReads: QueryKey[] = [VERSIONS_KEY];

/**
 * Lưu version mới (DEC-336): cùng Idempotency-Key cho lần gửi lại tự động; kết quả không rõ thì đọc lại danh sách
 * version trước khi mở lại nút.
 */
export function useCreateVersion(
  onSaved: (v: z.output<typeof researchVersionCreatedSchema>) => void,
) {
  const qc = useQueryClient();
  return useFinancialMutation({
    mutationFn: (body: ResearchVersionCreateBody, idempotencyKey: string) =>
      api("POST", RESEARCH_PATHS.versions, researchVersionCreatedSchema, { body, idempotencyKey }),
    refetch: versionReads,
    onSuccess: async (v) => {
      onSaved(v);
      await qc.invalidateQueries({ queryKey: KEY });
    },
  });
}

export interface VersionStatusVars {
  id: string;
  status: ResearchVersionStatusBody["status"];
}

/** Pause / Resume / Stop một version (trạng thái từ backend, quy tắc 1.6). */
export function useVersionStatus() {
  const qc = useQueryClient();
  return useFinancialMutation({
    mutationFn: (v: VersionStatusVars, idempotencyKey: string) =>
      api("POST", RESEARCH_PATHS.versionStatus(v.id), researchVersionSchema, {
        body: { status: v.status },
        idempotencyKey,
      }),
    refetch: versionReads,
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: KEY });
    },
  });
}

// ── Nhãn phân loại (#306, API #304; thiết kế docs/mockups/signal-research/bot-versions-labels.html) ──────────────────

export const LABEL_NEXT_KEY = [...KEY, "labelNext"] as const;

/**
 * Một bài ngẫu nhiên trong tín hiệu của classifier hiện tại mà người xem chưa gắn nhãn. Không có trường kết quả nào
 * (DEC-333): kết quả lệnh chỉ có sau khi lưu nhãn.
 */
export function useLabelNext(enabled: boolean) {
  return useQuery({
    queryKey: LABEL_NEXT_KEY,
    queryFn: () => api("GET", RESEARCH_PATHS.labelNext, researchLabelNextSchema),
    enabled,
    // Mỗi lần "Label another" đọc một bài mới; không dùng lại bài cũ từ cache.
    gcTime: 0,
    staleTime: Infinity,
    retry,
  });
}

export interface SaveLabelVars {
  articleId: string;
  body: ResearchLabelBody;
}

/**
 * Lưu nhãn (`PUT`, Idempotency-Key): cùng key khi tự gửi lại; kết quả không rõ thì đọc lại bảng chất lượng classifier
 * và trace của bài trước khi mở lại nút (DEC-336).
 */
export function useSaveLabel(onSaved: (r: z.output<typeof researchLabelSavedSchema>) => void) {
  const qc = useQueryClient();
  return useFinancialMutation({
    mutationFn: (v: SaveLabelVars, idempotencyKey: string) =>
      api("PUT", RESEARCH_PATHS.label(v.articleId), researchLabelSavedSchema, {
        body: v.body,
        idempotencyKey,
      }),
    refetch: (v) => [CLASSIFIERS_KEY, [...KEY, "trace", v.articleId]],
    onSuccess: async (r) => {
      onSaved(r);
      await Promise.all([
        qc.invalidateQueries({ queryKey: CLASSIFIERS_KEY }),
        qc.invalidateQueries({ queryKey: VERSIONS_KEY }),
        qc.invalidateQueries({ queryKey: [...KEY, "trace", r.articleId] }),
      ]);
    },
  });
}

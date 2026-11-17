import {
  SODEX_CALL_SLOW_MS,
  sodexCallDetailSchema,
  sodexCallFacetsSchema,
  sodexCallsPageSchema,
  sodexCallSummarySchema,
  type SodexCallRange,
  type SodexCallShow,
} from "@drift/shared";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";

import { api } from "@/lib/api";

// Query của SoDEX Debugger. Mọi endpoint chỉ cho role team (403 cho người khác); dữ liệu không nằm trong bundle.

export interface Filters {
  range: SodexCallRange;
  service: string | null;
  endpoint: string | null;
  botId: string | null;
  account: string | null;
  q: string | null;
  show: SodexCallShow;
  slowMs: number;
  /** Một giờ chọn từ biểu đồ Timeouts per hour: [after, before). */
  hour: { after: string; before: string } | null;
}

export const DEFAULT_FILTERS: Filters = {
  range: "24h",
  service: null,
  endpoint: null,
  botId: null,
  account: null,
  q: null,
  show: "all",
  slowMs: SODEX_CALL_SLOW_MS,
  hour: null,
};

/** Có bộ lọc nào khác mặc định (trừ range / show / slowMs) không. */
export function hasNarrowingFilters(f: Filters): boolean {
  return (
    f.service !== null ||
    f.endpoint !== null ||
    f.botId !== null ||
    f.account !== null ||
    f.q !== null ||
    f.hour !== null
  );
}

export function callsQueryString(f: Filters, cursor?: string): string {
  const p = new URLSearchParams({ range: f.range, show: f.show, slowMs: String(f.slowMs) });
  if (f.service !== null) p.set("service", f.service);
  if (f.endpoint !== null) p.set("endpoint", f.endpoint);
  if (f.botId !== null) p.set("botId", f.botId);
  if (f.account !== null) p.set("account", f.account);
  if (f.q !== null) p.set("q", f.q);
  if (f.hour !== null) {
    p.set("after", f.hour.after);
    p.set("before", f.hour.before);
  }
  if (cursor !== undefined) p.set("cursor", cursor);
  p.set("limit", "50");
  return p.toString();
}

export const SODEX_CALLS_KEY = ["admin", "sodex-calls"] as const;
const STALE_RETRY_MS = 30_000;

export function useSodexCalls(f: Filters) {
  return useInfiniteQuery({
    queryKey: [...SODEX_CALLS_KEY, "list", f],
    queryFn: ({ pageParam }) =>
      api(
        "GET",
        `/api/v1/admin/sodex-calls?${callsQueryString(f, pageParam)}`,
        sodexCallsPageSchema,
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    // Lỗi khi đã có dữ liệu: giữ dữ liệu cũ (badge stale) và thử lại sau 30 s.
    refetchInterval: (q) =>
      q.state.status === "error" && q.state.data !== undefined ? STALE_RETRY_MS : false,
  });
}

export function useSodexSummary() {
  return useQuery({
    queryKey: [...SODEX_CALLS_KEY, "summary"],
    queryFn: () => api("GET", "/api/v1/admin/sodex-calls/summary", sodexCallSummarySchema),
  });
}

export function useSodexFacets(range: SodexCallRange) {
  return useQuery({
    queryKey: [...SODEX_CALLS_KEY, "facets", range],
    queryFn: () =>
      api("GET", `/api/v1/admin/sodex-calls/facets?range=${range}`, sodexCallFacetsSchema),
  });
}

export function useSodexCall(id: string | null) {
  return useQuery({
    queryKey: [...SODEX_CALLS_KEY, "detail", id],
    queryFn: () =>
      api(
        "GET",
        `/api/v1/admin/sodex-calls/${encodeURIComponent(id ?? "")}`,
        sodexCallDetailSchema,
      ),
    enabled: id !== null,
  });
}

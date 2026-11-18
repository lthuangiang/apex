import {
  mmFillDetailSchema,
  signalAllViewSchema,
  signalMmFillsPageSchema,
  signalMmViewSchema,
  signalVbEntriesPageSchema,
  signalVbViewSchema,
  vbEntryDetailSchema,
  type SignalRange,
} from "@drift/shared";
import { keepPreviousData, useInfiniteQuery, useQuery } from "@tanstack/react-query";

import { api } from "@/lib/api";

// Query của Signal Analysis. Mọi endpoint chỉ cho role team (403 cho người khác); mọi số do API tính (cache 60 s ở
// server), bundle web chỉ có cách hiển thị.

const BASE = "/api/v1/admin/signal-analysis";

export interface AllFilters {
  range: SignalRange;
  strategy: "volume_maker" | "volume_farm" | null;
  market: string | null;
  account: string | null;
  botId: string | null;
}
export interface VbFilters {
  range: SignalRange;
  market: string | null;
  botId: string | null;
  regime: string | null;
  entryType: "signal" | "balance" | null;
  reversed: "on" | "off" | null;
}
export interface MmFilters {
  range: SignalRange;
  market: string | null;
  botId: string | null;
  level: number | null;
  smart: "on" | "off" | null;
  side: "buy" | "sell" | null;
}

export const ALL_DEFAULT: AllFilters = {
  range: "7d",
  strategy: null,
  market: null,
  account: null,
  botId: null,
};
export const VB_DEFAULT: VbFilters = {
  range: "7d",
  market: null,
  botId: null,
  regime: null,
  entryType: null,
  reversed: null,
};
export const MM_DEFAULT: MmFilters = {
  range: "7d",
  market: null,
  botId: null,
  level: null,
  smart: null,
  side: null,
};

/** Query string từ bộ lọc (bỏ giá trị null) + múi giờ. */
export function qs(f: object, tz: string, extra: Record<string, string> = {}): string {
  const p = new URLSearchParams({ tz });
  for (const [k, v] of Object.entries(f)) {
    if (v !== null && v !== undefined) p.set(k, String(v));
  }
  for (const [k, v] of Object.entries(extra)) p.set(k, v);
  return p.toString();
}

const STALE_RETRY_MS = 30_000;
const opts = {
  placeholderData: keepPreviousData,
  // Lỗi khi đã có dữ liệu: giữ dữ liệu cũ (ghi chú "Showing data from …") và thử lại sau 30 s.
  refetchInterval: (q: { state: { status: string; data: unknown } }) =>
    q.state.status === "error" && q.state.data !== undefined ? STALE_RETRY_MS : false,
} as const;

export const SIGNAL_KEY = ["admin", "signal-analysis"] as const;

export function useSignalAll(f: AllFilters, tz: string, enabled: boolean) {
  return useQuery({
    queryKey: [...SIGNAL_KEY, "all", f, tz],
    queryFn: () => api("GET", `${BASE}/all?${qs(f, tz)}`, signalAllViewSchema),
    enabled,
    ...opts,
  });
}

export function useSignalVb(f: VbFilters, tz: string, enabled: boolean) {
  return useQuery({
    queryKey: [...SIGNAL_KEY, "vb", f, tz],
    queryFn: () => api("GET", `${BASE}/vb?${qs(f, tz)}`, signalVbViewSchema),
    enabled,
    ...opts,
  });
}

export function useVbEntries(f: VbFilters, tz: string, sort: string, enabled: boolean) {
  return useInfiniteQuery({
    queryKey: [...SIGNAL_KEY, "vb-entries", f, tz, sort],
    queryFn: ({ pageParam }) =>
      api(
        "GET",
        `${BASE}/vb/entries?${qs(f, tz, { sort, offset: String(pageParam) })}`,
        signalVbEntriesPageSchema,
      ),
    initialPageParam: 0,
    getNextPageParam: (last) => last.nextOffset ?? undefined,
    enabled,
  });
}

export function useVbEntry(id: string | null, f: VbFilters, tz: string) {
  return useQuery({
    queryKey: [...SIGNAL_KEY, "vb-entry", id, f, tz],
    queryFn: () =>
      api(
        "GET",
        `${BASE}/vb/entries/${encodeURIComponent(id ?? "")}?${qs(f, tz)}`,
        vbEntryDetailSchema,
      ),
    enabled: id !== null,
  });
}

export function useSignalMm(f: MmFilters, tz: string, enabled: boolean) {
  return useQuery({
    queryKey: [...SIGNAL_KEY, "mm", f, tz],
    queryFn: () => api("GET", `${BASE}/mm?${qs(f, tz)}`, signalMmViewSchema),
    enabled,
    ...opts,
  });
}

export function useMmFills(f: MmFilters, tz: string, sort: string, enabled: boolean) {
  return useInfiniteQuery({
    queryKey: [...SIGNAL_KEY, "mm-fills", f, tz, sort],
    queryFn: ({ pageParam }) =>
      api(
        "GET",
        `${BASE}/mm/fills?${qs(f, tz, { sort, offset: String(pageParam) })}`,
        signalMmFillsPageSchema,
      ),
    initialPageParam: 0,
    getNextPageParam: (last) => last.nextOffset ?? undefined,
    enabled,
  });
}

export function useMmFill(id: string | null, f: MmFilters, tz: string) {
  return useQuery({
    queryKey: [...SIGNAL_KEY, "mm-fill", id, f, tz],
    queryFn: () =>
      api(
        "GET",
        `${BASE}/mm/fills/${encodeURIComponent(id ?? "")}?${qs(f, tz)}`,
        mmFillDetailSchema,
      ),
    enabled: id !== null,
  });
}

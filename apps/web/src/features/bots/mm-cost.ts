import { mmMarketCostsSchema, mmMarkoutSchema, type MmMarketCost } from "@drift/shared";
import { useQuery } from "@tanstack/react-query";

import { api } from "@/lib/api";

import type { FormValues } from "./fields";

// Market Making · chi phí / $1M (DEC-227): query, định dạng số và gợi ý "Ways to lower it" (`?suggest=`).

export function useMmMarketCosts() {
  return useQuery({
    queryKey: ["mm-market-costs"],
    queryFn: () => api("GET", "/api/v1/markets/mm-cost", mmMarketCostsSchema),
    staleTime: 60_000,
  });
}

export function useMmMarkout(botId: string) {
  return useQuery({
    queryKey: ["mm-markout", botId],
    queryFn: () => api("GET", `/api/v1/bots/${botId}/mm-markout`, mmMarkoutSchema),
    refetchInterval: 60_000,
  });
}

const trim = (n: number, digits: number) =>
  n.toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: 0 });

/** Số dương / âm có dấu (dấu trừ Unicode như artboard), `null` giữ nguyên để hiện "Not available". */
export function signed(v: string | null, digits: number): string | null {
  if (v === null) return null;
  const n = Number(v);
  const text = trim(Math.abs(n), digits);
  return text === "0" ? "0" : `${n < 0 ? "−" : "+"}${text}`;
}

export function plain(v: string | null, digits: number): string | null {
  return v === null ? null : trim(Number(v), digits);
}

/** Volume 24h dạng gọn: $4.2M, $310K. */
export function compactUsd(v: string | null): string | null {
  if (v === null) return null;
  return `$${Number(v).toLocaleString("en-US", { notation: "compact", maximumFractionDigits: 1 })}`;
}

export type MmSort = "cost" | "volume";

/** Rẻ nhất trước / nhiều volume nhất trước; market chưa có số luôn ở cuối (không coi thiếu là 0). */
export function sortMarkets(rows: readonly MmMarketCost[], by: MmSort): MmMarketCost[] {
  const key = (r: MmMarketCost) => (by === "cost" ? r.totalCostPerMillion : r.volume24h);
  return [...rows].sort((a, b) => {
    const x = key(a);
    const y = key(b);
    if (x === null || y === null)
      return x === y ? a.market.localeCompare(b.market) : x === null ? 1 : -1;
    return by === "cost" ? Number(x) - Number(y) : Number(y) - Number(x);
  });
}

export const MM_SUGGESTIONS = ["quote-back", "close-at-entry", "pause-fast"] as const;
export type MmSuggestion = (typeof MM_SUGGESTIONS)[number];

export function isMmSuggestion(v: string | undefined): v is MmSuggestion {
  return (MM_SUGGESTIONS as readonly string[]).includes(v ?? "");
}

const SUGGEST: Record<MmSuggestion, (values: FormValues) => FormValues> = {
  "quote-back": (values) => {
    const raw = values.quoteLevel;
    const now = typeof raw === "string" && /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : 0;
    return { ...values, quoteLevel: String(Math.min(20, now + 1)) };
  },
  "close-at-entry": (values) => ({ ...values, closeAtEntry: true }),
  "pause-fast": (values) => ({ ...values, pauseOnFastMoves: true }),
};

/** Điền sẵn form Edit theo gợi ý (D-c): chỉ đổi giá trị trong form, người dùng tự Apply. */
export function applyMmSuggestion(values: FormValues, suggestion: MmSuggestion): FormValues {
  return SUGGEST[suggestion](values);
}

import { usMarketsResponseSchema, wealthMeResponseSchema, type UsMarketRow } from "@drift/shared";
import { useQuery } from "@tanstack/react-query";
import { z } from "zod";

import { api } from "@/lib/api";

// US Market (DEC-402, #591): dữ liệu của `GET /api/v1/markets/us` và `GET /api/v1/wealth/me` (#589). api cache 30 s.

export const US_MARKETS_KEY = ["markets", "us"] as const;
export const WEALTH_ME_KEY = ["wealth", "me"] as const;

export function useUsMarkets(enabled = true) {
  return useQuery({
    queryKey: US_MARKETS_KEY,
    queryFn: () => api("GET", "/api/v1/markets/us", usMarketsResponseSchema),
    staleTime: 20_000,
    refetchInterval: 30_000,
    enabled,
  });
}

export function useWealthMe(enabled = true) {
  return useQuery({
    queryKey: WEALTH_ME_KEY,
    queryFn: () => api("GET", "/api/v1/wealth/me", wealthMeResponseSchema),
    staleTime: 20_000,
    refetchInterval: 60_000,
    enabled,
  });
}

/**
 * Market có giới hạn theo sổ lệnh (DEC-402 mục 5): `depthCapMarkets` của `GET /api/v1/features` (#597). Danh sách do api
 * quyết định, web không hard-code. Thiếu trường / sai dạng = [] (không hiện bảng độ sâu trong form tạo bot). Key riêng
 * để không đè dữ liệu của `useFeatures` (schema chung bỏ trường lạ).
 */
const depthCapFeaturesSchema = z.object({
  depthCapMarkets: z.array(z.string()).catch([]).default([]),
});
const NO_MARKETS: readonly string[] = [];

export function useDepthCapMarkets(): readonly string[] {
  return (
    useQuery({
      queryKey: ["features", "depthCapMarkets"],
      queryFn: () => api("GET", "/api/v1/features", depthCapFeaturesSchema),
      staleTime: 60_000,
    }).data?.depthCapMarkets ?? NO_MARKETS
  );
}

/** Dòng market theo symbol trong `/markets/us` (Anthropic trước, rồi token quỹ); null khi không có. */
export function usMarketRowOf(
  data: z.output<typeof usMarketsResponseSchema> | undefined,
  symbol: string,
): UsMarketRow | null {
  if (data === undefined) return null;
  const tokens = data.fundTokens.status === "ok" ? data.fundTokens.items : [];
  return [...data.anthropic, ...tokens].find((r) => r.symbol === symbol) ?? null;
}

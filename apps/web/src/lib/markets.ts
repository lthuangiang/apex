import { marketListSchema, type MarketList } from "@drift/shared";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import { api } from "./api";
import { stepDecimals } from "./format";

// Tên hiển thị của market và tài sản (UI_REVIEW E1.6). Giá trị gửi API luôn là mã gốc của SoDEX.
// Market: `displayName` của SoDEX (`vBTC_vUSDC` → `BTC/USDC`, perps `BTC-USD`). Tài sản: phần tương ứng trong
// `displayName` của market spot có coin đó làm base / quote (`vBTC` → `BTC`, `vUSDC` → `USDC`). Coin không có
// market nào (ví dụ `vMAG7.ssi`) giữ nguyên mã: không đoán tên.

export const MARKETS_KEY = ["markets"] as const;

type Market = MarketList["items"][number];

export interface MarketNames {
  market: (name: string) => string;
  asset: (coin: string) => string;
  info: (name: string) => Market | undefined;
  /** Chữ số thập phân của giá / khối lượng theo tick / lot của market; null khi chưa biết. */
  priceDigits: (name: string) => number | null;
  qtyDigits: (name: string) => number | null;
}

export function marketNames(items: readonly Market[]): MarketNames {
  const byName = new Map(items.map((m) => [m.name, m]));
  const assets = new Map<string, string>();
  for (const m of items) {
    if (m.engine !== "spot" || m.base === null || m.quote === null) continue;
    const [base, quote] = m.displayName.split("/");
    if (base !== undefined && base !== "" && !assets.has(m.base)) assets.set(m.base, base);
    if (quote !== undefined && quote !== "" && !assets.has(m.quote)) assets.set(m.quote, quote);
  }
  return {
    market: (name) => byName.get(name)?.displayName ?? name,
    asset: (coin) => assets.get(coin) ?? coin,
    info: (name) => byName.get(name),
    priceDigits: (name) => {
      const m = byName.get(name);
      return m === undefined ? null : stepDecimals(m.tickSize);
    },
    qtyDigits: (name) => {
      const m = byName.get(name);
      return m === undefined ? null : stepDecimals(m.stepSize);
    },
  };
}

export function useMarkets() {
  return useQuery({
    queryKey: MARKETS_KEY,
    queryFn: () => api("GET", "/api/v1/markets", marketListSchema),
    staleTime: 10 * 60_000,
  });
}

/** Tên hiển thị; khi danh sách market chưa tải xong thì trả mã gốc. */
export function useMarketNames(): MarketNames {
  const { data } = useMarkets();
  return useMemo(() => marketNames(data?.items ?? []), [data]);
}

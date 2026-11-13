import { byTime, change24hPct } from "../../analysis/change-24h";
import { dec } from "../../money";

import type { DeskAiFact } from "./facts";

// "Market today" cho Desk AI (DEC-TBD-desk-market): fact thị trường thật từ 24 nến 1h SoDEX (cửa sổ 24h trượt) và
// giá hiện tại (mark với perps, giá gần nhất với spot). Chỉ mô tả quá khứ, không dự đoán. Hàm thuần, không I/O.

export const DESK_MARKET_CONFIG = {
  /** Số market tối đa đưa vào fact (ưu tiên market có bot đang chạy). */
  maxMarkets: 5,
  /** Cửa sổ: 24 nến 1h. */
  hours: 24,
  /** Cache theo market ở api để 20 câu/ngày × nhiều user không gọi SoDEX liên tục. */
  cacheMs: 60_000,
  /** Thẻ "Market today" (người dùng duyệt): biên độ 24h < 2% → "moving sideways"; > 6% → "jumpy"; ở giữa chỉ nêu số. */
  sidewaysBelowPct: "2",
  jumpyAbovePct: "6",
  /** Số dòng tối đa của thẻ. */
  cardLines: 3,
} as const;

export interface MarketCandle {
  t: number;
  o: string;
  h: string;
  l: string;
}

export interface MarketInput {
  market: string;
  /** Giá hiện tại; null khi không đọc được. */
  price: string | null;
  /** Nến 1h trong 24 giờ qua, thứ tự bất kỳ (SoDEX trả mới nhất trước). */
  candles: readonly MarketCandle[];
  /** `quoteCoin` của symbol trên SoDEX; chỉ "USDC" mới ghi giá theo USDC. */
  quote: string | null;
}

const round2 = (v: ReturnType<typeof dec>) => v.toDecimalPlaces(2).toString();

/** Fact của một market. Thiếu dữ liệu thì bỏ fact đó (không bao giờ ghi 0). */
export function marketFacts(m: MarketInput): DeskAiFact[] {
  const out: DeskAiFact[] = [];
  const f = (key: DeskAiFact["key"], value: string, unit: DeskAiFact["unit"], source: string) =>
    out.push({ id: `${key}:${m.market}`, key, bot: null, market: m.market, value, unit, source });
  // Cùng hàm với Watchlist (DEC-TBD-watchlist-24h): SoDEX trả nến mới nhất trước, % 24h tính từ nến cũ nhất.
  const candles = byTime(m.candles);
  const change = change24hPct(m.price, candles);
  if (change !== null) f("market_change_24h_pct", change, "pct", "sodex_klines");
  if (candles.length > 0) {
    const high = candles.reduce(
      (x, c) => (dec(c.h).gt(x) ? dec(c.h) : x),
      dec(candles[0]?.h ?? "0"),
    );
    const low = candles.reduce(
      (x, c) => (dec(c.l).lt(x) ? dec(c.l) : x),
      dec(candles[0]?.l ?? "0"),
    );
    if (low.gt(0))
      f("market_range_24h_pct", round2(high.sub(low).div(low).mul(100)), "pct", "sodex_klines");
  }
  if (m.price !== null && m.quote === "USDC") f("market_price", m.price, "usdc", "sodex_price");
  return out;
}

/** Chọn market cho fact: bot đang chạy trước, gộp trùng, tối đa `maxMarkets`. */
export function marketsForFacts(bots: readonly { market: string; state: string }[]): string[] {
  const order = [...bots].sort(
    (a, b) => Number(b.state === "running") - Number(a.state === "running"),
  );
  return [...new Set(order.map((b) => b.market))].slice(0, DESK_MARKET_CONFIG.maxMarkets);
}

export type MarketMood = "sideways" | "jumpy" | null;

/** Nhãn theo biên độ 24h (%): < 2 → sideways, > 6 → jumpy, còn lại không gắn nhãn (ngưỡng ở `DESK_MARKET_CONFIG`). */
export function moodOf(rangePct: string): MarketMood {
  if (dec(rangePct).lt(DESK_MARKET_CONFIG.sidewaysBelowPct)) return "sideways";
  if (dec(rangePct).gt(DESK_MARKET_CONFIG.jumpyAbovePct)) return "jumpy";
  return null;
}

const GRID: readonly string[] = ["spot_grid", "futures_grid"];
const VOLUME: readonly string[] = ["volume_farm", "volume_maker"];

export interface MarketTodayLine {
  market: string;
  change: string | null;
  range: string;
  mood: MarketMood;
  /** Vế liên hệ chỉ khi đúng loại bot của user trên market đó: sideways + grid, jumpy + bot khối lượng. */
  relation: "grid" | "volume" | null;
}

/**
 * Dòng của thẻ "Market today" (tất định, không gọi LLM): một dòng mỗi market có biên độ 24h, tối đa `cardLines`.
 * `strategiesByMarket`: chiến lược các bot chưa archive của user trên từng market.
 */
export function marketToday(
  facts: readonly DeskAiFact[],
  strategiesByMarket: ReadonlyMap<string, readonly string[]>,
): MarketTodayLine[] {
  const value = (market: string, key: DeskAiFact["key"]) =>
    facts.find((f) => f.market === market && f.key === key)?.value ?? null;
  const markets = [...new Set(facts.flatMap((f) => (f.market == null ? [] : [f.market])))];
  return markets
    .flatMap((market): MarketTodayLine[] => {
      const range = value(market, "market_range_24h_pct");
      if (range === null) return [];
      const mood = moodOf(range);
      const kinds = strategiesByMarket.get(market) ?? [];
      const relation =
        mood === "sideways" && kinds.some((k) => GRID.includes(k))
          ? "grid"
          : mood === "jumpy" && kinds.some((k) => VOLUME.includes(k))
            ? "volume"
            : null;
      return [{ market, change: value(market, "market_change_24h_pct"), range, mood, relation }];
    })
    .slice(0, DESK_MARKET_CONFIG.cardLines);
}

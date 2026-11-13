import { dec } from "@drift/shared";
import type { SodexRestClient } from "@drift/sodex";

// Volume 24h của market Perps trên SoDEX (cảnh báo "Thin market on SoDEX", DEC-TBD-hip3-xyz): tổng quote volume (`q`)
// của 24 nến 1h, cùng cách đọc nến với Watchlist. Cache 5 phút theo market. Đọc lỗi → null (không cảnh báo).

const CACHE_MS = 5 * 60_000;

export function sodexVolume24h(
  rest: Pick<SodexRestClient, "getKlines">,
  now: () => Date,
): (market: string) => Promise<string | null> {
  const cache = new Map<string, { at: number; value: string | null }>();
  return async (market) => {
    const t = now().getTime();
    const hit = cache.get(market);
    if (hit !== undefined && t - hit.at < CACHE_MS) return hit.value;
    let value: string | null;
    try {
      const k = await rest.getKlines("perps", market, {
        interval: "1h",
        startTime: t - 24 * 3_600_000,
        endTime: t,
        limit: 24,
      });
      value = k.length === 0 ? null : k.reduce((s, c) => s.add(c.q), dec("0")).toString();
    } catch {
      value = null;
    }
    cache.set(market, { at: t, value });
    return value;
  };
}

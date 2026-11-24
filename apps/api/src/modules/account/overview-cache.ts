import { byTime } from "@drift/shared";
import type { Kline, SodexRestClient } from "@drift/sodex";
import { getAddress } from "viem";

import { TtlCache } from "../chart/service";

import { REALIZED_PAGE, sumRealized } from "./realized";

// Cache cho Overview (#494, DEC-387). Overview poll mỗi 15 s; mỗi lần đọc `positions/history` của SoDEX (weight 70 mỗi
// trang, tối đa 10 trang) và klines 24 × 1h cho từng market trong watchlist. Kết quả được dùng lại trong một khoảng
// ngắn để không tiêu hạn mức REST chung trên IP egress. Chỉ cache đúng thứ SoDEX trả về; đọc lỗi thì không cache
// (`TtlCache` bỏ promise bị reject). Realized PnL theo (account, địa chỉ, period): không bao giờ dùng chung giữa account.

/** Realized PnL của period có độ dài (1 / 7 / 30 ngày…). */
export const REALIZED_TTL_MS = 60_000;
/** Realized PnL của period "All" (từ snapshot đầu tiên): nhiều trang nhất, đổi chậm nhất. */
export const REALIZED_ALL_TTL_MS = 300_000;
/** Sparkline watchlist (klines 24 × 1h), dùng chung theo market giữa mọi người dùng. */
export const SPARK_TTL_MS = 300_000;

/** Tổng Realized PnL và mốc bắt đầu của cửa sổ đã dùng để tính (null: SoDEX trả quá nhiều trang, quy tắc 1.8). */
export interface RealizedResult {
  since: number;
  total: string | null;
}

export interface OverviewCache {
  realized: TtlCache<RealizedResult>;
  spark: TtlCache<Kline[]>;
}

export function createOverviewCache(): OverviewCache {
  return { realized: new TtlCache(2_000), spark: new TtlCache(500) };
}

/** Bản dùng chung của process api. */
export const overviewCache = createOverviewCache();

/**
 * Realized PnL của account từ `since` (`periodDays` null = All, `since` 0). Trong hạn TTL trả kết quả cũ kèm `since`
 * của lần đọc đó, để con số và cửa sổ của nó luôn đi cùng nhau.
 */
export function cachedRealized(
  cache: OverviewCache,
  rest: Pick<SodexRestClient, "getPositionsHistory">,
  account: { id: string; address: string },
  periodDays: number | null,
  now: number,
): Promise<RealizedResult> {
  const address = getAddress(account.address);
  const key = `${account.id}:${address}:${periodDays === null ? "all" : String(periodDays)}`;
  const ttl = periodDays === null ? REALIZED_ALL_TTL_MS : REALIZED_TTL_MS;
  return cache.realized.get(key, ttl, now, async () => {
    const since = periodDays === null ? 0 : now - periodDays * 86_400_000;
    // Đọc nhiều trang: bot Market Making đóng hàng nghìn vị thế nhỏ mỗi ngày, một trang 1000 dòng không đủ.
    const total = await sumRealized(
      (endTime) =>
        rest.getPositionsHistory(address, {
          startTime: since,
          ...(endTime === undefined ? {} : { endTime }),
          limit: REALIZED_PAGE,
        }),
      since,
    );
    return { since, total };
  });
}

/** 24 nến 1h gần nhất của market, cũ nhất trước, dùng chung theo (engine, market). */
export function cachedSpark(
  cache: OverviewCache,
  rest: Pick<SodexRestClient, "getKlines">,
  engine: "spot" | "perps",
  market: string,
  now: number,
): Promise<Kline[]> {
  // SoDEX trả mới nhất trước; sparkline / % 24h cần cũ nhất trước.
  return cache.spark.get(`${engine}:${market}`, SPARK_TTL_MS, now, async () =>
    byTime(
      await rest.getKlines(engine, market, {
        interval: "1h",
        startTime: now - 24 * 3_600_000,
        endTime: now,
        limit: 24,
      }),
    ),
  );
}

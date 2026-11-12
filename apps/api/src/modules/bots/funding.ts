import { candles1m, fundingRates, type Db } from "@drift/db";
import { dec, type FundingStats } from "@drift/shared";
import type { SodexRestClient } from "@drift/sodex";
import { and, gt, inArray, sql } from "drizzle-orm";

// Funding đã trả và volume Spot 24 giờ cho ô chọn tài sản Funding Arb (DEC-160). Đọc DB (marketdata ghi), không gọi
// SoDEX ngoài danh sách symbol đã cache; kết quả dùng chung mọi user trong `CACHE_MS`.

const CACHE_MS = 60_000;
const DAY_MS = 86_400_000;

/** Cache theo client SoDEX (mỗi app một client), để test với mock khác nhau không dùng chung. */
const caches = new WeakMap<object, { at: number; value: FundingStats }>();

export async function fundingStats(
  deps: { db: Db; rest: Pick<SodexRestClient, "getSpotSymbols" | "getPerpsSymbols"> },
  now: number,
): Promise<FundingStats> {
  const cached = caches.get(deps.rest);
  if (cached !== undefined && now - cached.at < CACHE_MS) return cached.value;
  const [spot, perps] = await Promise.all([
    deps.rest.getSpotSymbols(),
    deps.rest.getPerpsSymbols(),
  ]);
  const live = perps.filter((p) => p.status === "TRADING");
  const names = live.map((p) => p.name);
  const rows =
    names.length === 0
      ? []
      : await deps.db
          .select({
            market: fundingRates.market,
            avg7d: sql<
              string | null
            >`(avg(${fundingRates.rate}) filter (where ${fundingRates.fundingTime} > ${new Date(now - 7 * DAY_MS)}))::text`,
            periods7d: sql<number>`(count(*) filter (where ${fundingRates.fundingTime} > ${new Date(now - 7 * DAY_MS)}))::int`,
          })
          .from(fundingRates)
          .where(
            and(
              inArray(fundingRates.market, names),
              gt(fundingRates.fundingTime, new Date(now - 30 * DAY_MS)),
            ),
          )
          .groupBy(fundingRates.market);
  // 21 kỳ gần nhất của mỗi market (cửa sổ theo market).
  const last21 =
    names.length === 0
      ? []
      : ((
          await deps.db.execute<{ market: string; n: number; positive: number }>(sql`
            select market, count(*)::int as n, count(*) filter (where rate > 0)::int as positive
            from (
              select ${fundingRates.market} as market, ${fundingRates.rate} as rate,
                row_number() over (partition by ${fundingRates.market} order by ${fundingRates.fundingTime} desc) as rn
              from ${fundingRates}
              where ${inArray(fundingRates.market, names)}
                and ${fundingRates.fundingTime} > ${new Date(now - 30 * DAY_MS)}
            ) x
            where rn <= 21
            group by market`)
        ).rows as { market: string; n: number; positive: number }[]);
  const spotNames = spot.filter((s) => s.status === "TRADING").map((s) => s.name);
  const vol =
    spotNames.length === 0
      ? []
      : await deps.db
          .select({
            market: candles1m.market,
            quote: sql<string>`sum(${candles1m.close} * ${candles1m.volume})::text`,
          })
          .from(candles1m)
          .where(
            and(inArray(candles1m.market, spotNames), gt(candles1m.ts, new Date(now - DAY_MS))),
          )
          .groupBy(candles1m.market);
  const byMarket = new Map(rows.map((r) => [r.market, r]));
  const pos = new Map(last21.map((r) => [r.market, r]));
  const value: FundingStats = {
    perps: live.map((p) => {
      const r = byMarket.get(p.name);
      const l = pos.get(p.name);
      return {
        market: p.name,
        intervalHours: p.fundingInterval / 3600,
        // `funding_rates` lưu tỷ lệ thô của SoDEX; trả về % mỗi kỳ.
        avg7dPct: r?.avg7d == null ? null : dec(r.avg7d).mul(100).toString(),
        periods7d: r?.periods7d ?? 0,
        positive21: l === undefined || l.n < 21 ? null : l.positive,
      };
    }),
    spotVolume24h: Object.fromEntries(
      vol.map((v) => [v.market, dec(v.quote).toDecimalPlaces(2).toString()]),
    ),
  };
  caches.set(deps.rest, { at: now, value });
  return value;
}

import { fundingRates, marketStatsDaily, type Db } from "@drift/db";
import { computeMarketStats } from "@drift/shared";
import type { Engine, SodexRestClient } from "@drift/sodex";
import { and, eq, gte, sql } from "drizzle-orm";

// Job hằng ngày: `market_stats_daily` cho mọi market đang giao dịch (RECO_ENGINE.md mục 10.1 C, DEC-34).
// Giá đóng cửa ngày: kline `1d` của SoDEX (bỏ ngày chưa đóng). Funding: bảng `funding_rates` do
// marketdata ghi. Thiếu dữ liệu thì để null, không tự điền.

const DAY = 86_400_000;
export const DAILY_HISTORY = 200;

export interface StatsDeps {
  db: Db;
  rest: Pick<SodexRestClient, "getKlines" | "getSpotSymbols" | "getPerpsSymbols">;
  now: () => Date;
  wait?: <T>(read: () => Promise<T>) => Promise<T>;
}

export function utcDate(ms: number): string {
  return new Date(ms - (ms % DAY)).toISOString().slice(0, 10);
}

export async function computeDailyStats(
  deps: StatsDeps,
): Promise<{ markets: number; failed: string[] }> {
  const now = deps.now().getTime();
  const today = now - (now % DAY);
  const wait = deps.wait ?? (<T>(read: () => Promise<T>) => read());
  const [spot, perps] = await Promise.all([
    deps.rest.getSpotSymbols(),
    deps.rest.getPerpsSymbols(),
  ]);
  const markets: { engine: Engine; name: string }[] = [
    ...spot
      .filter((s) => s.status === "TRADING")
      .map((s) => ({ engine: "spot" as const, name: s.name })),
    ...perps
      .filter((s) => s.status === "TRADING")
      .map((s) => ({ engine: "perps" as const, name: s.name })),
  ];
  const failed: string[] = [];
  for (const m of markets) {
    try {
      const klines = await wait(() =>
        deps.rest.getKlines(m.engine, m.name, { interval: "1d", limit: DAILY_HISTORY }),
      );
      const closes = klines
        .filter((k) => k.t < today)
        .sort((a, b) => a.t - b.t)
        .map((k) => ({ day: k.t, close: k.c }));
      const funding =
        m.engine === "perps"
          ? (
              await deps.db
                .select({ at: fundingRates.fundingTime, rate: fundingRates.rate })
                .from(fundingRates)
                .where(
                  and(
                    eq(fundingRates.market, m.name),
                    gte(fundingRates.fundingTime, new Date(now - 30 * DAY)),
                  ),
                )
            ).map((f) => ({ at: f.at.getTime(), rate: f.rate }))
          : [];
      const stats = computeMarketStats(closes, funding, now);
      const row = {
        market: m.name,
        engine: m.engine,
        date: utcDate(now),
        sigma30: stats.sigma30,
        p5: stats.p5,
        p50: stats.p50,
        p95: stats.p95,
        lastPrice: closes.at(-1)?.close ?? null,
        trend: stats.trend,
        rangeScore: stats.rangeScore,
        fundingAvg7d: stats.fundingAvg7d,
        fundingPos21: stats.fundingPos21,
      };
      await deps.db
        .insert(marketStatsDaily)
        .values(row)
        .onConflictDoUpdate({
          target: [marketStatsDaily.market, marketStatsDaily.date],
          set: {
            sigma30: sql`excluded.sigma30`,
            p5: sql`excluded.p5`,
            p50: sql`excluded.p50`,
            p95: sql`excluded.p95`,
            lastPrice: sql`excluded.last_price`,
            trend: sql`excluded.trend`,
            rangeScore: sql`excluded.range_score`,
            fundingAvg7d: sql`excluded.funding_avg7d`,
            fundingPos21: sql`excluded.funding_pos21`,
            updatedAt: new Date(),
          },
        });
    } catch {
      failed.push(m.name);
    }
  }
  return { markets: markets.length, failed };
}

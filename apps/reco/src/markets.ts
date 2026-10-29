import { marketStatsDaily, type Db } from "@drift/db";
import { AppError, assetOf, dec, ErrorCode, type RecoMarket } from "@drift/shared";
import type { SodexRestClient } from "@drift/sodex";
import { desc, sql } from "drizzle-orm";

// Đầu vào thị trường cho engine đề xuất: thống kê ngày mới nhất (scheduler ghi), 31 giá đóng cửa ngày
// và quy tắc market từ SoDEX (chỉ đọc). Cache trong bộ nhớ để nhiều request dùng chung.

export interface MarketDeps {
  db: Db;
  rest: Pick<SodexRestClient, "getKlines" | "getSpotSymbols" | "getPerpsSymbols">;
  now: () => number;
  ttlMs?: number;
}

const CLOSES = 31;

async function waitOnLimit<T>(read: () => Promise<T>): Promise<T> {
  for (let i = 0; ; i += 1) {
    try {
      return await read();
    } catch (error) {
      if (!(error instanceof AppError) || error.code !== ErrorCode.rateLimited || i >= 5)
        throw error;
      await new Promise((r) => setTimeout(r, Number(error.details.retryAfterMs ?? 500)));
    }
  }
}

/**
 * Trả market của các tài sản được hỏi. Thống kê đọc từ DB mỗi lần (rẻ); nến ngày chỉ tải cho market
 * cần dùng và cache theo market, để không quét hết danh sách SoDEX trong một request.
 */
export function marketLoader(deps: MarketDeps) {
  const ttl = deps.ttlMs ?? 10 * 60_000;
  const closesCache = new Map<string, { at: number; closes: string[] }>();

  async function closesOf(engine: "spot" | "perps", market: string): Promise<string[]> {
    const hit = closesCache.get(market);
    if (hit !== undefined && deps.now() - hit.at < ttl) return hit.closes;
    // Bỏ nến của ngày hiện tại (chưa đóng), như scheduler.
    const today = deps.now() - (deps.now() % 86_400_000);
    const klines = (
      await waitOnLimit(() =>
        deps.rest.getKlines(engine, market, { interval: "1d", limit: CLOSES + 1 }),
      )
    ).filter((k) => k.t < today);
    const closes = [...klines]
      .sort((a, b) => a.t - b.t)
      .slice(-CLOSES)
      .map((k) => k.c);
    closesCache.set(market, { at: deps.now(), closes });
    return closes;
  }

  return async (assets: readonly string[]): Promise<RecoMarket[]> => {
    const wanted = new Set(assets);
    const rows = (
      await deps.db
        .selectDistinctOn([marketStatsDaily.market])
        .from(marketStatsDaily)
        .orderBy(marketStatsDaily.market, desc(marketStatsDaily.date))
        .where(sql`${marketStatsDaily.date} >= current_date - 3`)
    ).filter((r) => wanted.has(assetOf(r.market)));
    const [spot, perps] = await Promise.all([
      waitOnLimit(() => deps.rest.getSpotSymbols()),
      waitOnLimit(() => deps.rest.getPerpsSymbols()),
    ]);
    const out: RecoMarket[] = [];
    for (const r of rows) {
      const s = r.engine === "spot" ? spot.find((x) => x.name === r.market) : undefined;
      const p = r.engine === "perps" ? perps.find((x) => x.name === r.market) : undefined;
      const sym = s ?? p;
      if (sym?.status !== "TRADING" || r.lastPrice === null) continue;
      out.push({
        market: r.market,
        engine: r.engine,
        asset: assetOf(r.market),
        quote: s?.quoteCoin ?? "vUSDC",
        lastPrice: r.lastPrice,
        sigma30: r.sigma30,
        p5: r.p5,
        p95: r.p95,
        trend: r.trend,
        rangeScore: r.rangeScore,
        // market_stats_daily lưu tỷ lệ thô của SoDEX (0.0001 = 0.01%); engine đề xuất dùng %.
        fundingAvg7d: r.fundingAvg7d === null ? null : dec(r.fundingAvg7d).mul(100).toString(),
        fundingPos21: r.fundingPos21,
        closes: await closesOf(r.engine, r.market),
        rules: {
          tickSize: sym.tickSize,
          stepSize: sym.stepSize,
          minQuantity: sym.minQuantity,
          minNotional: sym.minNotional,
        },
        maxLeverage: p?.maxLeverage ?? null,
      });
    }
    return out;
  };
}

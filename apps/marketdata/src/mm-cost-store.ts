import { bots, candles1m, mid1s, mmMarketHourly, type Db } from "@drift/db";
import { Decimal, Strategy } from "@drift/shared";
import { and, desc, gte, inArray, lt, sql } from "drizzle-orm";

import type { HourBucket, MmCostCollector } from "./mm-cost";

// Đọc / ghi DB cho dữ liệu chi phí làm market (DEC-TBD-mm-cost). Giới hạn số market nghe WS (PM chốt điều kiện 2: tài
// liệu SoDEX không nói rõ "2.000 tin / phút" có tính tin nhận về hay không): tối đa `MM_TOP_MARKETS` market Perps có
// volume 24h cao nhất (tính từ candles_1m) cộng mọi market đang có bot MM chạy. Market còn lại: "Not available".

export const MM_TOP_MARKETS = 30;
export const MM_KEEP_MS = 48 * 3_600_000;
const HOUR = 3_600_000;

/** Market có bot MM đang chạy (cần `mid_1s` cho D2 và ưu tiên fill thật ở D1). */
export async function mmBotMarkets(db: Db): Promise<string[]> {
  const rows = await db
    .selectDistinct({ market: bots.market })
    .from(bots)
    .where(
      and(
        sql`${bots.strategy} = ${Strategy.volumeMaker}`,
        inArray(bots.state, ["starting", "running", "resuming", "pausing", "paused"]),
      ),
    );
  return rows.map((r) => r.market);
}

/** Top market Perps theo volume quote 24h từ candles_1m (chỉ trong `perps`). */
export async function topVolumeMarkets(
  db: Db,
  perps: readonly string[],
  now: number,
): Promise<string[]> {
  if (perps.length === 0) return [];
  const vol = sql<string>`sum(${candles1m.close} * ${candles1m.volume})`;
  const rows = await db
    .select({ market: candles1m.market, vol })
    .from(candles1m)
    .where(and(gte(candles1m.ts, new Date(now - 24 * HOUR)), inArray(candles1m.market, [...perps])))
    .groupBy(candles1m.market)
    .orderBy(desc(vol))
    .limit(MM_TOP_MARKETS);
  return rows.map((r) => r.market);
}

/** Nạp lại tổng của giờ đang chạy (khởi động lại giữa giờ thì cộng tiếp). */
export async function seedCurrentHour(db: Db, c: MmCostCollector, now: number): Promise<void> {
  const hour = Math.floor(now / HOUR) * HOUR;
  const rows = await db
    .select()
    .from(mmMarketHourly)
    .where(gte(mmMarketHourly.hour, new Date(hour)));
  for (const r of rows)
    c.seed({
      market: r.market,
      hour: r.hour.getTime(),
      notional: new Decimal(r.notional),
      markoutNotional: new Decimal(r.markoutNotional),
      trades: r.trades,
      spreadTicks: r.spreadTicks as Record<string, number>,
    });
}

export async function saveFlush(
  db: Db,
  f: { buckets: HourBucket[]; mids: { market: string; ts: number; mid: { toString(): string } }[] },
): Promise<void> {
  if (f.buckets.length > 0)
    await db
      .insert(mmMarketHourly)
      .values(
        f.buckets.map((b) => ({
          market: b.market,
          hour: new Date(b.hour),
          notional: b.notional.toString(),
          markoutNotional: b.markoutNotional.toString(),
          trades: b.trades,
          spreadTicks: b.spreadTicks,
        })),
      )
      .onConflictDoUpdate({
        target: [mmMarketHourly.market, mmMarketHourly.hour],
        set: {
          notional: sql`excluded.notional`,
          markoutNotional: sql`excluded.markout_notional`,
          trades: sql`excluded.trades`,
          spreadTicks: sql`excluded.spread_ticks`,
          updatedAt: sql`now()`,
        },
      });
  for (let i = 0; i < f.mids.length; i += 1000)
    await db
      .insert(mid1s)
      .values(
        f.mids.slice(i, i + 1000).map((m) => ({
          market: m.market,
          ts: new Date(m.ts),
          mid: m.mid.toString(),
        })),
      )
      .onConflictDoNothing();
}

export async function purgeMmCost(db: Db, now: number): Promise<void> {
  const cutoff = new Date(now - MM_KEEP_MS);
  await db.delete(mmMarketHourly).where(lt(mmMarketHourly.hour, cutoff));
  await db.delete(mid1s).where(lt(mid1s.ts, cutoff));
}

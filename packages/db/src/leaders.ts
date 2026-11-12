import { ENGINE_ACTIVE_STATES, Strategy, type LeaderSource } from "@drift/shared";
import { and, desc, eq, inArray, sql } from "drizzle-orm";

import type { Db } from "./client";
import { botVersions, bots, leaderFollows, leaderStatsDaily } from "./schema";

// Ví leader dùng chung cho marketdata (T0 / T1), scheduler (T2) và api (chỗ copy) — DEC-161, DEC-163.

const ADDRESS = /^0x[0-9a-f]{40}$/;

/** Ví leader của các bot copy đang chạy (kể cả paper), theo nguồn. */
export async function copiedLeaders(db: Db, source: LeaderSource): Promise<string[]> {
  const rows = await db
    .selectDistinct({ address: sql<string>`lower(${botVersions.config}->>'leaderAddress')` })
    .from(bots)
    .innerJoin(botVersions, and(eq(botVersions.botId, bots.id), eq(botVersions.status, "active")))
    .where(
      and(
        eq(bots.strategy, Strategy.copyTrade),
        inArray(bots.state, [...ENGINE_ACTIVE_STATES]),
        sql`${botVersions.config}->>'leaderSource' = ${source}`,
      ),
    );
  return rows.map((r) => r.address).filter((a) => ADDRESS.test(a));
}

/** Ví có người theo dõi (Following), theo nguồn. */
export async function followedLeaders(db: Db, source: LeaderSource): Promise<string[]> {
  const rows = await db
    .selectDistinct({ address: leaderFollows.address })
    .from(leaderFollows)
    .where(eq(leaderFollows.source, source));
  return rows.map((r) => r.address.toLowerCase()).filter((a) => ADDRESS.test(a));
}

export interface CopyBotRow {
  botId: string;
  source: LeaderSource;
  address: string;
  config: Record<string, unknown>;
}

/** Bot copy thật đang chạy kèm config (phân bổ thanh khoản ở marketdata, DEC-163 mục 9). Bot paper không lên sổ SoDEX. */
export async function liveCopyBots(db: Db): Promise<CopyBotRow[]> {
  const rows = await db
    .select({ botId: bots.id, config: botVersions.config })
    .from(bots)
    .innerJoin(botVersions, and(eq(botVersions.botId, bots.id), eq(botVersions.status, "active")))
    .where(
      and(
        eq(bots.strategy, Strategy.copyTrade),
        eq(bots.mode, "live"),
        inArray(bots.state, [...ENGINE_ACTIVE_STATES]),
      ),
    );
  return rows.flatMap((r) => {
    const c = (r.config ?? {}) as Record<string, unknown>;
    const source = c.leaderSource === "hyperliquid" ? "hyperliquid" : "sodex";
    const address = typeof c.leaderAddress === "string" ? c.leaderAddress.toLowerCase() : "";
    return ADDRESS.test(address) ? [{ botId: r.botId, source, address, config: c }] : [];
  });
}

/** Typical hold (ms) mới nhất của từng ví; ví chưa có thống kê không có trong map. */
export async function latestTypicalHold(
  db: Db,
  source: LeaderSource,
  addresses: readonly string[],
): Promise<Map<string, number | null>> {
  const out = new Map<string, number | null>();
  if (addresses.length === 0) return out;
  const rows = await db
    .selectDistinctOn([leaderStatsDaily.address], {
      address: leaderStatsDaily.address,
      hold: leaderStatsDaily.typicalHoldMs,
    })
    .from(leaderStatsDaily)
    .where(
      and(eq(leaderStatsDaily.source, source), inArray(leaderStatsDaily.address, [...addresses])),
    )
    .orderBy(leaderStatsDaily.address, desc(leaderStatsDaily.date));
  for (const r of rows) out.set(r.address, r.hold);
  return out;
}

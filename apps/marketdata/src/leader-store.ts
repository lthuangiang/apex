import {
  leaderAlertState,
  leaderEvents,
  leaderFollows,
  leaderStatsDaily,
  leaderWallets,
  outbox,
  type Db,
} from "@drift/db";
import { bigMove, type LeaderEvent, type LeaderSource, type LeaderStats } from "@drift/shared";
import { and, desc, eq, gte } from "drizzle-orm";

// Ghi DB cho ví leader (DEC-163 mục 11): con trỏ fill, sự kiện vị thế, cảnh báo "big move" (chỉ trong app) cho người
// theo dõi qua outbox `jobs.notify`. Ngưỡng USD chưa chốt (OPEN_QUESTIONS 21a): `minUsd` null = tắt cảnh báo.

const where = (source: LeaderSource, address: string) =>
  and(eq(leaderWallets.source, source), eq(leaderWallets.address, address));

export async function getCursor(
  db: Db,
  source: LeaderSource,
  address: string,
): Promise<number | null> {
  const [w] = await db
    .select({ c: leaderWallets.fillCursor })
    .from(leaderWallets)
    .where(where(source, address));
  return w?.c ?? null;
}

export async function setCursor(
  db: Db,
  source: LeaderSource,
  address: string,
  ms: number,
): Promise<void> {
  await db
    .insert(leaderWallets)
    .values({ source, address, fillCursor: ms })
    .onConflictDoUpdate({
      target: [leaderWallets.source, leaderWallets.address],
      set: { fillCursor: ms },
    });
}

export interface EventSinkOptions {
  minUsd: string | null;
}

/** Ghi sự kiện (bỏ trùng theo `lastTid`), rồi kiểm tra big move cho từng coin có sự kiện mở mới. */
export async function saveLeaderEvents(
  db: Db,
  source: LeaderSource,
  address: string,
  events: readonly LeaderEvent[],
  seenAt: number,
  opts: EventSinkOptions,
): Promise<void> {
  for (const e of events) {
    await db
      .insert(leaderEvents)
      .values({
        source,
        address,
        coin: e.coin,
        market: e.market,
        kind: e.kind,
        positionBefore: e.positionBefore,
        positionAfter: e.positionAfter,
        notional: e.notional,
        price: e.price,
        realized: e.realized,
        at: new Date(e.at),
        seenAt: new Date(seenAt),
        lastTid: e.lastTid,
      })
      .onConflictDoNothing();
  }
  if (opts.minUsd === null) return;
  const coins = new Set(
    events
      .filter((e) => e.kind === "open" || e.kind === "add" || e.kind === "flip")
      .map((e) => e.coin),
  );
  if (coins.size === 0) return;

  const [stats] = await db
    .select({ stats: leaderStatsDaily.stats })
    .from(leaderStatsDaily)
    .where(and(eq(leaderStatsDaily.source, source), eq(leaderStatsDaily.address, address)))
    .orderBy(desc(leaderStatsDaily.date))
    .limit(1);
  const median = (stats?.stats as LeaderStats | undefined)?.medianEntryNotional ?? null;
  const followers = await db
    .select({ userId: leaderFollows.userId })
    .from(leaderFollows)
    .where(and(eq(leaderFollows.source, source), eq(leaderFollows.address, address)));
  if (followers.length === 0) return;

  for (const coin of coins) {
    const recent = await db
      .select()
      .from(leaderEvents)
      .where(
        and(
          eq(leaderEvents.source, source),
          eq(leaderEvents.address, address),
          eq(leaderEvents.coin, coin),
          gte(leaderEvents.at, new Date(seenAt - 15 * 60_000)),
        ),
      );
    const [alert] = await db
      .select({ at: leaderAlertState.lastAlertAt })
      .from(leaderAlertState)
      .where(
        and(
          eq(leaderAlertState.source, source),
          eq(leaderAlertState.address, address),
          eq(leaderAlertState.coin, coin),
        ),
      );
    const total = bigMove({
      events: recent.map((r) => ({
        coin: r.coin,
        market: r.market,
        kind: r.kind,
        positionBefore: r.positionBefore,
        positionAfter: r.positionAfter,
        notional: r.notional,
        price: r.price,
        realized: r.realized,
        at: r.at.getTime(),
        lastAt: r.at.getTime(),
        lastTid: r.lastTid,
      })),
      medianEntryNotional: median,
      minUsd: opts.minUsd,
      lastAlertAt: alert?.at.getTime() ?? null,
      now: seenAt,
    });
    if (total === null) continue;
    const latest = events.filter((e) => e.coin === coin).at(-1);
    await db.transaction(async (tx) => {
      await tx
        .insert(leaderAlertState)
        .values({ source, address, coin, lastAlertAt: new Date(seenAt) })
        .onConflictDoUpdate({
          target: [leaderAlertState.source, leaderAlertState.address, leaderAlertState.coin],
          set: { lastAlertAt: new Date(seenAt) },
        });
      for (const f of followers) {
        await tx.insert(outbox).values({
          topic: "jobs.notify",
          payload: {
            userId: f.userId,
            type: "leader_big_move",
            data: {
              source,
              address,
              coin,
              market: latest?.market ?? null,
              kind: latest?.kind ?? null,
              notional: total.toDecimalPlaces(2).toString(),
              medianEntryNotional: median,
              at: latest?.at ?? seenAt,
              seenAt,
            },
          },
        });
      }
    });
  }
}

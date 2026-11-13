import {
  leaderAlertState,
  leaderEvents,
  leaderFollows,
  leaderPositionAlertState,
  leaderStatsDaily,
  leaderWallets,
  outbox,
  type Db,
} from "@drift/db";
import { bigMove, dec, type LeaderEvent, type LeaderSource, type LeaderStats } from "@drift/shared";
import { and, desc, eq, gte } from "drizzle-orm";

import {
  bigMoveFollowers,
  listedOnly,
  planPositionAlerts,
  positionFollowers,
} from "./follow-alerts";

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
  // Mức cảnh báo theo từng người follow (DEC-209). `off` không nhận gì.
  const followers = bigMoveFollowers(
    await db
      .select({ userId: leaderFollows.userId, level: leaderFollows.alertLevel })
      .from(leaderFollows)
      .where(and(eq(leaderFollows.source, source), eq(leaderFollows.address, address))),
  );
  if (followers.length === 0) return;
  // Chỉ market SoDEX có: báo market không copy được chỉ gây nhiễu (thay đổi hành vi big move của DEC-163/179).
  const listed = listedOnly(events);

  const bigMoveCoins =
    opts.minUsd === null
      ? new Set<string>()
      : await alertBigMoves(db, source, address, listed, seenAt, opts.minUsd, followers);
  await alertPositions(
    db,
    source,
    address,
    listed,
    seenAt,
    positionFollowers(followers),
    bigMoveCoins,
  );
}

/** Big move cho mọi người follow còn bật cảnh báo; trả về các coin vừa báo. */
async function alertBigMoves(
  db: Db,
  source: LeaderSource,
  address: string,
  events: readonly LeaderEvent[],
  seenAt: number,
  minUsd: string,
  followers: readonly { userId: string }[],
): Promise<Set<string>> {
  const alerted = new Set<string>();
  const coins = new Set(
    events
      .filter((e) => e.kind === "open" || e.kind === "add" || e.kind === "flip")
      .map((e) => e.coin),
  );
  if (coins.size === 0) return alerted;

  const [stats] = await db
    .select({ stats: leaderStatsDaily.stats })
    .from(leaderStatsDaily)
    .where(and(eq(leaderStatsDaily.source, source), eq(leaderStatsDaily.address, address)))
    .orderBy(desc(leaderStatsDaily.date))
    .limit(1);
  const median = (stats?.stats as LeaderStats | undefined)?.medianEntryNotional ?? null;

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
      minUsd,
      lastAlertAt: alert?.at.getTime() ?? null,
      now: seenAt,
    });
    if (total === null) continue;
    alerted.add(coin);
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
  return alerted;
}

/**
 * Mức `positions` (DEC-209): báo khi trader mở vị thế mới, đóng hẳn, đảo chiều hoặc bị thanh lý;
 * bỏ add / reduce. Mỗi (ví, coin) tối đa một tin / 10 phút; coin vừa có big move thì không báo thêm.
 */
async function alertPositions(
  db: Db,
  source: LeaderSource,
  address: string,
  events: readonly LeaderEvent[],
  seenAt: number,
  followers: readonly { userId: string }[],
  skipCoins: ReadonlySet<string>,
): Promise<void> {
  if (followers.length === 0) return;
  const states = await db
    .select({ coin: leaderPositionAlertState.coin, at: leaderPositionAlertState.lastAlertAt })
    .from(leaderPositionAlertState)
    .where(
      and(
        eq(leaderPositionAlertState.source, source),
        eq(leaderPositionAlertState.address, address),
      ),
    );
  const last = new Map(states.map((s) => [s.coin, s.at.getTime()]));
  for (const { coin, event: e, side } of planPositionAlerts(events, last, skipCoins, seenAt)) {
    await db.transaction(async (tx) => {
      await tx
        .insert(leaderPositionAlertState)
        .values({ source, address, coin, lastAlertAt: new Date(seenAt) })
        .onConflictDoUpdate({
          target: [
            leaderPositionAlertState.source,
            leaderPositionAlertState.address,
            leaderPositionAlertState.coin,
          ],
          set: { lastAlertAt: new Date(seenAt) },
        });
      for (const f of followers)
        await tx.insert(outbox).values({
          topic: "jobs.notify",
          payload: {
            userId: f.userId,
            type: "leader_position",
            data: {
              source,
              address,
              coin,
              market: e.market,
              kind: e.kind,
              side,
              notional: dec(e.notional).toDecimalPlaces(2).toString(),
              realized: e.realized,
              at: e.at,
              seenAt,
            },
          },
        });
    });
  }
}

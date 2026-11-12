import {
  botEvents,
  copiedLeaders,
  followedLeaders,
  leaderEvents,
  leaderStatsDaily,
  leaderWallets,
  leaderboardRuns,
  liveCopyBots,
  type Db,
} from "@drift/db";
import { monthPnlOf, toLeaderFill, type HyperliquidClient } from "@drift/hyperliquid";
import {
  classify,
  coinIndex,
  dec,
  groupLeaderEvents,
  LEADER_STATS,
  leaderStats,
  meetsMinHold,
} from "@drift/shared";
import { and, desc, eq, isNull } from "drizzle-orm";

import { utcDate } from "./market-stats";

// T2 Copy Trading v1 (DEC-163 mục 2, 10; docs/COPY_TRADING_DATA.md): mỗi ngày lấy leaderboard Hyperliquid, đọc fill
// 30 ngày của từng ứng viên, tính lại thống kê từ fill thật. Leaderboard lỗi → giữ lần `ok` trước (API hiện ngày đó).
// Ví đang được copy hoặc theo dõi luôn được tính lại (minHoldFilter hằng ngày), kể cả khi rơi khỏi top.

const DAY = 86_400_000;
export const LEADERBOARD_CANDIDATES = 200;
/** Số sự kiện gần nhất ghi cho Trader profile của mỗi ví (ví chưa ai theo dõi chỉ có dữ liệu tới lượt đêm). */
export const PROFILE_EVENTS = 50;

/** Cập nhật `leaderboard_runs.updated_at` sau mỗi chừng này ví. */
const HEARTBEAT_EVERY = 5;
/** Lượt "running" không có nhịp tim lâu hơn mức này coi như tiến trình đã chết (một ví chậm nhất cỡ vài phút). */
export const LEADERBOARD_STALE_MS = 20 * 60_000;
/** Lượt lỗi chỉ thử lại sau chừng này, không gọi dồn. */
const RETRY_FAILED_MS = 3_600_000;

/**
 * Có nên bắt đầu lượt leaderboard hôm nay không. `run` = dòng `leaderboard_runs` của ngày UTC hiện tại.
 * Hàm thuần để test; `main.ts` gọi lúc nhận lease và mỗi 10 phút.
 */
export function leaderboardDue(
  run: { status: "running" | "ok" | "failed"; updatedAt: Date } | undefined,
  now: number,
): boolean {
  if (run === undefined) return true;
  const idle = now - run.updatedAt.getTime();
  if (run.status === "ok") return false;
  if (run.status === "running") return idle >= LEADERBOARD_STALE_MS;
  return idle >= RETRY_FAILED_MS;
}

export interface LeaderboardDeps {
  db: Db;
  hl: Pick<HyperliquidClient, "leaderboard" | "fillsSince" | "fundingSince" | "isVault">;
  /** Market SoDEX Perps đang giao dịch. */
  sodexMarkets: () => Promise<string[]>;
  now: () => number;
  candidates?: number;
}

export interface LeaderboardResult {
  status: "ok" | "failed";
  candidates: number;
  computed: number;
  failed: string[];
}

async function finish(deps: LeaderboardDeps, date: string, r: LeaderboardResult, error?: string) {
  await deps.db
    .update(leaderboardRuns)
    .set({
      status: r.status,
      candidates: r.candidates,
      computed: r.computed,
      error: error ?? (r.failed.length > 0 ? `${String(r.failed.length)} wallets failed` : null),
      finishedAt: new Date(deps.now()),
    })
    .where(eq(leaderboardRuns.date, date));
}

export async function runLeaderboard(deps: LeaderboardDeps): Promise<LeaderboardResult> {
  const now = deps.now();
  const date = utcDate(now);
  const limit = deps.candidates ?? LEADERBOARD_CANDIDATES;
  await deps.db
    .insert(leaderboardRuns)
    .values({ date, status: "running" })
    .onConflictDoUpdate({
      target: leaderboardRuns.date,
      set: { status: "running", error: null, finishedAt: null, updatedAt: new Date(now) },
    });

  let addresses: string[];
  try {
    const rows = await deps.hl.leaderboard();
    const top = rows
      .map((r) => ({ r, pnl: monthPnlOf(r) }))
      .filter(
        (x): x is { r: (typeof rows)[number]; pnl: string } => x.pnl !== null && dec(x.pnl).gt(0),
      )
      .sort((a, b) => dec(b.pnl).cmp(dec(a.pnl)))
      .slice(0, limit);
    for (const { r, pnl } of top) {
      const address = r.ethAddress.toLowerCase();
      const values = {
        displayName: r.displayName ?? null,
        accountValue: r.accountValue,
        leaderboardPnl30d: pnl,
        lastOnLeaderboardAt: new Date(now),
      };
      await deps.db
        .insert(leaderWallets)
        .values({ source: "hyperliquid", address, ...values })
        .onConflictDoUpdate({ target: [leaderWallets.source, leaderWallets.address], set: values });
    }
    addresses = top.map((x) => x.r.ethAddress.toLowerCase());
  } catch (error) {
    const r: LeaderboardResult = { status: "failed", candidates: 0, computed: 0, failed: [] };
    await finish(deps, date, r, error instanceof Error ? error.message : "Leaderboard failed");
    return r;
  }

  // Ví đang copy / theo dõi: tính lại dù không còn trong top.
  const extra = [
    ...(await copiedLeaders(deps.db, "hyperliquid")),
    ...(await followedLeaders(deps.db, "hyperliquid")),
  ];
  for (const address of extra) {
    await deps.db
      .insert(leaderWallets)
      .values({ source: "hyperliquid", address })
      .onConflictDoNothing();
  }
  const all = [...new Set([...addresses, ...extra])];
  const index = coinIndex(await deps.sodexMarkets());
  const from = now - LEADER_STATS.windowDays * DAY;
  const failed: string[] = [];
  let computed = 0;

  for (const address of all) {
    try {
      const [w] = await deps.db
        .select({ isVault: leaderWallets.isVault })
        .from(leaderWallets)
        .where(and(eq(leaderWallets.source, "hyperliquid"), eq(leaderWallets.address, address)));
      let isVault = w?.isVault ?? null;
      if (isVault === null) {
        isVault = await deps.hl.isVault(address, "background");
        await deps.db
          .update(leaderWallets)
          .set({ isVault })
          .where(
            and(
              eq(leaderWallets.source, "hyperliquid"),
              eq(leaderWallets.address, address),
              isNull(leaderWallets.isVault),
            ),
          );
      }
      const { fills, capped } = await deps.hl.fillsSince(
        address,
        from,
        LEADER_STATS.fillCap,
        "background",
      );
      const funding = await deps.hl.fundingSince(address, from, "background");
      const leaderFills = fills.map((f) => toLeaderFill(f, address));
      const stats = leaderStats({
        fills: leaderFills,
        funding,
        now,
        index,
        historyIncomplete: capped,
      });
      const c = classify(stats, isVault);
      const row = {
        stats,
        hidden: c.hidden,
        tabs: c.tabs,
        steadyScore: c.steadyScore === null ? null : Number(c.steadyScore),
        profit: stats.profit,
        typicalHoldMs: stats.typicalHoldMs,
        computedAt: new Date(deps.now()),
      };
      await deps.db
        .insert(leaderStatsDaily)
        .values({ source: "hyperliquid", address, date, ...row })
        .onConflictDoUpdate({
          target: [leaderStatsDaily.source, leaderStatsDaily.address, leaderStatsDaily.date],
          set: row,
        });
      const recent = groupLeaderEvents(leaderFills, index).events.slice(-PROFILE_EVENTS);
      const seenAt = new Date(deps.now());
      for (const e of recent) {
        await deps.db
          .insert(leaderEvents)
          .values({
            source: "hyperliquid",
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
            seenAt,
            lastTid: e.lastTid,
          })
          .onConflictDoNothing();
      }
      computed += 1;
    } catch {
      // Một ví lỗi không chặn cả lượt; ví đó giữ thống kê của ngày trước.
      failed.push(address);
    }
    // Nhịp tim: lượt dài vài giờ; tiến trình mới nhận lease biết lượt cũ còn sống hay đã chết (`leaderboardDue`).
    if ((computed + failed.length) % HEARTBEAT_EVERY === 0)
      await deps.db
        .update(leaderboardRuns)
        .set({ candidates: all.length, computed, updatedAt: new Date(deps.now()) })
        .where(eq(leaderboardRuns.date, date));
  }

  const r: LeaderboardResult = {
    status: computed > 0 ? "ok" : "failed",
    candidates: all.length,
    computed,
    failed,
  };
  await finish(deps, date, r);
  return r;
}

/**
 * minHoldFilter hằng ngày (DEC-163 mục 5): so thống kê hôm nay với lần trước của từng trader đang được copy; đổi trạng
 * thái thì ghi sự kiện lên Trading Agent của từng bot (marketdata tự chặn lệnh mở theo thống kê mới, không đóng vị thế).
 */
export async function noteMinHoldChanges(db: Db, date: string, now: number): Promise<number> {
  const bots = (await liveCopyBots(db)).filter((b) => b.source === "hyperliquid");
  let written = 0;
  for (const address of new Set(bots.map((b) => b.address))) {
    const rows = await db
      .select({ date: leaderStatsDaily.date, hold: leaderStatsDaily.typicalHoldMs })
      .from(leaderStatsDaily)
      .where(and(eq(leaderStatsDaily.source, "hyperliquid"), eq(leaderStatsDaily.address, address)))
      .orderBy(desc(leaderStatsDaily.date))
      .limit(2);
    const [today, before] = rows;
    if (today?.date !== date) continue;
    const okNow = meetsMinHold({ typicalHoldMs: today.hold });
    const okBefore = before === undefined ? true : meetsMinHold({ typicalHoldMs: before.hold });
    if (okNow === okBefore) continue;
    for (const b of bots.filter((x) => x.address === address)) {
      await db.insert(botEvents).values({
        botId: b.botId,
        type: "decision",
        decision: okNow ? "Copying new positions again" : "New positions not copied",
        why: okNow
          ? "The trader's typical hold is back above 15 minutes."
          : "The trader's typical hold fell under 15 minutes. Cuts and closes are still copied; open positions stay.",
        occurredAt: new Date(now),
      });
      written += 1;
    }
  }
  return written;
}

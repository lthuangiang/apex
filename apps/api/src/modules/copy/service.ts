import {
  copiedLeaders,
  leaderEvents,
  leaderFollows,
  leaderStatsDaily,
  leaderWallets,
  leaderboardRuns,
} from "@drift/db";
import {
  AppError,
  COPY_THIN_MARKET_USD,
  DRIFT_BUILDER_FEE_RATE,
  feeRateToPercent,
  toDecimalString,
  dec,
  ErrorCode,
  FOLLOW_LIMIT,
  FOLLOW_POLL_MS,
  FOLLOW_SYSTEM_LIMIT,
  HIDDEN_REASONS,
  LEADER_STATS,
  meetsMinHold,
  presetFields,
  Strategy,
  type CopyPreview,
  type CopyRequest,
  type CopySlot,
  type FollowAlertLevel,
  type Following,
  type HiddenReason,
  type LeaderEventView,
  type LeaderStats,
  type TraderCard,
  type TraderList,
  type TraderProfile,
  type TraderTab,
} from "@drift/shared";
import { and, count, desc, eq, gte, inArray, lte, or, sql } from "drizzle-orm";
import { getAddress } from "viem";

import {
  account,
  aiDeskOn,
  copyClashes,
  copySlotOf,
  createBot,
  newVersion,
  startBot,
  type BotDeps,
} from "../bots/service";
import { iso } from "../security/service";

// Copy Trading v1 (DEC-163, SCREENS.md 8.x). Chỉ cho tài khoản được bật AI Desk (như S12, DEC-161). Nguồn trader:
// Hyperliquid (DEC-162), thống kê do scheduler tính mỗi đêm; sự kiện vị thế do marketdata ghi (T0 / T1) và lượt đêm.

export interface CopyDeps {
  bots: BotDeps;
  /** Ngưỡng USD cảnh báo big move; null = cảnh báo tắt (OPEN_QUESTIONS 21a). */
  bigMoveMinUsd: string | null;
  /** Volume 24h (quote, USD) của market Perps trên SoDEX; null khi đọc lỗi. Thiếu = không cảnh báo thanh khoản. */
  volume24h?: (market: string) => Promise<string | null>;
}

const SOURCE = "hyperliquid" as const;
const LIST_LIMIT = 60;
const PROFILE_EVENTS = 30;
const FEED_EVENTS = 50;
/** Ví đọc lỗi ở lượt đêm gần nhất giữ thống kê cũ tối đa chừng này ngày. */
const STALE_STATS_DAYS = 7;
/** Ngày UTC `YYYY-MM-DD` lùi `n` ngày. */
const daysBefore = (day: string, n: number): string =>
  new Date(Date.parse(`${day}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);

async function requireDesk(deps: CopyDeps, userId: string): Promise<void> {
  if (!(await aiDeskOn(deps.bots.db, userId)))
    throw new AppError(ErrorCode.forbidden, "AI Desk is not enabled for this account.");
}

/** Lượt đang chạy mới nhất (khi chưa có lượt nào xong, Find traders hiện dần các ví đã tính của lượt này). */
async function runningRun(
  deps: CopyDeps,
): Promise<{ date: string; done: number; total: number } | null> {
  const [r] = await deps.bots.db
    .select({
      date: leaderboardRuns.date,
      computed: leaderboardRuns.computed,
      candidates: leaderboardRuns.candidates,
    })
    .from(leaderboardRuns)
    .where(eq(leaderboardRuns.status, "running"))
    .orderBy(desc(leaderboardRuns.date))
    .limit(1);
  return r === undefined ? null : { date: r.date, done: r.computed ?? 0, total: r.candidates ?? 0 };
}

async function lastOkRun(deps: CopyDeps): Promise<string | null> {
  const [r] = await deps.bots.db
    .select({ date: leaderboardRuns.date })
    .from(leaderboardRuns)
    .where(eq(leaderboardRuns.status, "ok"))
    .orderBy(desc(leaderboardRuns.date))
    .limit(1);
  return r?.date ?? null;
}

const statsView = (s: LeaderStats): TraderCard["stats"] => ({
  profit: s.profit,
  worstDip: s.worstDip,
  typicalHoldMs: s.typicalHoldMs,
  winRate: s.winRate,
  wins: s.wins,
  closedTrades: s.closedEpisodes,
  topTradeShare: s.topTradeShare,
  coverage: s.coverage,
  liquidations: s.liquidations,
  markets: s.markets,
  unlistedCoins: s.unlistedCoins,
  historyIncomplete: s.historyIncomplete,
  fills: s.fills,
});

const HOUR = 3_600_000;

export function tagsOf(s: LeaderStats): TraderCard["tags"] {
  const tags: TraderCard["tags"] = [];
  const hold = s.typicalHoldMs;
  // "Easy to copy" và "Fast trader" (< 1 giờ) không hiện cùng nhau: dưới 1 giờ thì không gắn "Easy to copy".
  if (hold !== null && hold >= HOUR && s.coverage !== null && dec(s.coverage).gte("0.9"))
    tags.push("easy_to_copy");
  if (hold !== null && hold >= 24 * HOUR) tags.push("holds_days");
  else if (hold !== null && hold >= 2 * HOUR) tags.push("holds_hours");
  else if (hold !== null && hold < HOUR) tags.push("fast_trader");
  if (s.coverage !== null)
    tags.push(dec(s.coverage).gte("0.999") ? "all_on_sodex" : "partly_on_sodex");
  if (s.liquidations > 0) tags.push("liquidated");
  if (s.historyIncomplete) tags.push("history_incomplete");
  return tags;
}

async function followsOf(deps: CopyDeps, userId: string): Promise<Set<string>> {
  return new Set((await alertLevelsOf(deps, userId)).keys());
}

/** Trader đang follow → mức cảnh báo (DEC-209). */
async function alertLevelsOf(
  deps: CopyDeps,
  userId: string,
): Promise<Map<string, FollowAlertLevel>> {
  const rows = await deps.bots.db
    .select({ address: leaderFollows.address, level: leaderFollows.alertLevel })
    .from(leaderFollows)
    .where(and(eq(leaderFollows.userId, userId), eq(leaderFollows.source, SOURCE)));
  return new Map(rows.map((r) => [r.address, r.level]));
}

/** Đổi mức cảnh báo cho một trader đang follow (DEC-209). Chưa follow → NOT_FOUND. */
export async function setFollowAlert(
  deps: CopyDeps,
  userId: string,
  address: string,
  level: FollowAlertLevel,
): Promise<{ address: string; alertLevel: FollowAlertLevel }> {
  await requireDesk(deps, userId);
  const changed = await deps.bots.db
    .update(leaderFollows)
    .set({ alertLevel: level })
    .where(
      and(
        eq(leaderFollows.userId, userId),
        eq(leaderFollows.source, SOURCE),
        eq(leaderFollows.address, address),
      ),
    )
    .returning({ address: leaderFollows.address });
  if (changed.length === 0)
    throw new AppError(ErrorCode.notFound, "You don't follow this trader.", {
      reason: "not_following",
    });
  return { address, alertLevel: level };
}

function slotFor(address: string, copied: readonly string[], slots: number): CopySlot {
  if (copied.includes(address)) return "copied";
  return copied.length >= slots ? "full" : "open";
}

const SLOTS = 8;

export async function listTraders(
  deps: CopyDeps,
  userId: string,
  tab: TraderTab,
): Promise<TraderList> {
  await requireDesk(deps, userId);
  const okDay = await lastOkRun(deps);
  // Đã có lượt xong: luôn hiện lượt đó (danh sách ổn định cả khi lượt đêm nay đang chạy). Chưa có: hiện dần lượt đầu.
  const first = okDay === null ? await runningRun(deps) : null;
  const day = okDay ?? first?.date ?? null;
  const empty: TraderList = {
    tab,
    updatedOn: okDay,
    candidates: 0,
    hidden: 0,
    hiddenBy: Object.fromEntries(HIDDEN_REASONS.map((r) => [r, 0])) as TraderList["hiddenBy"],
    items: [],
    checking: first === null ? null : { done: first.done, total: first.total },
  };
  if (day === null) return empty;
  // Ví có trong leaderboard của lượt `day`. Ví đọc lỗi ở lượt đó giữ thống kê gần nhất trong 7 ngày (thẻ ghi ngày
  // tính ở Trader profile), thay vì biến mất khỏi danh sách.
  const all = await deps.bots.db
    .select({ s: leaderStatsDaily, name: leaderWallets.displayName })
    .from(leaderStatsDaily)
    .leftJoin(
      leaderWallets,
      and(
        eq(leaderWallets.source, leaderStatsDaily.source),
        eq(leaderWallets.address, leaderStatsDaily.address),
      ),
    )
    .where(
      and(
        eq(leaderStatsDaily.source, SOURCE),
        lte(leaderStatsDaily.date, day),
        gte(leaderStatsDaily.date, daysBefore(day, STALE_STATS_DAYS)),
        // Tính ở lượt `day`, hoặc có trong leaderboard lượt đó nhưng đọc lỗi (dùng số của ngày trước).
        or(
          eq(leaderStatsDaily.date, day),
          gte(leaderWallets.lastOnLeaderboardAt, new Date(`${day}T00:00:00Z`)),
        ),
      ),
    )
    .orderBy(desc(leaderStatsDaily.date));
  const seen = new Set<string>();
  const rows = all.filter((r) => {
    if (seen.has(r.s.address)) return false;
    seen.add(r.s.address);
    return true;
  });
  const hiddenBy = { ...empty.hiddenBy };
  let hidden = 0;
  for (const r of rows) {
    if (r.s.hidden.length > 0) hidden += 1;
    for (const h of r.s.hidden) if (h in hiddenBy) hiddenBy[h as HiddenReason] += 1;
  }
  // Steady không có trader bị thanh lý trong 30 ngày; lọc cả lúc đọc để snapshot cũ (tính trước luật này) cũng đúng.
  const inTab = rows.filter(
    (r) =>
      r.s.tabs.includes(tab) && (tab !== "steady" || (r.s.stats as LeaderStats).liquidations === 0),
  );
  const key = (r: (typeof rows)[number]): number =>
    tab === "steady"
      ? (r.s.steadyScore ?? 0)
      : tab === "long"
        ? (r.s.typicalHoldMs ?? 0)
        : Number(r.s.profit);
  inTab.sort((a, b) => key(b) - key(a));
  const follows = await followsOf(deps, userId);
  const copied = await copiedLeaders(deps.bots.db, SOURCE);
  return {
    ...empty,
    candidates: rows.length,
    hidden,
    hiddenBy,
    items: inTab.slice(0, LIST_LIMIT).map((r) => {
      const stats = r.s.stats as LeaderStats;
      return {
        address: r.s.address,
        displayName: r.name ?? null,
        stats: statsView(stats),
        curve: stats.dailyCurve,
        tags: tagsOf(stats),
        slot: slotFor(r.s.address, copied, SLOTS),
        following: follows.has(r.s.address),
      };
    }),
  };
}

function eventView(e: typeof leaderEvents.$inferSelect): LeaderEventView {
  const after = dec(e.positionAfter);
  // Đóng hết: chiều của vị thế vừa đóng ("Closed short"); còn lại: chiều của vị thế sau sự kiện.
  const ref = after.isZero() ? dec(e.positionBefore) : after;
  return {
    address: e.address,
    coin: e.coin,
    market: e.market,
    kind: e.kind,
    side: ref.isZero() ? null : ref.isNegative() ? "short" : "long",
    positionAfter: after.toString(),
    notional: dec(e.notional).toString(),
    positionNotional: after.abs().mul(dec(e.price)).toDecimalPlaces(2).toString(),
    price: dec(e.price).toString(),
    realized: e.realized === null ? null : dec(e.realized).toString(),
    at: iso(e.at),
    // Sự kiện của lượt đêm có `seenAt` muộn hàng giờ: không phải độ trễ của theo dõi realtime.
    seenAfterMs:
      e.seenAt.getTime() - e.at.getTime() > 30 * 60_000
        ? null
        : e.seenAt.getTime() - e.at.getTime(),
  };
}

async function latestStats(deps: CopyDeps, address: string) {
  const [row] = await deps.bots.db
    .select({ s: leaderStatsDaily, name: leaderWallets.displayName })
    .from(leaderStatsDaily)
    .leftJoin(
      leaderWallets,
      and(
        eq(leaderWallets.source, leaderStatsDaily.source),
        eq(leaderWallets.address, leaderStatsDaily.address),
      ),
    )
    .where(and(eq(leaderStatsDaily.source, SOURCE), eq(leaderStatsDaily.address, address)))
    .orderBy(desc(leaderStatsDaily.date))
    .limit(1);
  return row;
}

/**
 * Thống kê của trader trong cùng snapshot với danh sách (lượt leaderboard xong gần nhất), để số trên hồ sơ khớp thẻ
 * (báo cáo test A4). Chưa có lượt xong, hay trader chỉ có số mới hơn lượt đó: dùng số gần nhất.
 */
async function snapshotStats(deps: CopyDeps, address: string) {
  const okDay = await lastOkRun(deps);
  if (okDay !== null) {
    const [row] = await deps.bots.db
      .select({ s: leaderStatsDaily, name: leaderWallets.displayName })
      .from(leaderStatsDaily)
      .leftJoin(
        leaderWallets,
        and(
          eq(leaderWallets.source, leaderStatsDaily.source),
          eq(leaderWallets.address, leaderStatsDaily.address),
        ),
      )
      .where(
        and(
          eq(leaderStatsDaily.source, SOURCE),
          eq(leaderStatsDaily.address, address),
          lte(leaderStatsDaily.date, okDay),
        ),
      )
      .orderBy(desc(leaderStatsDaily.date))
      .limit(1);
    if (row !== undefined) return row;
  }
  return latestStats(deps, address);
}

/** Phần notional 7 ngày qua ở market SoDEX không có (> 50% → "Most of their recent trades can't be copied"). */
export const RECENT_UNLISTED = { days: 7, share: "0.5" } as const;

async function recentUnlisted(
  deps: CopyDeps,
  address: string,
): Promise<{ share: string; coins: string[] } | null> {
  const since = new Date(deps.bots.now().getTime() - RECENT_UNLISTED.days * 86_400_000);
  const rows = await deps.bots.db
    .select({
      coin: leaderEvents.coin,
      listed: sql<boolean>`${leaderEvents.market} is not null`,
      notional: sql<string>`sum(${leaderEvents.notional})::text`,
    })
    .from(leaderEvents)
    .where(
      and(
        eq(leaderEvents.source, SOURCE),
        eq(leaderEvents.address, address),
        gte(leaderEvents.at, since),
      ),
    )
    .groupBy(leaderEvents.coin, sql`${leaderEvents.market} is not null`);
  const total = rows.reduce((x, r) => x.add(r.notional), dec("0"));
  if (total.isZero()) return null;
  const off = rows.filter((r) => !r.listed);
  const share = off.reduce((x, r) => x.add(r.notional), dec("0")).div(total);
  if (!share.gt(RECENT_UNLISTED.share)) return null;
  return {
    share: share.toDecimalPlaces(4).toString(),
    coins: [...new Set(off.map((r) => r.coin))],
  };
}

function copyableOf(stats: LeaderStats | undefined): TraderProfile["copyable"] {
  if (stats === undefined) return { ok: false, reason: "no_stats" };
  if (!meetsMinHold(stats)) return { ok: false, reason: "min_hold" };
  if (stats.markets.length === 0) return { ok: false, reason: "no_markets" };
  return { ok: true, reason: null };
}

export async function traderProfile(
  deps: CopyDeps,
  userId: string,
  address: string,
): Promise<TraderProfile> {
  await requireDesk(deps, userId);
  const row = await snapshotStats(deps, address);
  if (row === undefined) throw new AppError(ErrorCode.notFound, "Trader not found.");
  const stats = row.s.stats as LeaderStats;
  const events = await deps.bots.db
    .select()
    .from(leaderEvents)
    .where(and(eq(leaderEvents.source, SOURCE), eq(leaderEvents.address, address)))
    .orderBy(desc(leaderEvents.at))
    .limit(PROFILE_EVENTS);
  // Vị thế đang mở theo sự kiện gần nhất của từng coin (sẽ không được copy, DEC-161).
  const lastByCoin = new Map<string, typeof leaderEvents.$inferSelect>();
  for (const e of events) if (!lastByCoin.has(e.coin)) lastByCoin.set(e.coin, e);
  const openPositions = [...lastByCoin.values()]
    .filter((e) => !dec(e.positionAfter).isZero())
    .map((e) => ({
      market: e.market,
      coin: e.coin,
      side: dec(e.positionAfter).isNegative() ? ("short" as const) : ("long" as const),
    }));
  const hold = stats.typicalHoldMs;
  const fit: TraderProfile["fit"] = [];
  if (hold !== null)
    fit.push({
      item: hold >= LEADER_STATS.minHoldMs ? "holds_long" : "holds_short",
      ok: hold >= LEADER_STATS.minHoldMs,
      data: { holdMs: String(hold) },
    });
  if (stats.coverage !== null)
    fit.push(
      stats.unlistedCoins.length === 0
        ? {
            item: "all_listed",
            ok: true,
            data: { markets: stats.markets.map((m) => m.split("-")[0] ?? m).join(", ") },
          }
        : {
            item: "some_unlisted",
            ok: false,
            data: { coins: stats.unlistedCoins.join(", "), coverage: stats.coverage },
          },
    );
  if (stats.topTradeShare !== null)
    fit.push(
      dec(stats.topTradeShare).lte(LEADER_STATS.maxTopShare)
        ? { item: "spread_profit", ok: true, data: { share: stats.topTradeShare } }
        : { item: "concentrated_profit", ok: false, data: { share: stats.topTradeShare } },
    );
  fit.push(
    stats.liquidations === 0
      ? { item: "no_liquidations", ok: true, data: {} }
      : { item: "liquidations", ok: false, data: { count: String(stats.liquidations) } },
  );
  const recent = await recentUnlisted(deps, address);
  if (recent !== null)
    fit.push({
      item: "recent_unlisted",
      ok: false,
      data: { share: recent.share, coins: recent.coins.join(", ") },
    });
  const levels = await alertLevelsOf(deps, userId);
  const copied = await copiedLeaders(deps.bots.db, SOURCE);
  return {
    card: {
      address,
      displayName: row.name ?? null,
      stats: statsView(stats),
      curve: stats.dailyCurve,
      tags: tagsOf(stats),
      slot: slotFor(address, copied, SLOTS),
      following: levels.has(address),
    },
    followAlertLevel: levels.get(address) ?? null,
    hidden: row.s.hidden.filter((h): h is HiddenReason =>
      (HIDDEN_REASONS as readonly string[]).includes(h),
    ),
    updatedOn: row.s.date,
    computedAt: iso(row.s.computedAt),
    fit,
    events: events.map(eventView),
    openPositions,
    copyable: copyableOf(stats),
  };
}

export async function follow(
  deps: CopyDeps,
  userId: string,
  address: string,
): Promise<{ following: true }> {
  await requireDesk(deps, userId);
  const db = deps.bots.db;
  const mine = await followsOf(deps, userId);
  if (mine.has(address)) return { following: true };
  if (mine.size >= FOLLOW_LIMIT)
    throw new AppError(
      ErrorCode.stateConflict,
      `You can follow up to ${String(FOLLOW_LIMIT)} traders.`,
      {
        reason: "follow_limit",
      },
    );
  if ((await latestStats(deps, address)) === undefined)
    throw new AppError(ErrorCode.notFound, "Trader not found.");
  const [{ n } = { n: 0 }] = await db
    .select({ n: sql<number>`count(distinct ${leaderFollows.address})::int` })
    .from(leaderFollows)
    .where(eq(leaderFollows.source, SOURCE));
  const already = await db
    .select({ n: count() })
    .from(leaderFollows)
    .where(and(eq(leaderFollows.source, SOURCE), eq(leaderFollows.address, address)));
  if ((already[0]?.n ?? 0) === 0 && n >= FOLLOW_SYSTEM_LIMIT)
    throw new AppError(ErrorCode.stateConflict, "Following is full right now. Try again later.", {
      reason: "system_limit",
    });
  await db.insert(leaderFollows).values({ userId, source: SOURCE, address }).onConflictDoNothing();
  return { following: true };
}

export async function unfollow(
  deps: CopyDeps,
  userId: string,
  address: string,
): Promise<{ following: false }> {
  await requireDesk(deps, userId);
  await deps.bots.db
    .delete(leaderFollows)
    .where(
      and(
        eq(leaderFollows.userId, userId),
        eq(leaderFollows.source, SOURCE),
        eq(leaderFollows.address, address),
      ),
    );
  return { following: false };
}

export async function following(deps: CopyDeps, userId: string): Promise<Following> {
  await requireDesk(deps, userId);
  const db = deps.bots.db;
  const levels = await alertLevelsOf(deps, userId);
  const addresses = [...levels.keys()];
  const copied = await copiedLeaders(db, SOURCE);
  const names =
    addresses.length === 0
      ? []
      : await db
          .select({ address: leaderWallets.address, name: leaderWallets.displayName })
          .from(leaderWallets)
          .where(and(eq(leaderWallets.source, SOURCE), inArray(leaderWallets.address, addresses)));
  const events =
    addresses.length === 0
      ? []
      : await db
          .select()
          .from(leaderEvents)
          .where(and(eq(leaderEvents.source, SOURCE), inArray(leaderEvents.address, addresses)))
          .orderBy(desc(leaderEvents.at))
          .limit(FEED_EVENTS);
  // Market mới: trader có sự kiện mở ở market SoDEX mà bot copy của người dùng chưa theo.
  const myCopies = await db.execute<{ address: string; markets: unknown }>(sql`
    select lower(bv.config->>'leaderAddress') as address, bv.config->'markets' as markets
    from bots b join bot_versions bv on bv.id = b.active_version_id
    where b.user_id = ${userId} and b.strategy = ${Strategy.copyTrade}
      and b.state in ('starting','running','pausing','paused','resuming')`);
  const copyMarkets = new Map<string, Set<string>>();
  for (const r of myCopies.rows)
    copyMarkets.set(
      r.address,
      new Set(
        Array.isArray(r.markets) ? r.markets.filter((m): m is string => typeof m === "string") : [],
      ),
    );
  return {
    limit: FOLLOW_LIMIT,
    checkedEveryMs: FOLLOW_POLL_MS,
    bigMoveAlerts: deps.bigMoveMinUsd !== null,
    bigMoveMinUsd: deps.bigMoveMinUsd,
    traders: addresses.map((address) => {
      const mine = events.filter((e) => e.address === address);
      const held = copyMarkets.get(address);
      const newMarkets =
        held === undefined
          ? []
          : [
              ...new Set(
                mine
                  .filter(
                    (e) =>
                      (e.kind === "open" || e.kind === "flip") &&
                      e.market !== null &&
                      !held.has(e.market),
                  )
                  .flatMap((e) => (e.market === null ? [] : [e.market])),
              ),
            ];
      return {
        address,
        displayName: names.find((n) => n.address === address)?.name ?? null,
        lastEventAt: mine[0] === undefined ? null : iso(mine[0].at),
        copying: copied.includes(address) && held !== undefined,
        newMarkets,
        alertLevel: levels.get(address) ?? "big_moves",
      };
    }),
    events: events.map(eventView),
  };
}

/** Budget + mức an toàn → config S12, market giữ / bỏ (DEC-163 mục 6, 7). Server tính, không tin client. */
export async function copyPreview(
  deps: CopyDeps,
  userId: string,
  req: CopyRequest,
): Promise<CopyPreview> {
  await requireDesk(deps, userId);
  const a = await account(deps.bots.db, userId);
  const row = await latestStats(deps, req.address);
  const stats = row?.s.stats as LeaderStats | undefined;
  const fields = presetFields(req.budget, req.preset);
  const symbols = await deps.bots.rest.getPerpsSymbols();
  const dropped: CopyPreview["dropped"] = [];
  const wanted = stats?.markets ?? [];
  const clashes = await copyClashes(deps.bots, a.id, Strategy.copyTrade, wanted, null);
  const markets: string[] = [];
  for (const m of wanted) {
    const clash = clashes.find((c) => c.market === m);
    const sym = symbols.find((x) => x.name === m);
    if (clash !== undefined)
      dropped.push({ market: m, reason: "bot", botId: clash.botId, botName: clash.botName });
    else if (sym?.status !== "TRADING")
      dropped.push({ market: m, reason: "unavailable", botId: null, botName: null });
    else if (sym.maxLeverage < fields.leverage)
      dropped.push({ market: m, reason: "leverage", botId: null, botName: null });
    else if (dec(fields.fixedNotional).lt(dec(sym.minNotional)))
      dropped.push({ market: m, reason: "min_size", botId: null, botName: null });
    else markets.push(m);
  }
  const config: Record<string, unknown> = {
    leaderSource: SOURCE,
    leaderAddress: req.address,
    markets,
    marginMode: req.marginMode,
    direction: req.direction,
    ...fields,
    ...(req.maxSlippagePct === undefined ? {} : { maxSlippagePct: req.maxSlippagePct }),
    ...(req.takeProfitPct === undefined ? {} : { takeProfitPct: req.takeProfitPct }),
  };
  let available: string | null = null;
  try {
    const st = await deps.bots.rest.getPerpsAccountState(getAddress(a.address));
    available = req.marginMode === "isolated" ? st.ami : st.am;
  } catch {
    available = null;
  }
  const copyable = copyableOf(stats);
  // Market mỏng trên SoDEX: chỉ cảnh báo khi đọc được volume (đọc lỗi → không cảnh báo, không đoán).
  const thinMarkets: string[] = [];
  if (deps.volume24h !== undefined)
    for (const m of markets) {
      const v = await deps.volume24h(m).catch(() => null);
      if (v !== null && dec(v).lt(COPY_THIN_MARKET_USD)) thinMarkets.push(m);
    }
  return {
    thinMarkets,
    address: req.address,
    config,
    markets,
    dropped,
    slot: await copySlotOf(deps.bots.db, req.address),
    copyable: copyable.ok && markets.length === 0 ? { ok: false, reason: "no_markets" } : copyable,
    // Approve cố định 0.01% (DEC-46); mức gắn vào lệnh ≤ mức này (DEC-94, DEC-159).
    builderFeeMax: toDecimalString(feeRateToPercent(DRIFT_BUILDER_FEE_RATE)),
    available,
  };
}

/** Bot copy còn ở draft của user cho đúng trader và đúng danh sách market (market bị khoá sau khi tạo, DEC-169). */
async function draftCopyBot(
  deps: CopyDeps,
  userId: string,
  address: string,
  markets: readonly string[],
): Promise<string | null> {
  const r = await deps.bots.db.execute<{ id: string; markets: unknown }>(sql`
    select b.id, bv.config->'markets' as markets
    from bots b join bot_versions bv on bv.id = b.active_version_id
    where b.user_id = ${userId} and b.strategy = ${Strategy.copyTrade} and b.state = 'draft'
      and lower(bv.config->>'leaderAddress') = ${address.toLowerCase()}
    order by b.created_at desc`);
  const want = [...markets].sort().join();
  const hit = r.rows.find(
    (x) =>
      Array.isArray(x.markets) &&
      x.markets
        .filter((m): m is string => typeof m === "string")
        .sort()
        .join() === want,
  );
  return hit?.id ?? null;
}

/** Tạo bot copy từ Review rồi chạy ngay (2FA nếu đã bật, xác nhận rủi ro), dùng luồng Start chung. */
export async function startCopy(
  deps: CopyDeps,
  userId: string,
  req: CopyRequest & { acknowledged: true; twoFactorCode?: string | undefined },
  ip: string | null,
  sessionId?: string,
) {
  const p = await copyPreview(deps, userId, req);
  // Hết chỗ copy realtime là điều kiện chung của hệ thống: báo trước lý do riêng của account.
  if (p.slot === "full")
    throw new AppError(
      ErrorCode.stateConflict,
      "All copy slots are taken. Follow this trader and copy later.",
      { reason: "slots_full" },
    );
  if (!p.copyable.ok)
    throw new AppError(ErrorCode.validationFailed, "This trader can't be copied right now.", {
      reason: p.copyable.reason,
    });
  // Start lỗi (sai 2FA, builder fee, start checks) để lại bot draft. Bấm lại thì dùng lại draft đó (version mới)
  // thay vì tạo thêm bot "Copy 0x…" mỗi lần.
  const reuse = await draftCopyBot(deps, userId, req.address, p.markets);
  let botId: string;
  if (reuse === null) {
    const name = `Copy ${req.address.slice(0, 6)}…${req.address.slice(-4)}`;
    botId = (
      await createBot(
        deps.bots,
        userId,
        { strategy: Strategy.copyTrade, name, config: p.config, paramSource: "manual" },
        ip,
      )
    ).id;
  } else {
    await newVersion(deps.bots, userId, reuse, { config: p.config, paramSource: "manual" });
    botId = reuse;
  }
  return startBot(
    deps.bots,
    userId,
    botId,
    { acknowledged: true, twoFactorCode: req.twoFactorCode },
    ip,
    sessionId,
  );
}

import {
  botEvents,
  botRuntime,
  bots,
  botVersions,
  builderApprovals,
  builderBalanceSnapshots,
  builderRevenueDaily,
  connectEvents,
  equitySnapshots,
  fills,
  notifications,
  notificationSettings,
  orders,
  outbox,
  riskAlerts,
  riskLimits,
  sessions,
  sodexAccounts,
  sodexSignatureRequests,
  users,
  type Db,
} from "@drift/db";
import {
  ALWAYS_ON_GROUPS,
  analyze,
  AppError,
  applyCommand,
  BotCommand,
  BotState,
  byTime,
  change24hPct,
  dec,
  Decimal,
  isBuilderFeeApproved,
  ErrorCode,
  evaluateRisk,
  NOTIFICATION_DEFAULTS,
  NOTIFICATION_GROUPS,
  ReasonCode,
  SYSTEM_GROUPS,
  TEAM_ONLY_GROUPS,
  UserRole,
  TELEGRAM_ONLY_GROUPS,
  RISK_ENFORCED,
  startOfDay,
  valuePortfolio,
  isBuilderAccount,
  VOLUME_STRATEGIES,
  Strategy,
  CONNECT_EVENT_TYPES,
  type AdminUserDetail,
  type AdminUsersView,
  type AdminAdaptiveDca,
  type AdminAiDesk,
  type AnalystBot,
  type AdminVolumeBots,
  type AnalystView,
  type BuilderRevenueView,
  type NotificationChannel,
  type NotificationGroup,
  type OverviewView,
  type PlatformStats,
  type PortfolioView,
  type RiskLimitKey,
  type RiskView,
} from "@drift/shared";
import type { SodexRestClient } from "@drift/sodex";
import { copyLedgerTotals, isMultiMarketCopyState } from "@drift/strategies";
import { and, asc, count, desc, eq, gte, ilike, inArray, isNull, sql } from "drizzle-orm";
import { getAddress } from "viem";

import { AuditAction, audit } from "../../lib/audit";
import { listBots, type BotDeps } from "../bots/service";
import { iso } from "../security/service";
import type { TwoFactorDeps } from "../security/two-factor";

import { builderFeeRows } from "./builder-fees";
import { mcpStats } from "./mcp-stats";
import { statsOverview } from "./stats-overview";
import { requireTeam } from "./team";
import { getWatchlist } from "./watchlist";

// Overview / Portfolio / Risk Center / AI Analyst / Notifications / Builder Revenue (P10, DEC-41).
// Số liệu tài khoản đọc trực tiếp từ SoDEX (chỉ đọc); giá lấy từ Redis `md:last:<market>` (marketdata).

export interface AccountDeps extends TwoFactorDeps {
  rest: Pick<
    SodexRestClient,
    | "getSpotBalances"
    | "getPerpsAccountState"
    | "getPositionsHistory"
    | "getMarkPrices"
    | "getKlines"
    | "getSpotSymbols"
    | "getPerpsSymbols"
  >;
  prices: (markets: readonly string[]) => Promise<Record<string, string>>;
  bots: BotDeps;
  builderId: bigint;
  /** Account builder được miễn builder fee (DEC-47); false = thu như mọi account (DEC-124). Thiếu = true. */
  builderExempt?: boolean | undefined;
}

/**
 * Lệnh của bot thật (DEC-105): mọi số liệu tiền thật (Portfolio, Risk, Home, Users) bỏ lệnh của bot paper. Fill
 * paper nằm ở bảng riêng `paper_fills` nên các tổng theo `fills` (volume, builder fee) vốn đã sạch.
 */
const LIVE_ORDER = sql`exists (select 1 from bots lb where lb.id = ${orders.botId} and lb.mode = 'live')`;

async function connected(db: Db, userId: string) {
  const [a] = await db
    .select()
    .from(sodexAccounts)
    .where(and(eq(sodexAccounts.userId, userId), eq(sodexAccounts.status, "connected")))
    .orderBy(desc(sodexAccounts.createdAt))
    .limit(1);
  return a ?? null;
}

const ACTIVE: readonly BotState[] = [
  BotState.running,
  BotState.starting,
  BotState.resuming,
  BotState.pausing,
];

/**
 * Kết quả đọc account từ SoDEX được dùng lại trong 10 s cho mọi màn (Overview, Portfolio, Risk, Analyst đều gọi)
 * để polling của UI không tiêu hết hạn mức REST chung trên IP egress (1200 weight/phút).
 */
const PORTFOLIO_TTL_MS = 10_000;
const portfolioCache = new Map<string, { at: number; value: PortfolioView }>();

export async function portfolio(deps: AccountDeps, userId: string): Promise<PortfolioView | null> {
  const a = await connected(deps.db, userId);
  if (a === null) return null;
  const hit = portfolioCache.get(a.id);
  if (hit !== undefined && deps.now().getTime() - hit.at < PORTFOLIO_TTL_MS) return hit.value;
  const address = getAddress(a.address);
  const [spot, perps] = await Promise.all([
    deps.rest.getSpotBalances(address, a.sodexAccountId),
    deps.rest.getPerpsAccountState(address),
  ]);
  const markets = [
    ...spot.map((b) => `${b.coin.startsWith("v") ? b.coin : `v${b.coin}`}_vUSDC`),
    ...perps.P.map((p) => p.s),
  ];
  const v = valuePortfolio(spot, perps, await deps.prices(markets));
  const [open] = await deps.db
    .select({ n: sql<number>`count(*)::int` })
    .from(orders)
    .where(
      and(
        eq(orders.sodexAccountId, a.id),
        inArray(orders.status, ["open", "partially_filled"]),
        LIVE_ORDER,
      ),
    );
  const lockedQuote = spot.find((b) => b.coin === "vUSDC")?.locked ?? "0";
  const value: PortfolioView = {
    ...v,
    updatedAt: deps.now().toISOString(),
    pendingOrders: { count: open?.n ?? 0, lockedQuote: dec(lockedQuote).toString() },
  };
  portfolioCache.set(a.id, { at: deps.now().getTime(), value });
  return value;
}

async function snapshots(db: Db, accountId: string, since: number) {
  const rows = await db
    .select({ at: equitySnapshots.at, equity: equitySnapshots.equity })
    .from(equitySnapshots)
    .where(
      and(eq(equitySnapshots.sodexAccountId, accountId), gte(equitySnapshots.at, new Date(since))),
    )
    .orderBy(asc(equitySnapshots.at));
  return rows.map((r) => ({ at: r.at.getTime(), equity: r.equity }));
}

async function limitsOf(db: Db, accountId: string) {
  const [l] = await db
    .select()
    .from(riskLimits)
    .where(eq(riskLimits.sodexAccountId, accountId))
    .limit(1);
  return {
    dailyLossPct: l?.dailyLossPct ?? null,
    maxDrawdownPct: l?.maxDrawdownPct ?? null,
    perTradePct: l?.perTradePct ?? null,
    maxLeverage: l?.maxLeverage ?? null,
    maxPositions: l?.maxPositions ?? null,
  };
}

const norm = (v: string | null) => (v === null ? null : dec(v).toString());

/** Trạng thái rủi ro của Risk Center (đỉnh equity 30 ngày, equity hiện tại…); dùng chung cho thẻ Mục tiêu AI Desk. */
export async function riskStatusOf(deps: { db: Db; now: () => Date }, userId: string) {
  const a = await connected(deps.db, userId);
  if (a === null) return null;
  const [u] = await deps.db
    .select({ tz: users.timezone })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  const tz = u?.tz ?? "UTC";
  const now = deps.now().getTime();
  const l = await limitsOf(deps.db, a.id);
  const points = await snapshots(deps.db, a.id, now - 31 * 86_400_000);
  return { a, tz, now, l, points, status: evaluateRisk(l, points, now, tz) };
}

export async function risk(deps: AccountDeps, userId: string): Promise<RiskView | null> {
  const r = await riskStatusOf(deps, userId);
  if (r === null) return null;
  const { a, tz, now, l, points, status } = r;
  let pf: PortfolioView | null = null;
  try {
    pf = await portfolio(deps, userId);
  } catch {
    pf = null;
  }
  const highest =
    pf?.positions.reduce<{ market: string; leverage: number } | null>(
      (m, p) =>
        m === null || p.leverage > m.leverage ? { market: p.market, leverage: p.leverage } : m,
      null,
    ) ?? null;
  const today = startOfDay(now, tz);
  const todays = await deps.db
    .select({ price: orders.price, size: orders.size })
    .from(orders)
    .where(
      and(eq(orders.sodexAccountId, a.id), gte(orders.createdAt, new Date(today)), LIVE_ORDER),
    );
  const largest = todays.reduce(
    (m, o) => (o.price === null ? m : Decimal.max(m, dec(o.price).mul(o.size))),
    new Decimal(0),
  );
  const alerts = await deps.db
    .select()
    .from(riskAlerts)
    .where(eq(riskAlerts.sodexAccountId, a.id))
    .orderBy(desc(riskAlerts.occurredAt))
    .limit(20);
  const counts = await deps.db
    .select({ state: bots.state, n: sql<number>`count(*)::int` })
    .from(bots)
    .where(and(eq(bots.sodexAccountId, a.id), eq(bots.mode, "live")))
    .groupBy(bots.state);
  const [open] = await deps.db
    .select({ n: sql<number>`count(*)::int` })
    .from(orders)
    .where(
      and(
        eq(orders.sodexAccountId, a.id),
        inArray(orders.status, ["open", "partially_filled"]),
        LIVE_ORDER,
      ),
    );
  return {
    checkedAt: points.length === 0 ? null : new Date(points.at(-1)?.at ?? now).toISOString(),
    limits: {
      dailyLossPct: norm(l.dailyLossPct),
      maxDrawdownPct: norm(l.maxDrawdownPct),
      perTradePct: norm(l.perTradePct),
      maxLeverage: norm(l.maxLeverage),
      maxPositions: l.maxPositions,
    },
    enforced: { ...RISK_ENFORCED },
    status: {
      dailyLossPct: status.dailyLossPct,
      drawdownPct: status.drawdownPct,
      peakEquity: status.peakEquity,
      peakAt: status.peakAt,
      equity: status.equity,
      highestLeverage: highest,
      openPositions: pf === null ? null : pf.positions.length,
      largestOrderTodayPct:
        status.equity === null || !dec(status.equity).gt(0) || largest.isZero()
          ? null
          : largest.div(status.equity).mul(100).toDecimalPlaces(4).toString(),
    },
    alerts: alerts.map((x) => ({
      id: x.id,
      kind: x.kind,
      severity: x.severity,
      data: x.data as Record<string, unknown>,
      occurredAt: iso(x.occurredAt),
      acknowledgedAt: x.acknowledgedAt === null ? null : iso(x.acknowledgedAt),
      resolvedAt: x.resolvedAt === null ? null : iso(x.resolvedAt),
    })),
    halt: {
      running: counts.filter((c) => ACTIVE.includes(c.state)).reduce((s, c) => s + c.n, 0),
      paused: counts.find((c) => c.state === BotState.paused)?.n ?? 0,
      openOrders: open?.n ?? 0,
      positions: pf === null ? null : pf.positions.length,
    },
  };
}

const COLUMN: Record<
  RiskLimitKey,
  "dailyLossPct" | "maxDrawdownPct" | "perTradePct" | "maxLeverage" | "maxPositions"
> = {
  dailyLossPct: "dailyLossPct",
  maxDrawdownPct: "maxDrawdownPct",
  perTradePct: "perTradePct",
  maxLeverage: "maxLeverage",
  maxPositions: "maxPositions",
};

export async function setLimit(
  deps: AccountDeps,
  userId: string,
  key: RiskLimitKey,
  value: string | null,
  ip: string | null,
): Promise<void> {
  const a = await connected(deps.db, userId);
  if (a === null) throw new AppError(ErrorCode.notFound, "No SoDEX account connected.");
  if (value !== null && !dec(value).gt(0))
    throw new AppError(ErrorCode.validationFailed, "Must be above 0.", {
      fieldErrors: { value: ["Must be above 0."] },
    });
  if (value !== null && key.endsWith("Pct") && dec(value).gt(100))
    throw new AppError(ErrorCode.validationFailed, "Allowed up to 100%.", {
      fieldErrors: { value: ["Allowed up to 100%."] },
    });
  const col = COLUMN[key];
  const v = col === "maxPositions" ? (value === null ? null : Math.floor(Number(value))) : value;
  await deps.db
    .insert(riskLimits)
    .values({ sodexAccountId: a.id, [col]: v, enforced: RISK_ENFORCED })
    .onConflictDoUpdate({
      target: riskLimits.sodexAccountId,
      set: { [col]: v, enforced: RISK_ENFORCED, updatedAt: new Date() },
    });
  await audit(deps.db, { userId, action: AuditAction.riskLimitChanged, target: key, ip });
}

export async function ackAlert(deps: AccountDeps, userId: string, alertId: string): Promise<void> {
  const a = await connected(deps.db, userId);
  if (a === null) throw new AppError(ErrorCode.notFound, "Alert not found.");
  const r = await deps.db
    .update(riskAlerts)
    .set({ acknowledgedAt: deps.now() })
    .where(
      and(
        eq(riskAlerts.id, alertId),
        eq(riskAlerts.sodexAccountId, a.id),
        isNull(riskAlerts.acknowledgedAt),
      ),
    )
    .returning({ id: riskAlerts.id });
  if (r.length === 0) throw new AppError(ErrorCode.notFound, "Alert not found.");
}

/**
 * Emergency halt: mọi bot đang chạy / tạm dừng chuyển `stopping` (huỷ lệnh, không đóng vị thế). Không hỏi 2FA vì
 * chỉ giảm rủi ro, khách phải dừng được ngay (DEC-115).
 */
export async function halt(
  deps: AccountDeps,
  userId: string,
  ip: string | null,
): Promise<{ stopping: number }> {
  const a = await connected(deps.db, userId);
  if (a === null) throw new AppError(ErrorCode.notFound, "No SoDEX account connected.");
  const n = await deps.db.transaction(async (tx) => {
    const list = await tx.select().from(bots).where(eq(bots.sodexAccountId, a.id)).for("update");
    let count = 0;
    for (const b of list) {
      const next = applyCommand(b.state, BotCommand.stop);
      if (next === null) continue;
      await tx
        .update(bots)
        .set({ state: next, reasonCode: ReasonCode.emergencyHalt })
        .where(eq(bots.id, b.id));
      await tx.insert(outbox).values({
        topic: `user.${a.id}.bot`,
        payload: { botId: b.id, state: next, reasonCode: ReasonCode.emergencyHalt },
      });
      count += 1;
    }
    return count;
  });
  await audit(deps.db, { userId, action: AuditAction.emergencyHalt, target: a.id, ip });
  return { stopping: n };
}

const REALIZED_LIMIT = 1000;

export async function overview(
  deps: AccountDeps,
  userId: string,
  /** null = All: từ snapshot đầu tiên. */
  periodDays: number | null,
): Promise<OverviewView> {
  const a = await connected(deps.db, userId);
  const now = deps.now().getTime();
  const since = periodDays === null ? 0 : now - periodDays * 86_400_000;
  const botList = await listBots(deps.bots, userId);
  const empty: OverviewView = {
    portfolio: null,
    equityCurve: [],
    realizedPnl: null,
    realizedSince: since,
    risk: null,
    bots: botList,
    activity: [],
    watchlist: [],
  };
  if (a === null) return empty;
  let pf: PortfolioView | null = null;
  try {
    pf = await portfolio(deps, userId);
  } catch {
    pf = null;
  }
  const points = await snapshots(deps.db, a.id, since);
  const step = Math.max(1, Math.ceil(points.length / 200));
  const curve = points.filter((_, i) => i % step === 0 || i === points.length - 1);
  let realized: string | null = null;
  try {
    const closed = await deps.rest.getPositionsHistory(getAddress(a.address), {
      startTime: since,
      limit: REALIZED_LIMIT,
    });
    // Chạm giới hạn 1000 dòng thì tổng có thể thiếu: trả null thay vì một con số sai (quy tắc 1.8).
    realized =
      closed.length >= REALIZED_LIMIT
        ? null
        : closed
            .filter((p) => p.updatedAt >= since)
            .reduce((s, p) => s.add(p.realizedPnL), new Decimal(0))
            .toString();
  } catch {
    realized = null;
  }
  const r = await risk(deps, userId).catch(() => null);
  const ev = await deps.db
    .select({ e: botEvents, name: bots.name })
    .from(botEvents)
    .innerJoin(bots, eq(bots.id, botEvents.botId))
    .where(and(eq(bots.userId, userId), eq(bots.mode, "live")))
    .orderBy(desc(botEvents.occurredAt))
    .limit(8);
  const watch = await getWatchlist(deps, userId).catch(() => []);
  let marks: Record<string, string> = {};
  try {
    marks = Object.fromEntries(
      (await deps.rest.getMarkPrices()).map((m) => [m.symbol, m.markPrice]),
    );
  } catch {
    marks = {};
  }
  // Spot không có mark price: dùng giá gần nhất của marketdata (`md:last:*`).
  const spotLast = await deps
    .prices(watch.filter((w) => w.engine === "spot").map((w) => w.market))
    .catch((): Record<string, string> => ({}));
  const watchlist = await Promise.all(
    watch.map(async ({ market: m, engine }) => {
      const price = (engine === "perps" ? marks[m] : spotLast[m]) ?? null;
      let change: string | null = null;
      let spark: string[] = [];
      if (price !== null) {
        try {
          // 24 nến 1h trong một request. SoDEX trả mới nhất trước: % 24h tính từ nến cũ nhất, sparkline theo thời
          // gian tăng dần (trước đây lấy `k[0]` nên thực tế là % của khoảng một giờ).
          const k = byTime(
            await deps.rest.getKlines(engine, m, {
              interval: "1h",
              startTime: now - 24 * 3_600_000,
              endTime: now,
              limit: 24,
            }),
          );
          spark = k.map((c) => c.c);
          change = change24hPct(price, k);
        } catch {
          change = null;
        }
      }
      return { market: m, engine, price, change24hPct: change, spark };
    }),
  );
  return {
    portfolio: pf,
    equityCurve: curve,
    realizedPnl: realized,
    realizedSince: since,
    risk:
      r === null
        ? null
        : {
            ...r.status,
            limits: r.limits,
            breached: [
              r.status.dailyLossPct !== null &&
                r.limits.dailyLossPct !== null &&
                dec(r.status.dailyLossPct).gte(r.limits.dailyLossPct),
              r.status.drawdownPct !== null &&
                r.limits.maxDrawdownPct !== null &&
                dec(r.status.drawdownPct).gte(r.limits.maxDrawdownPct),
            ].filter(Boolean).length,
          },
    bots: botList,
    activity: ev.map(({ e, name }) => ({
      id: e.id,
      botId: e.botId,
      botName: name,
      type: e.type,
      decision: e.decision,
      why: e.why,
      occurredAt: iso(e.occurredAt),
    })),
    // Không lọc market thiếu giá: dòng vẫn hiện "Not available" (UI_REVIEW M2).
    watchlist,
  };
}

/**
 * Bot thật của người dùng cho quy tắc AI Analyst (DEC-41) và AI Desk › Your bots (DEC-105): lãi ròng, phí, số lần
 * khớp theo sổ cái của engine. Không gồm bot paper, draft hay đã archive.
 */
export async function analystBots(db: Db, userId: string): Promise<AnalystBot[]> {
  const list = await db
    .select({ b: bots, state: botRuntime.state, quote: botVersions.config })
    .from(bots)
    .leftJoin(botRuntime, eq(botRuntime.botId, bots.id))
    .leftJoin(botVersions, eq(botVersions.id, bots.activeVersionId))
    .where(
      and(
        eq(bots.userId, userId),
        eq(bots.mode, "live"),
        sql`${bots.state} not in ('draft', 'archived')`,
      ),
    );
  const stats = await db
    .select({
      botId: orders.botId,
      n: sql<number>`count(*)::int`,
      first: sql<Date | null>`min(${orders.submittedAt})`,
    })
    .from(orders)
    .where(
      and(
        inArray(
          orders.botId,
          list.length === 0 ? ["00000000-0000-0000-0000-000000000000"] : list.map((x) => x.b.id),
        ),
        inArray(orders.status, ["filled", "partially_filled"]),
      ),
    )
    .groupBy(orders.botId);
  return list.map(({ b, state, quote }) => {
    // Copy Trade nhiều market (DEC-163): cộng sổ cái của mọi market.
    const ledger = isMultiMarketCopyState(state)
      ? copyLedgerTotals(state)
      : (state as { ledger?: { realized: string; fees: string; funding: string } } | null)?.ledger;
    const s = stats.find((x) => x.botId === b.id);
    const market = (quote as { market?: string } | null)?.market ?? b.market;
    return {
      id: b.id,
      name: b.name,
      state: b.state,
      needsAttention: b.needsAttention,
      attentionSince: b.needsAttention ? b.updatedAt.getTime() : null,
      netPnl:
        ledger === undefined
          ? null
          : dec(ledger.realized).sub(ledger.fees).sub(ledger.funding).toString(),
      fees: ledger?.fees ?? null,
      fills: s?.n ?? 0,
      firstFillAt: s?.first == null ? null : new Date(s.first).getTime(),
      quote: market.includes("_") ? (market.split("_")[1] ?? "USDC") : "USDC",
    };
  });
}

export async function analyst(deps: AccountDeps, userId: string): Promise<AnalystView> {
  const a = await connected(deps.db, userId);
  const now = deps.now().getTime();
  let pf: PortfolioView | null = null;
  try {
    pf = a === null ? null : await portfolio(deps, userId);
  } catch {
    pf = null;
  }
  const bots_ = await analystBots(deps.db, userId);
  const r = a === null ? null : await risk(deps, userId).catch(() => null);
  const [u] = await deps.db
    .select({ tz: users.timezone })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  const out = analyze({
    now,
    timeZone: u?.tz ?? "UTC",
    portfolio: pf,
    portfolioAt: pf === null ? null : now,
    bots: bots_,
    limitsBreached:
      r?.status.equity == null
        ? null
        : r.alerts.filter((x) => x.resolvedAt === null && x.severity === "critical").length,
  });
  return out;
}

// ---------- Notifications ----------

export async function listNotifications(deps: AccountDeps, userId: string) {
  const rows = await deps.db
    .select()
    .from(notifications)
    .where(and(eq(notifications.userId, userId), eq(notifications.channel, "in_app")))
    .orderBy(desc(notifications.createdAt))
    .limit(50);
  const [u] = await deps.db
    .select({ n: sql<number>`count(*)::int` })
    .from(notifications)
    .where(
      and(
        eq(notifications.userId, userId),
        eq(notifications.channel, "in_app"),
        isNull(notifications.readAt),
      ),
    );
  return {
    items: rows.map((r) => ({
      id: r.id,
      type: r.type as never,
      data: r.payload as Record<string, unknown>,
      createdAt: iso(r.createdAt),
      readAt: r.readAt === null ? null : iso(r.readAt),
    })),
    unread: u?.n ?? 0,
  };
}

export async function markRead(deps: AccountDeps, userId: string, id: string): Promise<void> {
  await deps.db
    .update(notifications)
    .set({ readAt: deps.now() })
    .where(
      and(
        eq(notifications.userId, userId),
        isNull(notifications.readAt),
        id === "all" ? sql`true` : eq(notifications.id, id),
      ),
    );
}

export async function notificationSettingsOf(deps: AccountDeps, userId: string) {
  const rows = await deps.db
    .select()
    .from(notificationSettings)
    .where(eq(notificationSettings.userId, userId));
  const [u] = await deps.db
    .select({ role: users.role })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  const team = u?.role === UserRole.team;
  return {
    // Nhóm hệ thống không có trong bảng Settings (DEC-183); nhóm `teamOps` chỉ hiện với role team (DEC-184).
    groups: (Object.keys(NOTIFICATION_GROUPS) as NotificationGroup[])
      .filter((group) => !SYSTEM_GROUPS.includes(group))
      .filter((group) => team || !TEAM_ONLY_GROUPS.includes(group))
      .map((group) => {
        const alwaysOn = ALWAYS_ON_GROUPS.includes(group);
        const val = (c: NotificationChannel) =>
          // Nhóm chỉ Telegram: không có bản in-app hay email (DEC-184).
          TELEGRAM_ONLY_GROUPS.includes(group) && c !== "telegram"
            ? false
            : alwaysOn ||
              (rows.find((r) => r.type === group && r.channel === c)?.enabled ??
                NOTIFICATION_DEFAULTS[group][c]);
        return {
          group,
          alwaysOn,
          in_app: val("in_app"),
          email: val("email"),
          telegram: val("telegram"),
        };
      }),
  };
}

export async function setNotification(
  deps: AccountDeps,
  userId: string,
  group: NotificationGroup,
  channel: NotificationChannel,
  enabled: boolean,
): Promise<void> {
  if (ALWAYS_ON_GROUPS.includes(group))
    throw new AppError(ErrorCode.validationFailed, "Bot error notifications are always on.");
  if (TEAM_ONLY_GROUPS.includes(group))
    await requireTeam(deps.db, userId, "These notifications are for the DeskLabs team only.");
  if (TELEGRAM_ONLY_GROUPS.includes(group) && channel !== "telegram")
    throw new AppError(
      ErrorCode.validationFailed,
      "These notifications are sent on Telegram only.",
    );
  await deps.db
    .insert(notificationSettings)
    .values({ userId, type: group, channel, enabled })
    .onConflictDoUpdate({
      target: [
        notificationSettings.userId,
        notificationSettings.type,
        notificationSettings.channel,
      ],
      set: { enabled, updatedAt: new Date() },
    });
}

// ---------- Builder Revenue (role team) ----------

export async function builderRevenue(
  deps: AccountDeps,
  userId: string,
  month: string,
): Promise<BuilderRevenueView> {
  await requireTeam(deps.db, userId, "Builder Revenue is for the DeskLabs team only.");
  const days = await deps.db
    .select()
    .from(builderRevenueDaily)
    .where(
      month === "all"
        ? sql`true`
        : sql`to_char(${builderRevenueDaily.date}::date, 'YYYY-MM') = ${month}`,
    )
    .orderBy(desc(builderRevenueDaily.date));
  const recognized = (engine: "spot" | "perps") =>
    days
      .filter((d) => d.engine === engine)
      .reduce((s, d) => {
        if (d.status === "matched") return s.add(d.fromFills);
        if (d.balanceDelta === null) return s;
        return s.add(Decimal.max(0, Decimal.min(d.fromFills, d.balanceDelta)));
      }, new Decimal(0));
  const spot = recognized("spot");
  const perps = recognized("perps");
  const fillsN = days.reduce((s, d) => s + d.fills, 0);
  const notional = days.reduce((s, d) => s.add(d.notional), new Decimal(0));
  const snaps = await deps.db
    .select()
    .from(builderBalanceSnapshots)
    .orderBy(desc(builderBalanceSnapshots.date))
    .limit(2);
  // Approval mới nhất của mỗi account đang kết nối.
  const latest = await deps.db
    .selectDistinctOn([builderApprovals.sodexAccountId], {
      id: builderApprovals.sodexAccountId,
      spot: builderApprovals.maxFeeRateSpot,
      perps: builderApprovals.maxFeeRatePerps,
    })
    .from(builderApprovals)
    .where(eq(builderApprovals.builderId, deps.builderId))
    .orderBy(builderApprovals.sodexAccountId, desc(builderApprovals.readBackAt));
  const [accounts] = await deps.db
    .select({ n: sql<number>`count(*)::int` })
    .from(sodexAccounts)
    .where(eq(sodexAccounts.status, "connected"));
  const approved = latest.filter(
    (x) => isBuilderFeeApproved(x.spot) && isBuilderFeeApproved(x.perps),
  ).length;
  const revoked = latest.length - approved;
  return {
    builderId: deps.builderId.toString(),
    balances: {
      spot: snaps.find((s) => s.engine === "spot")?.balance ?? null,
      perps: snaps.find((s) => s.engine === "perps")?.balance ?? null,
      at: snaps[0] === undefined ? null : iso(snaps[0].takenAt),
    },
    period: month,
    totals: {
      recognized: spot.add(perps).toString(),
      perps: perps.toString(),
      spot: spot.toString(),
      fills: fillsN,
      notional: notional.toString(),
      effectivePct: notional.isZero()
        ? null
        : spot.add(perps).div(notional).mul(100).toDecimalPlaces(4).toString(),
    },
    days: days.map((d) => ({
      date: d.date,
      engine: d.engine,
      fromFills: dec(d.fromFills).toString(),
      balanceDelta: d.balanceDelta === null ? null : dec(d.balanceDelta).toString(),
      difference: d.difference === null ? null : dec(d.difference).toString(),
      status: d.status,
    })),
    approvals: { approved, revoked, never: Math.max(0, (accounts?.n ?? 0) - latest.length) },
  };
}

export const ADMIN_USERS_PAGE_SIZE = 50;

/** Users (chỉ role `team`, chỉ đọc; DEC-64): mỗi user một dòng, account SoDEX mới nhất, phí, số bot. */
interface AdminUserRow {
  id: string;
  email: string;
  role: "user" | "team";
  createdAt: Date;
  twoFactor: boolean;
  volumeBots: boolean;
  aiDesk: boolean;
  adaptiveDca: boolean;
}

/** Dòng user cho team: tài khoản SoDEX, builder fee, số bot, số dư và khối lượng. */
async function adminItems(
  deps: AccountDeps,
  rows: readonly AdminUserRow[],
): Promise<AdminUsersView["items"]> {
  const ids = rows.map((r) => r.id);
  const accounts =
    ids.length === 0
      ? []
      : await deps.db
          .selectDistinctOn([sodexAccounts.userId], {
            id: sodexAccounts.id,
            userId: sodexAccounts.userId,
            address: sodexAccounts.address,
            accountId: sodexAccounts.sodexAccountId,
            status: sodexAccounts.status,
          })
          .from(sodexAccounts)
          .where(inArray(sodexAccounts.userId, ids))
          .orderBy(sodexAccounts.userId, desc(sodexAccounts.createdAt));
  const accountIds = accounts.map((a) => a.id);
  const approvals =
    accountIds.length === 0
      ? []
      : await deps.db
          .selectDistinctOn([builderApprovals.sodexAccountId], {
            id: builderApprovals.sodexAccountId,
            spot: builderApprovals.maxFeeRateSpot,
            perps: builderApprovals.maxFeeRatePerps,
          })
          .from(builderApprovals)
          .where(
            and(
              inArray(builderApprovals.sodexAccountId, accountIds),
              eq(builderApprovals.builderId, deps.builderId),
            ),
          )
          .orderBy(builderApprovals.sodexAccountId, desc(builderApprovals.readBackAt));
  const botCounts =
    ids.length === 0
      ? []
      : await deps.db
          .select({
            userId: bots.userId,
            total: sql<number>`count(*) filter (where ${bots.state} <> ${BotState.archived})::int`,
            running: sql<number>`count(*) filter (where ${bots.state} = ${BotState.running})::int`,
          })
          .from(bots)
          .where(and(inArray(bots.userId, ids), eq(bots.mode, "live")))
          .groupBy(bots.userId);
  const equities =
    accountIds.length === 0
      ? []
      : await deps.db
          .selectDistinctOn([equitySnapshots.sodexAccountId], {
            id: equitySnapshots.sodexAccountId,
            equity: equitySnapshots.equity,
          })
          .from(equitySnapshots)
          .where(inArray(equitySnapshots.sodexAccountId, accountIds))
          .orderBy(equitySnapshots.sodexAccountId, desc(equitySnapshots.at));
  const volumes =
    ids.length === 0
      ? []
      : await deps.db
          .select({
            userId: bots.userId,
            volume: sql<string>`coalesce(sum(${fills.price} * ${fills.size}), 0)::text`,
          })
          .from(fills)
          .innerJoin(orders, eq(orders.id, fills.orderId))
          .innerJoin(bots, eq(bots.id, orders.botId))
          .where(inArray(bots.userId, ids))
          .groupBy(bots.userId);
  return rows.map((r) => {
    const a = accounts.find((x) => x.userId === r.id);
    const fee = a === undefined ? undefined : approvals.find((x) => x.id === a.id);
    const b = botCounts.find((x) => x.userId === r.id);
    return {
      id: r.id,
      email: r.email,
      role: r.role,
      createdAt: iso(r.createdAt),
      twoFactor: r.twoFactor,
      sodex:
        a === undefined
          ? null
          : { address: a.address, accountId: a.accountId.toString(), status: a.status },
      builderFee:
        a === undefined
          ? null
          : isBuilderAccount(a.accountId, deps.builderId, deps.builderExempt)
            ? "exempt"
            : fee === undefined
              ? "never"
              : isBuilderFeeApproved(fee.spot) && isBuilderFeeApproved(fee.perps)
                ? "approved"
                : "revoked",
      bots: { running: b?.running ?? 0, total: b?.total ?? 0 },
      equity: a === undefined ? null : (equities.find((x) => x.id === a.id)?.equity ?? null),
      volume: volumes.find((x) => x.userId === r.id)?.volume ?? "0",
      volumeBots: r.volumeBots,
      aiDesk: r.aiDesk,
      adaptiveDca: r.adaptiveDca,
    };
  });
}

const ADMIN_ORDERS_LIMIT = 30;
const CONNECT_EVENTS_LIMIT = 100;

/** Chi tiết một user (DEC-93): chỉ đọc, chỉ role team, mỗi lần xem ghi audit. */
export async function adminUserDetail(
  deps: AccountDeps,
  userId: string,
  targetId: string,
  ip: string | null,
): Promise<AdminUserDetail> {
  await requireTeam(deps.db, userId, "Users is for the DeskLabs team only.");
  const [row] = await deps.db
    .select({
      id: users.id,
      email: users.email,
      role: users.role,
      createdAt: users.createdAt,
      twoFactor: users.twofaEnabled,
      volumeBots: users.volumeBots,
      aiDesk: users.aiDesk,
      adaptiveDca: users.adaptiveDca,
    })
    .from(users)
    .where(and(eq(users.id, targetId), isNull(users.deletedAt)))
    .limit(1);
  if (row === undefined) throw new AppError(ErrorCode.notFound, "User not found.");
  const [user] = await adminItems(deps, [row]);
  if (user === undefined) throw new AppError(ErrorCode.notFound, "User not found.");
  const now = deps.now();
  const since = (ms: number) => new Date(now.getTime() - ms);
  const notional = sql`${fills.price} * ${fills.size}`;
  const [totals] = await deps.db
    .select({
      volume24h: sql<string>`coalesce(sum(${notional}) filter (where ${fills.filledAt} >= ${since(86_400_000)}), 0)::text`,
      volume7d: sql<string>`coalesce(sum(${notional}) filter (where ${fills.filledAt} >= ${since(7 * 86_400_000)}), 0)::text`,
      volumeAll: sql<string>`coalesce(sum(${notional}), 0)::text`,
      fills: sql<number>`count(*)::int`,
      builderFees: sql<string>`coalesce(sum(${fills.builderFee}), 0)::text`,
    })
    .from(fills)
    .innerJoin(orders, eq(orders.id, fills.orderId))
    .innerJoin(bots, eq(bots.id, orders.botId))
    .where(eq(bots.userId, targetId));
  const [seen] = await deps.db
    .select({ at: sql<Date | null>`max(${sessions.lastSeenAt})` })
    .from(sessions)
    .where(eq(sessions.userId, targetId));
  const [equityRow] = await deps.db
    .select({ at: equitySnapshots.at })
    .from(equitySnapshots)
    .innerJoin(sodexAccounts, eq(sodexAccounts.id, equitySnapshots.sodexAccountId))
    .where(eq(sodexAccounts.userId, targetId))
    .orderBy(desc(equitySnapshots.at))
    .limit(1);
  const botList = await listBots(deps.bots, targetId, true);
  const connectRows = await deps.db
    .select()
    .from(connectEvents)
    .where(eq(connectEvents.userId, targetId))
    .orderBy(desc(connectEvents.occurredAt))
    .limit(CONNECT_EVENTS_LIMIT);
  const requestRows = await deps.db
    .select({
      action: sodexSignatureRequests.action,
      status: sodexSignatureRequests.status,
      sodexError: sodexSignatureRequests.sodexError,
      at: sodexSignatureRequests.createdAt,
    })
    .from(sodexSignatureRequests)
    .where(eq(sodexSignatureRequests.userId, targetId))
    .orderBy(desc(sodexSignatureRequests.createdAt))
    .limit(20);
  const recent = await deps.db
    .select({ order: orders, botName: bots.name })
    .from(orders)
    .innerJoin(bots, eq(bots.id, orders.botId))
    .where(and(eq(bots.userId, targetId), eq(bots.mode, "live")))
    .orderBy(desc(orders.createdAt))
    .limit(ADMIN_ORDERS_LIMIT);
  await audit(deps.db, { userId, action: AuditAction.adminUserViewed, target: targetId, ip });
  const lastSeen = seen?.at ?? null;
  return {
    user: { ...user, lastSeenAt: lastSeen === null ? null : iso(new Date(lastSeen)) },
    stats: {
      equityAt: equityRow === undefined ? null : iso(equityRow.at),
      volume24h: totals?.volume24h ?? "0",
      volume7d: totals?.volume7d ?? "0",
      volumeAll: totals?.volumeAll ?? "0",
      fills: totals?.fills ?? 0,
      builderFees: totals?.builderFees ?? "0",
      botProfit: botList
        .reduce((sum, b) => (b.netPnl === null ? sum : sum.add(b.netPnl)), new Decimal(0))
        .toString(),
    },
    bots: botList,
    builderFees: await builderFeeRows(deps.db, targetId),
    connect: {
      events: connectRows.map((e) => ({
        attemptId: e.attemptId,
        type: e.type,
        data: e.data as Record<string, unknown>,
        at: iso(e.occurredAt),
      })),
      requests: requestRows.map((r) => ({
        action: r.action,
        status: r.status,
        sodexError: r.sodexError,
        at: iso(r.at),
      })),
    },
    orders: recent.map(({ order: o, botName }) => ({
      id: o.id,
      botName,
      market: o.market,
      side: o.side,
      type: o.type,
      price: o.price,
      size: o.size,
      filledSize: o.filledSize,
      status: o.status,
      at: iso(o.createdAt),
    })),
  };
}

export async function adminUsers(
  deps: AccountDeps,
  userId: string,
  query: { q: string; page: number },
): Promise<AdminUsersView> {
  await requireTeam(deps.db, userId, "Users is for the DeskLabs team only.");
  const pattern = `%${query.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const where = and(
    isNull(users.deletedAt),
    query.q === "" ? undefined : ilike(users.email, pattern),
  );
  const [totalRow] = await deps.db.select({ n: count() }).from(users).where(where);
  const rows = await deps.db
    .select({
      id: users.id,
      email: users.email,
      role: users.role,
      createdAt: users.createdAt,
      twoFactor: users.twofaEnabled,
      volumeBots: users.volumeBots,
      aiDesk: users.aiDesk,
      adaptiveDca: users.adaptiveDca,
    })
    .from(users)
    .where(where)
    .orderBy(desc(users.createdAt), desc(users.id))
    .limit(ADMIN_USERS_PAGE_SIZE)
    .offset((query.page - 1) * ADMIN_USERS_PAGE_SIZE);
  return {
    items: await adminItems(deps, rows),
    total: totalRow?.n ?? 0,
    page: query.page,
    pageSize: ADMIN_USERS_PAGE_SIZE,
  };
}

/** Team bật / tắt AI Desk cho một user (DEC-105). Chỉ ẩn / hiện AI Desk; không dừng bot nào. Ghi audit. */
export async function setAiDesk(
  deps: AccountDeps,
  actorId: string,
  targetId: string,
  enabled: boolean,
  ip: string | null,
): Promise<AdminAiDesk> {
  await requireTeam(deps.db, actorId, "Users is for the DeskLabs team only.");
  const [u] = await deps.db
    .update(users)
    .set({ aiDesk: enabled })
    .where(and(eq(users.id, targetId), isNull(users.deletedAt)))
    .returning({ id: users.id });
  if (u === undefined) throw new AppError(ErrorCode.notFound, "User not found.");
  await audit(deps.db, {
    userId: actorId,
    action: AuditAction.aiDeskChanged,
    target: targetId,
    metadata: { enabled },
    ip,
  });
  return { aiDesk: enabled };
}

/**
 * Team bật / tắt AI Adaptive DCA (Beta) cho một user (DEC-218). Tắt: ẩn khỏi catalog, API tạo bot trả
 * 404, engine không nạp bot của user; bot Adaptive DCA đang Running / Starting / Resuming chuyển sang Pausing (engine pause như lệnh Pause
 * thường, không đóng vị thế) để trạng thái hiển thị đúng với việc engine không chạy nữa (quy tắc 1.6). Ghi audit.
 */
export async function setAdaptiveDca(
  deps: AccountDeps,
  actorId: string,
  targetId: string,
  enabled: boolean,
  ip: string | null,
): Promise<AdminAdaptiveDca> {
  await requireTeam(deps.db, actorId, "Users is for the DeskLabs team only.");
  return deps.db.transaction(async (tx) => {
    const [u] = await tx
      .update(users)
      .set({ adaptiveDca: enabled })
      .where(and(eq(users.id, targetId), isNull(users.deletedAt)))
      .returning({ id: users.id });
    if (u === undefined) throw new AppError(ErrorCode.notFound, "User not found.");
    let paused = 0;
    if (!enabled) {
      const running = await tx
        .update(bots)
        .set({ state: BotState.pausing, updatedAt: new Date() })
        .where(
          and(
            eq(bots.userId, targetId),
            eq(bots.strategy, Strategy.adaptiveDca),
            // Cả bot đang Starting / Resuming: engine không nạp chúng khi cờ tắt (review #71).
            inArray(bots.state, [BotState.running, BotState.starting, BotState.resuming]),
          ),
        )
        .returning({ id: bots.id });
      paused = running.length;
    }
    await audit(tx, {
      userId: actorId,
      action: AuditAction.adaptiveDcaChanged,
      target: targetId,
      metadata: { enabled, paused },
      ip,
    });
    return { adaptiveDca: enabled, paused };
  });
}

/**
 * Team bật / tắt bot khối lượng cho một user (DEC-80). Tắt: bot Volume Maker / Volume Farm đang Running chuyển
 * sang Pausing (engine pause như lệnh Pause thường, không đóng vị thế); engine cũng không nạp bot khối lượng của
 * user đã tắt. Ghi audit cho người thao tác.
 */
export async function setVolumeBots(
  deps: AccountDeps,
  actorId: string,
  targetId: string,
  enabled: boolean,
  ip: string | null,
): Promise<AdminVolumeBots> {
  await requireTeam(deps.db, actorId, "Users is for the DeskLabs team only.");
  return deps.db.transaction(async (tx) => {
    const [u] = await tx
      .update(users)
      .set({ volumeBots: enabled })
      .where(and(eq(users.id, targetId), isNull(users.deletedAt)))
      .returning({ id: users.id });
    if (u === undefined) throw new AppError(ErrorCode.notFound, "User not found.");
    let paused = 0;
    if (!enabled) {
      const running = await tx
        .update(bots)
        .set({ state: BotState.pausing, updatedAt: new Date() })
        .where(
          and(
            eq(bots.userId, targetId),
            inArray(bots.strategy, [...VOLUME_STRATEGIES]),
            eq(bots.state, BotState.running),
          ),
        )
        .returning({ id: bots.id });
      paused = running.length;
    }
    await audit(tx, {
      userId: actorId,
      action: AuditAction.volumeBotsChanged,
      target: targetId,
      metadata: { enabled, paused },
      ip,
    });
    return { volumeBots: enabled, paused };
  });
}

// ─── Platform Stats (DEC-98) ─────────────────────────────────────────────────

/** Thống kê nền tảng toàn hệ thống (chỉ role `team`, DEC-98). Tổng hợp từ fills / users / bots — không cần bảng mới. */
export async function platformStats(
  deps: AccountDeps,
  userId: string,
  period: number,
): Promise<PlatformStats> {
  await requireTeam(deps.db, userId, "Stats is for the DeskLabs team only.");
  const now = deps.now();
  const since = (ms: number) => new Date(now.getTime() - ms);
  const DAY = 86_400_000;
  const notional = sql`${fills.price} * ${fills.size}`;

  // ── Users ────────────────────────────────────────────────────────────────
  const [userTotals] = await deps.db
    .select({
      total: sql<number>`count(*)::int`,
      new24h: sql<number>`count(*) filter (where ${users.createdAt} >= ${since(DAY)})::int`,
      new7d: sql<number>`count(*) filter (where ${users.createdAt} >= ${since(7 * DAY)})::int`,
      new30d: sql<number>`count(*) filter (where ${users.createdAt} >= ${since(30 * DAY)})::int`,
    })
    .from(users)
    .where(isNull(users.deletedAt));

  const [connectedRow] = await deps.db
    .select({ n: sql<number>`count(*)::int` })
    .from(sodexAccounts)
    .where(eq(sodexAccounts.status, "connected"));

  // ── Volume + Fees ────────────────────────────────────────────────────────
  const [volTotals] = await deps.db
    .select({
      total: sql<string>`coalesce(sum(${notional}), 0)::text`,
      h24: sql<string>`coalesce(sum(${notional}) filter (where ${fills.filledAt} >= ${since(DAY)}), 0)::text`,
      d7: sql<string>`coalesce(sum(${notional}) filter (where ${fills.filledAt} >= ${since(7 * DAY)}), 0)::text`,
      d30: sql<string>`coalesce(sum(${notional}) filter (where ${fills.filledAt} >= ${since(30 * DAY)}), 0)::text`,
      feesTotal: sql<string>`coalesce(sum(${fills.builderFee}), 0)::text`,
      fees24h: sql<string>`coalesce(sum(${fills.builderFee}) filter (where ${fills.filledAt} >= ${since(DAY)}), 0)::text`,
      fees7d: sql<string>`coalesce(sum(${fills.builderFee}) filter (where ${fills.filledAt} >= ${since(7 * DAY)}), 0)::text`,
      fees30d: sql<string>`coalesce(sum(${fills.builderFee}) filter (where ${fills.filledAt} >= ${since(30 * DAY)}), 0)::text`,
    })
    .from(fills);

  // ── Bots ─────────────────────────────────────────────────────────────────
  const [botTotals] = await deps.db
    .select({
      total: sql<number>`count(*)::int`,
      running: sql<number>`count(*) filter (where ${bots.state} = ${BotState.running})::int`,
      created24h: sql<number>`count(*) filter (where ${bots.createdAt} >= ${since(DAY)})::int`,
    })
    .from(bots)
    .where(and(isNull(bots.archivedAt), eq(bots.mode, "live")));

  // ── Daily chart ───────────────────────────────────────────────────────────
  const periodStart = since(period * DAY);

  const dailyFills = await deps.db
    .select({
      date: sql<string>`date_trunc('day', ${fills.filledAt} at time zone 'UTC')::date::text`,
      volume: sql<string>`coalesce(sum(${notional}), 0)::text`,
      fees: sql<string>`coalesce(sum(${fills.builderFee}), 0)::text`,
    })
    .from(fills)
    .where(gte(fills.filledAt, periodStart))
    .groupBy(sql`1`)
    .orderBy(sql`1`);

  const dailyUsers = await deps.db
    .select({
      date: sql<string>`date(${users.createdAt} at time zone 'UTC')::text`,
      newUsers: sql<number>`count(*)::int`,
    })
    .from(users)
    .where(and(isNull(users.deletedAt), gte(users.createdAt, periodStart)))
    .groupBy(sql`1`)
    .orderBy(sql`1`);

  // Merge by date
  const byDate = new Map<string, { newUsers: number; volume: string; fees: string }>();
  for (const r of dailyFills) {
    byDate.set(r.date, { newUsers: 0, volume: r.volume, fees: r.fees });
  }
  for (const r of dailyUsers) {
    const ex = byDate.get(r.date);
    if (ex !== undefined) ex.newUsers = r.newUsers;
    else byDate.set(r.date, { newUsers: r.newUsers, volume: "0", fees: "0" });
  }
  const daily = [...byDate.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, v]) => ({ date, ...v }));

  // Màn Connect SoDEX (DEC-114): số user khác nhau ở từng bước, lỗi hay gặp, thiết bị lúc mở trang.
  const steps = await deps.db
    .select({
      type: connectEvents.type,
      users: sql<number>`count(distinct ${connectEvents.userId})::int`,
    })
    .from(connectEvents)
    .where(gte(connectEvents.occurredAt, periodStart))
    .groupBy(connectEvents.type);
  const reason = sql<string>`coalesce(${connectEvents.data}->>'reason', ${connectEvents.data}->>'code', 'unknown')`;
  const failures = await deps.db
    .select({
      type: connectEvents.type,
      reason,
      users: sql<number>`count(distinct ${connectEvents.userId})::int`,
    })
    .from(connectEvents)
    .where(
      and(
        gte(connectEvents.occurredAt, periodStart),
        inArray(connectEvents.type, [
          "wallet_failed",
          "request_failed",
          "sign_rejected",
          "sodex_failed",
        ]),
      ),
    )
    .groupBy(connectEvents.type, reason)
    .orderBy(desc(sql`count(distinct ${connectEvents.userId})`))
    .limit(10);
  const device = sql<string>`coalesce(${connectEvents.data}->>'device', 'unknown')`;
  const devices = await deps.db
    .select({ device, users: sql<number>`count(distinct ${connectEvents.userId})::int` })
    .from(connectEvents)
    .where(and(gte(connectEvents.occurredAt, periodStart), eq(connectEvents.type, "view")))
    .groupBy(device);

  const connect = {
    steps: CONNECT_EVENT_TYPES.map((type) => ({
      type,
      users: steps.find((x) => x.type === type)?.users ?? 0,
    })),
    failures,
    devices,
  };
  // Tổng quan và insight (DEC-139).
  const overview = await statsOverview(deps, period, connect, botTotals?.running ?? 0);

  return {
    period,
    snapshotAt: iso(now),
    overview,
    mcp: await mcpStats(deps.db, now),
    users: {
      total: userTotals?.total ?? 0,
      connected: connectedRow?.n ?? 0,
      new24h: userTotals?.new24h ?? 0,
      new7d: userTotals?.new7d ?? 0,
      new30d: userTotals?.new30d ?? 0,
    },
    volume: {
      total: volTotals?.total ?? "0",
      h24: volTotals?.h24 ?? "0",
      d7: volTotals?.d7 ?? "0",
      d30: volTotals?.d30 ?? "0",
    },
    fees: {
      total: volTotals?.feesTotal ?? "0",
      h24: volTotals?.fees24h ?? "0",
      d7: volTotals?.fees7d ?? "0",
      d30: volTotals?.fees30d ?? "0",
    },
    bots: {
      total: botTotals?.total ?? 0,
      running: botTotals?.running ?? 0,
      created24h: botTotals?.created24h ?? 0,
    },
    daily,
    connect,
  };
}

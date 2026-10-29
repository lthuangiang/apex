import {
  botEvents,
  botRuntime,
  bots,
  botVersions,
  builderApprovals,
  builderBalanceSnapshots,
  builderRevenueDaily,
  equitySnapshots,
  notifications,
  notificationSettings,
  orders,
  outbox,
  riskAlerts,
  riskLimits,
  sodexAccounts,
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
  dec,
  Decimal,
  isBuilderFeeApproved,
  ErrorCode,
  evaluateRisk,
  NOTIFICATION_DEFAULTS,
  NOTIFICATION_GROUPS,
  ReasonCode,
  RISK_ENFORCED,
  startOfDay,
  UserRole,
  valuePortfolio,
  isBuilderAccount,
  type AdminUsersView,
  type AnalystView,
  type BuilderRevenueView,
  type NotificationGroup,
  type OverviewView,
  type PortfolioView,
  type RiskLimitKey,
  type RiskView,
} from "@drift/shared";
import type { SodexRestClient } from "@drift/sodex";
import { and, asc, count, desc, eq, gte, ilike, inArray, isNull, sql } from "drizzle-orm";
import { getAddress } from "viem";

import { AuditAction, audit } from "../../lib/audit";
import { listBots, type BotDeps } from "../bots/service";
import { iso } from "../security/service";
import { verifyTwoFactor, type TwoFactorDeps } from "../security/two-factor";

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
}

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
      and(eq(orders.sodexAccountId, a.id), inArray(orders.status, ["open", "partially_filled"])),
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

export async function risk(deps: AccountDeps, userId: string): Promise<RiskView | null> {
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
  const status = evaluateRisk(l, points, now, tz);
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
    .where(and(eq(orders.sodexAccountId, a.id), gte(orders.createdAt, new Date(today))));
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
    .where(eq(bots.sodexAccountId, a.id))
    .groupBy(bots.state);
  const [open] = await deps.db
    .select({ n: sql<number>`count(*)::int` })
    .from(orders)
    .where(
      and(eq(orders.sodexAccountId, a.id), inArray(orders.status, ["open", "partially_filled"])),
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

/** Emergency halt: mọi bot đang chạy / tạm dừng chuyển `stopping` (huỷ lệnh, không đóng vị thế). Cần 2FA. */
export async function halt(
  deps: AccountDeps,
  userId: string,
  code: string | undefined,
  ip: string | null,
): Promise<{ stopping: number }> {
  await verifyTwoFactor(deps, userId, code, ip);
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
    .where(eq(bots.userId, userId))
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
          // 24 nến 1h trong một request: nến đầu cho % 24h, giá đóng cho sparkline.
          const k = await deps.rest.getKlines(engine, m, {
            interval: "1h",
            startTime: now - 24 * 3_600_000,
            endTime: now,
            limit: 24,
          });
          const open = k[0]?.o;
          spark = k.map((c) => c.c);
          change =
            open === undefined || dec(open).isZero()
              ? null
              : dec(price).sub(open).div(open).mul(100).toDecimalPlaces(2).toString();
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

export async function analyst(deps: AccountDeps, userId: string): Promise<AnalystView> {
  const a = await connected(deps.db, userId);
  const now = deps.now().getTime();
  let pf: PortfolioView | null = null;
  try {
    pf = a === null ? null : await portfolio(deps, userId);
  } catch {
    pf = null;
  }
  const list = await deps.db
    .select({ b: bots, state: botRuntime.state, quote: botVersions.config })
    .from(bots)
    .leftJoin(botRuntime, eq(botRuntime.botId, bots.id))
    .leftJoin(botVersions, eq(botVersions.id, bots.activeVersionId))
    .where(and(eq(bots.userId, userId), sql`${bots.state} not in ('draft', 'archived')`));
  const stats = await deps.db
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
    bots: list.map(({ b, state, quote }) => {
      const ledger = (
        state as { ledger?: { realized: string; fees: string; funding: string } } | null
      )?.ledger;
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
    }),
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
  return {
    groups: (Object.keys(NOTIFICATION_GROUPS) as NotificationGroup[]).map((group) => {
      const alwaysOn = ALWAYS_ON_GROUPS.includes(group);
      const val = (c: "in_app" | "email") =>
        alwaysOn ||
        (rows.find((r) => r.type === group && r.channel === c)?.enabled ??
          NOTIFICATION_DEFAULTS[group][c]);
      return { group, alwaysOn, in_app: val("in_app"), email: val("email") };
    }),
  };
}

export async function setNotification(
  deps: AccountDeps,
  userId: string,
  group: NotificationGroup,
  channel: "in_app" | "email",
  enabled: boolean,
): Promise<void> {
  if (ALWAYS_ON_GROUPS.includes(group))
    throw new AppError(ErrorCode.validationFailed, "Bot error notifications are always on.");
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
  await requireTeam(deps.db, userId, "Builder Revenue is for the DRIFT team only.");
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

async function requireTeam(db: Db, userId: string, message: string): Promise<void> {
  const [u] = await db
    .select({ role: users.role })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (u?.role !== UserRole.team) throw new AppError(ErrorCode.forbidden, message);
}

export const ADMIN_USERS_PAGE_SIZE = 50;

/** Users (chỉ role `team`, chỉ đọc; DEC-64): mỗi user một dòng, account SoDEX mới nhất, phí, số bot. */
export async function adminUsers(
  deps: AccountDeps,
  userId: string,
  query: { q: string; page: number },
): Promise<AdminUsersView> {
  await requireTeam(deps.db, userId, "Users is for the DRIFT team only.");
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
    })
    .from(users)
    .where(where)
    .orderBy(desc(users.createdAt), desc(users.id))
    .limit(ADMIN_USERS_PAGE_SIZE)
    .offset((query.page - 1) * ADMIN_USERS_PAGE_SIZE);
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
          .where(inArray(bots.userId, ids))
          .groupBy(bots.userId);
  return {
    items: rows.map((r) => {
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
            : isBuilderAccount(a.accountId, deps.builderId)
              ? "exempt"
              : fee === undefined
                ? "never"
                : isBuilderFeeApproved(fee.spot) && isBuilderFeeApproved(fee.perps)
                  ? "approved"
                  : "revoked",
        bots: { running: b?.running ?? 0, total: b?.total ?? 0 },
      };
    }),
    total: totalRow?.n ?? 0,
    page: query.page,
    pageSize: ADMIN_USERS_PAGE_SIZE,
  };
}

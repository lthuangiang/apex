import { bots, builderApprovals, fills, orders, sodexAccounts, users } from "@drift/db";
import {
  BotState,
  dec,
  type PlatformOverview,
  type PlatformStats,
  type StatsInsight,
} from "@drift/shared";
import { and, eq, gte, sql } from "drizzle-orm";

import { iso } from "../security/service";

import type { AccountDeps } from "./service";

// Tổng quan Platform Stats (DEC-139): KPI có so sánh kỳ trước, phễu kích hoạt, số liệu theo strategy, lý do dừng,
// sức khoẻ hệ thống và insight tự sinh từ chính các số đó (không bịa số, chỉ đọc DB / Redis).

const DAY = 86_400_000;
/** Đường chính của màn Connect SoDEX, theo thứ tự (để tìm bước rơi nhiều nhất). */
const CONNECT_PATH = [
  "view",
  "picker_opened",
  "wallet_picked",
  "wallet_connected",
  "key_requested",
  "sign_prompted",
  "signed",
  "fee_requested",
  "connected",
] as const;
const SEVERITY = { critical: 0, warning: 1, info: 2, good: 3 } as const;

const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 1000) / 10 : null);

export async function statsOverview(
  deps: AccountDeps,
  period: number,
  connect: PlatformStats["connect"],
  runningBots: number,
): Promise<PlatformOverview> {
  const db = deps.db;
  const now = deps.now();
  const from = new Date(now.getTime() - period * DAY);
  const prevFrom = new Date(now.getTime() - 2 * period * DAY);
  const notional = sql`${fills.price} * ${fills.size}`;
  const live = and(eq(bots.mode, "live"));

  // ── KPI kỳ này / kỳ trước ────────────────────────────────────────────────
  const inCur = sql`${fills.filledAt} >= ${from}`;
  const inPrev = sql`${fills.filledAt} >= ${prevFrom} and ${fills.filledAt} < ${from}`;
  const [k] = await db
    .select({
      volCur: sql<string>`coalesce(sum(${notional}) filter (where ${inCur}), 0)::text`,
      volPrev: sql<string>`coalesce(sum(${notional}) filter (where ${inPrev}), 0)::text`,
      revCur: sql<string>`coalesce(sum(${fills.builderFee}) filter (where ${inCur}), 0)::text`,
      revPrev: sql<string>`coalesce(sum(${fills.builderFee}) filter (where ${inPrev}), 0)::text`,
      uncharged: sql<string>`coalesce(sum(${notional}) filter (where ${inCur} and coalesce(${fills.builderFee}, 0) = 0), 0)::text`,
      usersCur: sql<number>`count(distinct ${bots.userId}) filter (where ${inCur})::int`,
      usersPrev: sql<number>`count(distinct ${bots.userId}) filter (where ${inPrev})::int`,
    })
    .from(fills)
    .innerJoin(orders, eq(orders.id, fills.orderId))
    .innerJoin(bots, eq(bots.id, orders.botId))
    .where(and(live, gte(fills.filledAt, prevFrom)));
  const volCur = dec(k?.volCur ?? "0");
  const revCur = dec(k?.revCur ?? "0");

  // ── Phễu kích hoạt (mọi thời gian) ───────────────────────────────────────
  const [a] = await db
    .select({
      signedUp: sql<number>`(select count(*) from ${users} where ${users.deletedAt} is null)::int`,
      connected: sql<number>`(select count(distinct ${sodexAccounts.userId}) from ${sodexAccounts} where ${sodexAccounts.status} = 'connected')::int`,
      // Câu con có join: viết tên cột kèm bí danh bảng (drizzle bỏ tên bảng khỏi cột trong sql thô).
      approved: sql<number>`(select count(distinct sa.user_id) from ${sodexAccounts} sa join ${builderApprovals} ba on ba.sodex_account_id = sa.id where coalesce(ba.max_fee_rate_perps, 0) > 0 or coalesce(ba.max_fee_rate_spot, 0) > 0)::int`,
      firstBot: sql<number>`(select count(distinct ${bots.userId}) from ${bots} where ${bots.mode} = 'live')::int`,
      firstFill: sql<number>`(select count(distinct b.user_id) from ${fills} f join ${orders} o on o.id = f.order_id join ${bots} b on b.id = o.bot_id where b.mode = 'live')::int`,
      active7d: sql<number>`(select count(distinct b.user_id) from ${fills} f join ${orders} o on o.id = f.order_id join ${bots} b on b.id = o.bot_id where b.mode = 'live' and f.filled_at >= ${new Date(now.getTime() - 7 * DAY)})::int`,
    })
    .from(sql`(select 1) as one`);
  const activation: PlatformOverview["activation"] = [
    { step: "signedUp", users: a?.signedUp ?? 0 },
    { step: "connected", users: a?.connected ?? 0 },
    { step: "approved", users: a?.approved ?? 0 },
    { step: "firstBot", users: a?.firstBot ?? 0 },
    { step: "firstFill", users: a?.firstFill ?? 0 },
    { step: "active7d", users: a?.active7d ?? 0 },
  ];

  // ── Theo strategy (kỳ này) ───────────────────────────────────────────────
  const botRows = await db
    .select({
      strategy: bots.strategy,
      bots: sql<number>`count(*) filter (where ${bots.archivedAt} is null)::int`,
      running: sql<number>`count(*) filter (where ${bots.state} = ${BotState.running})::int`,
    })
    .from(bots)
    .where(live)
    .groupBy(bots.strategy);
  const orderRows = await db
    .select({
      strategy: bots.strategy,
      placed: sql<number>`count(*)::int`,
      filled: sql<number>`count(*) filter (where ${orders.filledSize} > 0)::int`,
      rejected: sql<number>`count(*) filter (where ${orders.status} = 'rejected')::int`,
    })
    .from(orders)
    .innerJoin(bots, eq(bots.id, orders.botId))
    .where(and(live, gte(orders.createdAt, from), sql`${orders.tag} not like '%:sl'`))
    .groupBy(bots.strategy);
  const fillRows = await db
    .select({
      strategy: bots.strategy,
      volume: sql<string>`coalesce(sum(${notional}), 0)::text`,
      fees: sql<string>`coalesce(sum(${fills.fee}), 0)::text`,
    })
    .from(fills)
    .innerJoin(orders, eq(orders.id, fills.orderId))
    .innerJoin(bots, eq(bots.id, orders.botId))
    .where(and(live, gte(fills.filledAt, from)))
    .groupBy(bots.strategy);
  const strategies = botRows
    .map((b) => {
      const o = orderRows.find((x) => x.strategy === b.strategy);
      const f = fillRows.find((x) => x.strategy === b.strategy);
      const vol = dec(f?.volume ?? "0");
      return {
        strategy: b.strategy,
        bots: b.bots,
        running: b.running,
        volume: vol.toDecimalPlaces(2).toString(),
        feePerMillion: vol.isZero()
          ? null
          : dec(f?.fees ?? "0")
              .div(vol)
              .mul(1e6)
              .toDecimalPlaces(0)
              .toString(),
        ordersPlaced: o?.placed ?? 0,
        fillRatePct: pct(o?.filled ?? 0, o?.placed ?? 0),
        rejectRatePct: pct(o?.rejected ?? 0, o?.placed ?? 0),
      };
    })
    .filter((s) => s.bots > 0 || s.ordersPlaced > 0)
    .sort((x, y) => dec(y.volume).comparedTo(x.volume));

  // ── Lý do dừng / pause (bot đổi trạng thái trong kỳ) ────────────────────
  const stopRows = await db
    .select({ reason: bots.reasonCode, bots: sql<number>`count(*)::int` })
    .from(bots)
    .where(
      and(
        live,
        gte(bots.updatedAt, from),
        sql`${bots.state} in (${BotState.stopped}, ${BotState.paused}, 'archived')`,
      ),
    )
    .groupBy(bots.reasonCode)
    .orderBy(sql`count(*) desc`);
  const stops = stopRows.map((r) => ({ reason: r.reason, bots: r.bots }));

  // ── Sức khoẻ ─────────────────────────────────────────────────────────────
  const last = await deps.bots.lastPrice("BTC-USD").catch(() => null);
  const priceAgeSec =
    last?.at == null ? null : Math.max(0, Math.round((now.getTime() - last.at) / 1000));
  const [h] = await db
    .select({
      needsAttention: sql<number>`(select count(*) from ${bots} where ${bots.needsAttention} and ${bots.archivedAt} is null and ${bots.mode} = 'live')::int`,
      rejected24h: sql<number>`(select count(*) from ${orders} where ${orders.status} = 'rejected' and ${orders.createdAt} >= ${new Date(now.getTime() - DAY)})::int`,
      lastFillAt: sql<Date | null>`(select max(${fills.filledAt}) from ${fills})`,
    })
    .from(sql`(select 1) as one`);
  const lastFill = h?.lastFillAt == null ? null : new Date(h.lastFillAt);

  // ── Insight ──────────────────────────────────────────────────────────────
  const insights: StatsInsight[] = [];
  const signed = a?.signedUp ?? 0;
  const conn = a?.connected ?? 0;
  if (priceAgeSec === null)
    insights.push({ severity: "critical", key: "priceMissing", params: {} });
  else if (priceAgeSec > 60)
    insights.push({ severity: "critical", key: "priceStale", params: { secs: priceAgeSec } });
  if ((h?.needsAttention ?? 0) > 0)
    insights.push({
      severity: "critical",
      key: "needsAttention",
      params: { n: h?.needsAttention ?? 0 },
    });
  const connPct = pct(conn, signed);
  if (signed >= 5 && connPct !== null && connPct < 30) {
    // Bước rơi nhiều nhất trên đường chính của màn Connect.
    let drop: { from: string; to: string; lost: number } | null = null;
    for (let i = 1; i < CONNECT_PATH.length; i += 1) {
      const prevStep = CONNECT_PATH[i - 1] ?? "";
      const step = CONNECT_PATH[i] ?? "";
      const u0 = connect.steps.find((s) => s.type === prevStep)?.users ?? 0;
      const u1 = connect.steps.find((s) => s.type === step)?.users ?? 0;
      if (u0 - u1 > (drop?.lost ?? 0)) drop = { from: prevStep, to: step, lost: u0 - u1 };
    }
    insights.push({
      severity: "warning",
      key: drop === null ? "activationLow" : "activationLowDrop",
      params: {
        pct: connPct,
        connected: conn,
        total: signed,
        ...(drop === null ? {} : { from: drop.from, to: drop.to, lost: drop.lost }),
      },
    });
  }
  if (runningBots === 0) insights.push({ severity: "warning", key: "noBotsRunning", params: {} });
  const volPrev = dec(k?.volPrev ?? "0");
  if (volPrev.gt(0)) {
    const ch = volCur.sub(volPrev).div(volPrev).mul(100).toNumber();
    if (ch >= 20)
      insights.push({ severity: "good", key: "volumeUp", params: { pct: Math.round(ch) } });
    else if (ch <= -20)
      insights.push({ severity: "warning", key: "volumeDown", params: { pct: Math.round(-ch) } });
  }
  const unchargedPct = volCur.gt(0) ? pct(Number(k?.uncharged ?? "0"), volCur.toNumber()) : null;
  if (unchargedPct !== null && unchargedPct > 20)
    insights.push({ severity: "info", key: "unchargedVolume", params: { pct: unchargedPct } });
  const worst = strategies
    .filter((s) => s.ordersPlaced >= 20 && (s.rejectRatePct ?? 0) >= 20)
    .sort((x, y) => (y.rejectRatePct ?? 0) - (x.rejectRatePct ?? 0))[0];
  if (worst !== undefined)
    insights.push({
      severity: "warning",
      key: "highRejects",
      params: { strategy: worst.strategy, pct: worst.rejectRatePct ?? 0 },
    });
  const lowFill = strategies
    .filter((s) => s.ordersPlaced >= 50 && (s.fillRatePct ?? 100) < 25)
    .sort((x, y) => (x.fillRatePct ?? 0) - (y.fillRatePct ?? 0))[0];
  if (lowFill !== undefined)
    insights.push({
      severity: "warning",
      key: "lowFills",
      params: { strategy: lowFill.strategy, pct: lowFill.fillRatePct ?? 0 },
    });
  const top = stops[0];
  if (top !== undefined && top.bots >= 2)
    insights.push({
      severity: "info",
      key: top.reason === null ? "topStopUser" : "topStopReason",
      params: { reason: top.reason ?? "", n: top.bots },
    });
  insights.sort((x, y) => SEVERITY[x.severity] - SEVERITY[y.severity]);

  return {
    kpis: {
      activeUsers: { cur: k?.usersCur ?? 0, prev: k?.usersPrev ?? 0 },
      volume: {
        cur: volCur.toDecimalPlaces(2).toString(),
        prev: volPrev.toDecimalPlaces(2).toString(),
      },
      revenue: {
        cur: revCur.toDecimalPlaces(4).toString(),
        prev: dec(k?.revPrev ?? "0")
          .toDecimalPlaces(4)
          .toString(),
      },
      revenuePerMillion: volCur.isZero()
        ? null
        : revCur.div(volCur).mul(1e6).toDecimalPlaces(2).toString(),
      unchargedVolumePct: unchargedPct,
    },
    activation,
    strategies,
    stops,
    health: {
      priceAgeSec,
      needsAttention: h?.needsAttention ?? 0,
      rejected24h: h?.rejected24h ?? 0,
      lastFillAt: lastFill === null ? null : iso(lastFill),
    },
    insights,
  };
}

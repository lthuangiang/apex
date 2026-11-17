import { bots, builderApprovals, candles1m, fills, orders, sodexAccounts, users } from "@drift/db";
import {
  BotState,
  builderFeeRateOf,
  dec,
  Decimal,
  FEE_TIERS,
  type PlatformOverview,
  type PlatformStats,
  type StatsInsight,
} from "@drift/shared";
import { and, eq, gte, inArray, sql } from "drizzle-orm";

import { needsAttentionSql } from "../bots/position-mismatch";
import { netCostPerMillion } from "../bots/service";
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
/** Nến 1 phút dùng làm giá đầu / cuối kỳ khi không có giá live phải mới hơn chừng này. */
const MARK_MAX_AGE_MS = 3_600_000;

/** Các tổng từ fill thật của một bot trên một market, để tính net PnL trong kỳ (`periodNetPnl`). */
export interface NetLeg {
  /** Vị thế (base) lúc đầu kỳ = Σ chiều × size của fill trước kỳ (mua +, bán −). */
  posBefore: Decimal;
  /** Σ chiều × size của fill trong kỳ. */
  posIn: Decimal;
  /** Σ tiền của fill trong kỳ: bán + giá × size, mua − giá × size. */
  cashIn: Decimal;
  /** Σ phí của fill trong kỳ (đã gồm builder fee, SODEX.md 5.3). */
  feesIn: Decimal;
  /** Giá đầu kỳ; chỉ cần khi `posBefore` ≠ 0. */
  markStart: Decimal | null;
  /** Giá hiện tại; chỉ cần khi vị thế cuối kỳ ≠ 0. */
  markEnd: Decimal | null;
}

/**
 * Net PnL trong kỳ của một bot × market = thay đổi của `netPnl` (sổ cái giá vốn bình quân, @drift/strategies) từ đầu tới
 * cuối kỳ, không gồm funding: giá đã chốt + chưa chốt − phí. Với sổ cái giá vốn bình quân, đã chốt + chưa chốt = Σ tiền
 * + vị thế × giá, nên Δ = tiền trong kỳ + vị thế cuối × giá cuối − vị thế đầu × giá đầu − phí trong kỳ. Thiếu giá cần
 * dùng → null.
 */
export function periodNetPnl(l: NetLeg): Decimal | null {
  const posEnd = l.posBefore.add(l.posIn);
  if (!l.posBefore.isZero() && l.markStart === null) return null;
  if (!posEnd.isZero() && l.markEnd === null) return null;
  const end = posEnd.isZero() || l.markEnd === null ? new Decimal(0) : posEnd.mul(l.markEnd);
  const start =
    l.posBefore.isZero() || l.markStart === null ? new Decimal(0) : l.posBefore.mul(l.markStart);
  return l.cashIn.add(end).sub(start).sub(l.feesIn);
}

/** Nguồn của một mức builder fee đã thu (phần mười bp) cho strategy: mặc định, bậc volume, hay mức khác (team đặt). */
export function builderFeeSourceOf(strategy: string, rate: number): "default" | "tier" | "custom" {
  if (rate === builderFeeRateOf(strategy)) return "default";
  if ((FEE_TIERS[strategy] ?? []).some((t) => t.rate === rate)) return "tier";
  return "custom";
}

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
  const netByStrategy = await netPnlByStrategy(deps, from, now);
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
        netCostPerMillion: netCostOf(netByStrategy.get(b.strategy), vol),
        ordersPlaced: o?.placed ?? 0,
        fillRatePct: pct(o?.filled ?? 0, o?.placed ?? 0),
        rejectRatePct: pct(o?.rejected ?? 0, o?.placed ?? 0),
      };
    })
    .filter((s) => s.bots > 0 || s.ordersPlaced > 0)
    .sort((x, y) => dec(y.volume).comparedTo(x.volume));

  // ── Builder fee theo mức đã thu (kỳ này) ─────────────────────────────────
  // Mức suy từ builder fee thật ÷ notional của từng fill (phần mười bp), không từ bảng mức hiện tại: mức team đặt có
  // thể đã đổi hoặc bị xoá trong kỳ.
  const charged = sql`coalesce(${fills.builderFee}, 0) > 0 and ${notional} > 0`;
  const rateExpr = sql<
    number | null
  >`case when ${charged} then round(${fills.builderFee} / (${notional}) * 100000)::int end`;
  const feeRows = await db
    .select({
      strategy: bots.strategy,
      rate: rateExpr,
      volume: sql<string>`coalesce(sum(${notional}), 0)::text`,
      builderFees: sql<string>`coalesce(sum(${fills.builderFee}), 0)::text`,
    })
    .from(fills)
    .innerJoin(orders, eq(orders.id, fills.orderId))
    .innerJoin(bots, eq(bots.id, orders.botId))
    .where(and(live, gte(fills.filledAt, from)))
    .groupBy(bots.strategy, rateExpr);
  const builderFeeSources = feeRows
    .map((r) => ({
      strategy: r.strategy,
      source: r.rate === null ? ("none" as const) : builderFeeSourceOf(r.strategy, r.rate),
      rate: r.rate,
      volume: dec(r.volume).toDecimalPlaces(2).toString(),
      builderFees: dec(r.builderFees).toDecimalPlaces(4).toString(),
    }))
    .sort(
      (x, y) => dec(y.builderFees).comparedTo(x.builderFees) || dec(y.volume).comparedTo(x.volume),
    );

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
      needsAttention: sql<number>`(select count(*) from ${bots} where ${needsAttentionSql(bots)} and ${bots.archivedAt} is null and ${bots.mode} = 'live')::int`,
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
    builderFeeSources,
    health: {
      priceAgeSec,
      needsAttention: h?.needsAttention ?? 0,
      rejected24h: h?.rejected24h ?? 0,
      lastFillAt: lastFill === null ? null : iso(lastFill),
    },
    insights,
  };
}

/** Net cost / $1M của một strategy: thiếu net (thiếu giá) hoặc chưa có volume → null ("Not available"). */
function netCostOf(net: Decimal | null | undefined, volume: Decimal): string | null {
  return net === null || net === undefined ? null : netCostPerMillion(net, volume);
}

/**
 * Net PnL trong kỳ theo strategy, cộng `periodNetPnl` của mọi bot thật × market có fill trong kỳ. Một leg thiếu giá →
 * cả strategy null (không đoán). Giá cuối = giá live (`deps.prices`), không có thì close nến 1 phút trong 1 giờ qua; giá
 * đầu = close nến 1 phút gần nhất tại hoặc trước đầu kỳ, trong 1 giờ.
 */
async function netPnlByStrategy(
  deps: AccountDeps,
  from: Date,
  now: Date,
): Promise<Map<string, Decimal | null>> {
  const db = deps.db;
  const notional = sql`${fills.price} * ${fills.size}`;
  const qty = sql`case when ${orders.side} = 'buy' then ${fills.size} else -${fills.size} end`;
  const cash = sql`case when ${orders.side} = 'sell' then ${notional} else -(${notional}) end`;
  const inCur = sql`${fills.filledAt} >= ${from}`;
  // Bước 1: bot thật có fill trong kỳ (index fills_filled_at_idx). Bước 2 mới cộng cả lịch sử, chỉ cho các bot đó
  // (orders_bot_idx → fills_order_idx), để không quét mọi fill của mọi bot.
  const active = await db
    .selectDistinct({ botId: orders.botId })
    .from(fills)
    .innerJoin(orders, eq(orders.id, fills.orderId))
    .innerJoin(bots, eq(bots.id, orders.botId))
    .where(and(eq(bots.mode, "live"), gte(fills.filledAt, from)));
  if (active.length === 0) return new Map();
  const rows = await db
    .select({
      strategy: bots.strategy,
      market: orders.market,
      posBefore: sql<string>`coalesce(sum(${qty}) filter (where ${fills.filledAt} < ${from}), 0)::text`,
      posIn: sql<string>`coalesce(sum(${qty}) filter (where ${inCur}), 0)::text`,
      cashIn: sql<string>`coalesce(sum(${cash}) filter (where ${inCur}), 0)::text`,
      feesIn: sql<string>`coalesce(sum(${fills.fee}) filter (where ${inCur}), 0)::text`,
    })
    .from(fills)
    .innerJoin(orders, eq(orders.id, fills.orderId))
    .innerJoin(bots, eq(bots.id, orders.botId))
    .where(
      inArray(
        orders.botId,
        active.map((a) => a.botId),
      ),
    )
    .groupBy(bots.id, bots.strategy, orders.market)
    .having(sql`count(*) filter (where ${inCur}) > 0`);
  if (rows.length === 0) return new Map();

  const legs = rows.map((r) => {
    const posBefore = dec(r.posBefore);
    return { ...r, posBefore, posEnd: posBefore.add(dec(r.posIn)) };
  });
  const startMarkets = [...new Set(legs.filter((l) => !l.posBefore.isZero()).map((l) => l.market))];
  const endMarkets = [...new Set(legs.filter((l) => !l.posEnd.isZero()).map((l) => l.market))];
  const live = endMarkets.length === 0 ? {} : await deps.prices(endMarkets).catch(() => ({}));
  const liveMarks: Record<string, string> = live;
  const lastClose = async (markets: readonly string[], at: Date) => {
    if (markets.length === 0) return new Map<string, string>();
    const r = await db
      .selectDistinctOn([candles1m.market], { market: candles1m.market, close: candles1m.close })
      .from(candles1m)
      .where(
        and(
          inArray(candles1m.market, [...markets]),
          sql`${candles1m.ts} <= ${at}`,
          sql`${candles1m.ts} > ${new Date(at.getTime() - MARK_MAX_AGE_MS)}`,
        ),
      )
      .orderBy(candles1m.market, sql`${candles1m.ts} desc`);
    return new Map(r.map((x) => [x.market, x.close]));
  };
  const startMarks = await lastClose(startMarkets, from);
  const endFallback = await lastClose(
    endMarkets.filter((m) => liveMarks[m] === undefined),
    now,
  );

  const out = new Map<string, Decimal | null>();
  for (const l of legs) {
    const ms = startMarks.get(l.market);
    const me = liveMarks[l.market] ?? endFallback.get(l.market);
    const net = periodNetPnl({
      posBefore: l.posBefore,
      posIn: dec(l.posIn),
      cashIn: dec(l.cashIn),
      feesIn: dec(l.feesIn),
      markStart: ms === undefined ? null : dec(ms),
      markEnd: me === undefined ? null : dec(me),
    });
    const prev = out.get(l.strategy);
    out.set(l.strategy, net === null || prev === null ? null : (prev ?? new Decimal(0)).add(net));
  }
  return out;
}

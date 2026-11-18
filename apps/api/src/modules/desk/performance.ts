import { botEvents, bots, botVersions, candles1m, fills, orders, type Db } from "@drift/db";
import {
  compareGroups,
  costWindows,
  dec,
  Decimal,
  fillCostPerMillion,
  IDEA_SPREAD_FLOOR_BPS,
  IDEA_SPREAD_STEP_BPS,
  PERFORMANCE_MIN_FILLS,
  performanceCost,
  Strategy,
  type CostFill,
  type CostTotals,
  type DeskPerformance,
  type DeskPerformanceQuery,
  type PerformanceIdea,
} from "@drift/shared";
import { vbSignalSnapshotSchema } from "@drift/shared/vb-signal";
import { buildTrades, type ReviewFill } from "@drift/strategies";
import { and, asc, desc, eq, inArray, like, sql } from "drizzle-orm";

import { periodNetPnl } from "../account/stats-overview";
import { exitReasonOf } from "../bots/analytics";
import type { BotDeps } from "../bots/service";

// AI Desk › "How your bots performed" (#234, DEC-TBD-ai-desk-performance). Chỉ bot tiền thật Market Making / Volume
// Builder của chính người gọi (lọc bots.user_id ở mọi truy vấn). Chỉ trả số đã tổng hợp: snapshot tín hiệu VB
// (payload.signal, DEC-311) chỉ được đọc ở server để chia nhóm lượt cho gợi ý, không bao giờ trả về.

const DAY_MS = 86_400_000;
const PERIOD_DAYS = { "7d": 7, "30d": 30 } as const;
const STRATEGIES = [Strategy.volumeMaker, Strategy.volumeFarm] as const;
/** Giá đầu / cuối kỳ: close nến 1 phút gần nhất, không cũ hơn 1 giờ (như Platform Stats). */
const MARK_MAX_AGE_MS = 3_600_000;
/** Lượt VB tối đa đọc cho mỗi bot (như Strategy Analytics). */
const MAX_TRADES = 5_000;

interface OwnBot {
  id: string;
  name: string;
  strategy: "volume_maker" | "volume_farm";
  market: string;
}

interface Leg {
  botId: string;
  market: string;
  posBefore: Decimal;
  posIn: Decimal;
  cashIn: Decimal;
  feesIn: Decimal;
  builderIn: Decimal;
  volIn: Decimal;
  fillsIn: number;
}

const ZERO = (): CostTotals => ({
  volume: new Decimal(0),
  fills: 0,
  fees: new Decimal(0),
  builderFee: new Decimal(0),
  net: new Decimal(0),
});

function add(a: CostTotals, b: CostTotals): CostTotals {
  return {
    volume: a.volume.add(b.volume),
    fills: a.fills + b.fills,
    fees: a.fees.add(b.fees),
    builderFee: a.builderFee.add(b.builderFee),
    net: a.net === null || b.net === null ? null : a.net.add(b.net),
  };
}

/** Tổng theo bot × market cho kỳ [from, to): vị thế trước kỳ, tiền, phí, builder fee, volume, số fill trong kỳ. */
async function legsOf(db: Db, botIds: readonly string[], from: Date, to: Date): Promise<Leg[]> {
  const notional = sql`${fills.price} * ${fills.size}`;
  const qty = sql`case when ${orders.side} = 'buy' then ${fills.size} else -${fills.size} end`;
  const cash = sql`case when ${orders.side} = 'sell' then ${notional} else -(${notional}) end`;
  const inCur = sql`${fills.filledAt} >= ${from} and ${fills.filledAt} < ${to}`;
  const rows = await db
    .select({
      botId: orders.botId,
      market: orders.market,
      posBefore: sql<string>`coalesce(sum(${qty}) filter (where ${fills.filledAt} < ${from}), 0)::text`,
      posIn: sql<string>`coalesce(sum(${qty}) filter (where ${inCur}), 0)::text`,
      cashIn: sql<string>`coalesce(sum(${cash}) filter (where ${inCur}), 0)::text`,
      feesIn: sql<string>`coalesce(sum(${fills.fee}) filter (where ${inCur}), 0)::text`,
      builderIn: sql<string>`coalesce(sum(coalesce(${fills.builderFee}, 0)) filter (where ${inCur}), 0)::text`,
      volIn: sql<string>`coalesce(sum(${notional}) filter (where ${inCur}), 0)::text`,
      fillsIn: sql<number>`(count(*) filter (where ${inCur}))::int`,
    })
    .from(fills)
    .innerJoin(orders, eq(orders.id, fills.orderId))
    .where(and(inArray(orders.botId, [...botIds]), sql`${fills.filledAt} < ${to}`))
    .groupBy(orders.botId, orders.market)
    .having(sql`count(*) filter (where ${inCur}) > 0`);
  return rows.map((r) => ({
    botId: r.botId,
    market: r.market,
    posBefore: dec(r.posBefore),
    posIn: dec(r.posIn),
    cashIn: dec(r.cashIn),
    feesIn: dec(r.feesIn),
    builderIn: dec(r.builderIn),
    volIn: dec(r.volIn),
    fillsIn: r.fillsIn,
  }));
}

/** Close nến 1 phút gần nhất tại hoặc trước `at`, trong `MARK_MAX_AGE_MS`. */
async function closesAt(
  db: Db,
  markets: readonly string[],
  at: Date,
): Promise<Map<string, string>> {
  if (markets.length === 0) return new Map();
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
    .orderBy(candles1m.market, desc(candles1m.ts));
  return new Map(r.map((x) => [x.market, x.close]));
}

/** Tổng theo bot của kỳ [from, to). Giá cuối kỳ hiện tại = giá live, không có thì close nến. */
async function totalsByBot(
  deps: BotDeps,
  botIds: readonly string[],
  from: Date,
  to: Date,
  live: boolean,
): Promise<Map<string, CostTotals>> {
  const legs = await legsOf(deps.db, botIds, from, to);
  const startMarkets = [...new Set(legs.filter((l) => !l.posBefore.isZero()).map((l) => l.market))];
  const endMarkets = [
    ...new Set(legs.filter((l) => !l.posBefore.add(l.posIn).isZero()).map((l) => l.market)),
  ];
  const liveMarks: Record<string, string> =
    live && endMarkets.length > 0 ? await deps.prices(endMarkets).catch(() => ({})) : {};
  const startMarks = await closesAt(deps.db, startMarkets, from);
  const endCloses = await closesAt(
    deps.db,
    endMarkets.filter((m) => liveMarks[m] === undefined),
    to,
  );
  const out = new Map<string, CostTotals>();
  for (const l of legs) {
    const ms = startMarks.get(l.market);
    const me = liveMarks[l.market] ?? endCloses.get(l.market);
    const net = periodNetPnl({
      posBefore: l.posBefore,
      posIn: l.posIn,
      cashIn: l.cashIn,
      feesIn: l.feesIn,
      markStart: ms === undefined ? null : dec(ms),
      markEnd: me === undefined ? null : dec(me),
    });
    const t: CostTotals = {
      volume: l.volIn,
      fills: l.fillsIn,
      fees: l.feesIn,
      builderFee: l.builderIn,
      net,
    };
    out.set(l.botId, add(out.get(l.botId) ?? ZERO(), t));
  }
  return out;
}

/** 24 giờ địa phương: phí + markout 1 phút (close nến chứa thời điểm fill + 60 s), như khối 3 của Market hours. */
async function hourCells(db: Db, botIds: readonly string[], from: Date, tz: string) {
  const rows = await db.execute(sql`
    select extract(hour from f.filled_at at time zone ${tz})::int as h,
           o.side as side, f.price::text as price, f.size::text as size, f.fee::text as fee,
           c.close::text as ref
      from orders o
      join fills f on f.order_id = o.id and f.filled_at >= ${from}
      left join candles_1m c
        on c.market = o.market and c.ts = date_trunc('minute', f.filled_at + interval '60 seconds')
      where o.bot_id in (${sql.join(
        botIds.map((id) => sql`${id}::uuid`),
        sql`, `,
      )}) and o.created_at >= ${new Date(from.getTime() - DAY_MS)}`);
  const byHour = Array.from({ length: 24 }, () => [] as CostFill[]);
  const list = (rows as unknown as { rows: unknown[] }).rows as {
    h: number;
    side: "buy" | "sell";
    price: string;
    size: string;
    fee: string;
    ref: string | null;
  }[];
  for (const x of list)
    byHour[x.h]?.push({ side: x.side, price: x.price, size: x.size, fee: x.fee, ref: x.ref });
  const sums = byHour.map((fs) => {
    if (fs.length === 0) return null;
    const priced = fs.filter((f) => f.ref !== null);
    const c = fillCostPerMillion(fs);
    const pv = priced.reduce((s, f) => s.add(dec(f.price).mul(dec(f.size))), new Decimal(0));
    return {
      fills: fs.length,
      volume: c.volume,
      fees: c.fees,
      costPerMillion: c.costPerMillion,
      priced: pv,
      costUsd: c.costPerMillion === null ? new Decimal(0) : c.costPerMillion.mul(pv).div(1_000_000),
    };
  });
  const hours = sums.map((s, hour) => {
    if (s === null)
      return {
        hour,
        fills: 0,
        feesPerMillion: null,
        pricePerMillion: null,
        costPerMillion: null,
        thin: true,
      };
    const feesPm = s.volume.isZero() ? null : s.fees.div(s.volume).mul(1_000_000);
    return {
      hour,
      fills: s.fills,
      feesPerMillion: feesPm === null ? null : feesPm.toDecimalPlaces(2).toString(),
      pricePerMillion:
        s.costPerMillion === null || feesPm === null
          ? null
          : s.costPerMillion.sub(feesPm).toDecimalPlaces(2).toString(),
      costPerMillion:
        s.costPerMillion === null ? null : s.costPerMillion.toDecimalPlaces(2).toString(),
      thin: s.fills < PERFORMANCE_MIN_FILLS,
    };
  });
  const windows = costWindows(
    sums.map((s) =>
      s?.costPerMillion == null ? null : { fills: s.fills, costUsd: s.costUsd, priced: s.priced },
    ),
  );
  return { hours, ...windows };
}

interface VbTrade {
  closedAt: number;
  net: number;
  volume: number;
  reason: ReturnType<typeof exitReasonOf>;
  regime: string | null;
  spreadBps: number | null;
}

/** Lượt Volume Builder đóng trong [from, to) của một bot, kèm regime / spread lúc vào (chỉ dùng ở server). */
async function vbTrades(db: Db, botId: string, from: number, to: number): Promise<VbTrade[]> {
  const rows = await db
    .select({
      tag: orders.tag,
      side: orders.side,
      price: fills.price,
      size: fills.size,
      fee: fills.fee,
      builderFee: fills.builderFee,
      isMaker: fills.isMaker,
      at: fills.filledAt,
    })
    .from(fills)
    .innerJoin(orders, eq(orders.id, fills.orderId))
    .where(and(eq(orders.botId, botId), like(orders.tag, "vf:%")));
  const fs: ReviewFill[] = rows.map((r) => ({
    tag: r.tag,
    side: r.side,
    price: Number(r.price),
    size: Number(r.size),
    fee: Number(r.fee),
    builderFee: Number(r.builderFee ?? "0"),
    isMaker: r.isMaker === true,
    at: r.at.getTime(),
  }));
  const trades = buildTrades(fs)
    .slice(-MAX_TRADES)
    .filter((t) => t.t1 >= from && t.t1 < to);
  if (trades.length === 0) return [];
  const events = await db
    .select({
      at: botEvents.occurredAt,
      decision: botEvents.decision,
      why: botEvents.why,
      payload: botEvents.payload,
    })
    .from(botEvents)
    .where(
      and(
        eq(botEvents.botId, botId),
        sql`(${botEvents.decision} like 'Closed%' or ${botEvents.decision} like 'Enter%')`,
        sql`${botEvents.occurredAt} >= ${new Date(from - DAY_MS)}`,
      ),
    )
    .orderBy(asc(botEvents.occurredAt));
  const closes = events
    .filter((e) => e.decision?.startsWith("Closed") === true)
    .map((e) => ({ at: e.at.getTime(), why: e.why }));
  // Snapshot tín hiệu lúc vào → thời điểm fill đầu của lệnh vào (khớp với t0 của lượt).
  const signals = new Map<string, { regime: string; spreadBps: number | null }>();
  for (const e of events) {
    if (e.decision?.startsWith("Enter") !== true) continue;
    const raw =
      typeof e.payload === "object" && e.payload !== null && "signal" in e.payload
        ? e.payload.signal
        : undefined;
    const s = vbSignalSnapshotSchema.safeParse(raw);
    if (s.success)
      signals.set(s.data.order.clOrdID, { regime: s.data.regime, spreadBps: s.data.spreadBps });
  }
  const firstFill = new Map<number, { regime: string; spreadBps: number | null }>();
  if (signals.size > 0) {
    const r = await db
      .select({
        clOrdId: orders.clOrdId,
        at: sql<number>`(extract(epoch from min(${fills.filledAt})) * 1000)::float8`,
      })
      .from(orders)
      .innerJoin(fills, eq(fills.orderId, orders.id))
      .where(and(eq(orders.botId, botId), inArray(orders.clOrdId, [...signals.keys()])))
      .groupBy(orders.clOrdId);
    for (const x of r) {
      const s = signals.get(x.clOrdId);
      if (s !== undefined) firstFill.set(Math.round(x.at), s);
    }
  }
  return trades.map((t) => {
    const close = closes.find((c) => c.at >= t.t1 - 5_000 && c.at <= t.t1 + 120_000) ?? null;
    const sig = firstFill.get(t.t0) ?? null;
    return {
      closedAt: t.t1,
      net: t.gross - t.fees,
      volume: t.volume,
      reason: exitReasonOf(close?.why ?? null, t.exitByStop),
      regime: sig?.regime ?? null,
      spreadBps: sig?.spreadBps ?? null,
    };
  });
}

const sum = (ts: readonly VbTrade[]) => ({
  trades: ts.length,
  net: ts.reduce((s, t) => s + t.net, 0),
  volume: ts.reduce((s, t) => s + t.volume, 0),
});

/** Gợi ý chỉ trong cài đặt có thật của bot ("Only trade sideways", "Max spread"); chỉ trả số đã tính. */
function ideasOf(
  bot: OwnBot,
  ts: readonly VbTrade[],
  config: { sidewaysOnly?: unknown; maxSpreadBps?: unknown } | null,
): PerformanceIdea[] {
  const out: PerformanceIdea[] = [];
  const known = ts.filter((t) => t.regime !== null && t.regime !== "UNKNOWN");
  if (config?.sidewaysOnly !== true) {
    const side = known.filter((t) => t.regime === "SIDEWAY");
    const trend = known.filter((t) => t.regime !== "SIDEWAY");
    const c = compareGroups(sum(trend), sum(side), ts.length);
    if (c !== null)
      out.push({
        kind: "sidewaysOnly",
        botId: bot.id,
        botName: bot.name,
        trades: known.length,
        worseCostPerMillion: c.worseCost.toFixed(2),
        betterCostPerMillion: c.betterCost.toFixed(2),
        worseShare: c.worseShare,
      });
  }
  const current = Number(config?.maxSpreadBps ?? NaN);
  if (Number.isFinite(current)) {
    const to = Math.max(IDEA_SPREAD_FLOOR_BPS, current - IDEA_SPREAD_STEP_BPS);
    if (to < current) {
      const priced = ts.filter((t) => t.spreadBps !== null);
      const wide = priced.filter((t) => (t.spreadBps ?? 0) > to);
      const narrow = priced.filter((t) => (t.spreadBps ?? 0) <= to);
      const c = compareGroups(sum(wide), sum(narrow), ts.length);
      if (c !== null)
        out.push({
          kind: "maxSpread",
          botId: bot.id,
          botName: bot.name,
          trades: priced.length,
          fromBps: String(current),
          toBps: String(to),
          worseCostPerMillion: c.worseCost.toFixed(2),
          betterCostPerMillion: c.betterCost.toFixed(2),
          worseShare: c.worseShare,
        });
    }
  }
  return out;
}

export async function deskPerformance(
  deps: BotDeps,
  userId: string,
  q: DeskPerformanceQuery,
): Promise<DeskPerformance> {
  const db = deps.db;
  const now = deps.now();
  const span = PERIOD_DAYS[q.period] * DAY_MS;
  const from = new Date(now.getTime() - span);
  const prevFrom = new Date(from.getTime() - span);
  const own: OwnBot[] = (
    await db
      .select({ id: bots.id, name: bots.name, strategy: bots.strategy, market: bots.market })
      .from(bots)
      .where(
        and(
          eq(bots.userId, userId),
          eq(bots.mode, "live"),
          inArray(bots.strategy, [...STRATEGIES]),
        ),
      )
  ).flatMap((b) =>
    b.strategy === Strategy.volumeMaker || b.strategy === Strategy.volumeFarm
      ? [{ ...b, strategy: b.strategy }]
      : [],
  );
  const empty = performanceCost(ZERO());
  const base = {
    period: q.period,
    tz: q.tz,
    previous: null,
    hours: [],
    cheapest: null,
    dearest: null,
    exits: null,
    bots: [],
    ideas: [],
  };
  if (own.length === 0) return { ...base, state: "noBots", current: empty };
  const ids = own.map((b) => b.id);
  const [cur, prev] = await Promise.all([
    totalsByBot(deps, ids, from, now, true),
    totalsByBot(deps, ids, prevFrom, from, false),
  ]);
  const total = (m: Map<string, CostTotals>) => [...m.values()].reduce(add, ZERO());
  const current = total(cur);
  if (current.fills < PERFORMANCE_MIN_FILLS)
    return { ...base, state: "notEnough", current: performanceCost(current) };
  const previous = total(prev);

  const hours = await hourCells(db, ids, from, q.tz);

  // Volume Builder: lý do thoát và gợi ý.
  const vb = own.filter((b) => b.strategy === Strategy.volumeFarm && cur.has(b.id));
  const configs = new Map<string, Record<string, unknown>>();
  if (vb.length > 0) {
    const vs = await db
      .select({ botId: bots.id, config: botVersions.config })
      .from(bots)
      .innerJoin(botVersions, eq(botVersions.id, bots.activeVersionId))
      .where(
        inArray(
          bots.id,
          vb.map((b) => b.id),
        ),
      );
    for (const v of vs)
      if (typeof v.config === "object" && v.config !== null)
        configs.set(v.botId, v.config as Record<string, unknown>);
  }
  const vbByBot = await Promise.all(
    vb.map(async (b) => ({
      bot: b,
      trades: await vbTrades(db, b.id, from.getTime(), now.getTime()),
    })),
  );
  const allVb = vbByBot.flatMap((x) => x.trades);
  const exits =
    allVb.length === 0
      ? null
      : {
          bots: vbByBot.filter((x) => x.trades.length > 0).length,
          trades: allVb.length,
          items: [...new Set(allVb.map((t) => t.reason))]
            .map((reason) => {
              const g = allVb.filter((t) => t.reason === reason);
              return {
                reason,
                trades: g.length,
                share: g.length / allVb.length,
                avgNet: (g.reduce((s, t) => s + t.net, 0) / g.length).toFixed(4),
              };
            })
            .sort((a, b) => b.trades - a.trades),
        };
  const ideas = vbByBot.flatMap((x) => ideasOf(x.bot, x.trades, configs.get(x.bot.id) ?? null));

  return {
    ...base,
    state: "ready",
    current: performanceCost(current),
    previous: previous.fills === 0 ? null : performanceCost(previous),
    ...hours,
    exits,
    bots: own
      .filter((b) => cur.has(b.id) || prev.has(b.id))
      .map((b) => {
        const c = cur.get(b.id);
        const p = prev.get(b.id);
        return {
          id: b.id,
          name: b.name,
          strategy: b.strategy,
          market: b.market,
          current: performanceCost(c ?? ZERO()),
          previous: p === undefined ? null : performanceCost(p),
        };
      })
      .sort((a, b) => Number(b.current.volume) - Number(a.current.volume)),
    ideas,
  };
}

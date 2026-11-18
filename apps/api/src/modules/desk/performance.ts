import { botEvents, bots, botVersions, candles1m, fills, orders, type Db } from "@drift/db";
import {
  compareGroups,
  costPerMillionOfSums,
  costWindows,
  dec,
  Decimal,
  IDEA_SPREAD_FLOOR_BPS,
  IDEA_SPREAD_STEP_BPS,
  PERFORMANCE_MIN_FILLS,
  performanceCost,
  Strategy,
  type CostTotals,
  type DeskPerformance,
  type DeskPerformanceQuery,
  type PerformanceIdea,
  type TradeGroup,
} from "@drift/shared";
import { vbSignalSnapshotSchema } from "@drift/shared/vb-signal";
import { and, asc, desc, eq, inArray, like, sql } from "drizzle-orm";

import { periodNetPnl } from "../account/stats-overview";
import { exitReasonOf } from "../bots/analytics";
import type { BotDeps } from "../bots/service";

// AI Desk › "How your bots performed" (#234, DEC-TBD-ai-desk-performance). Chỉ bot tiền thật Market Making / Volume
// Builder của chính người gọi (lọc bots.user_id ở mọi truy vấn). Chỉ trả số đã tổng hợp: snapshot tín hiệu VB
// (payload.signal, DEC-311) chỉ được đọc ở server để chia nhóm lượt cho gợi ý, không bao giờ trả về. Mọi truy vấn chạy
// trong một transaction chỉ đọc có statement timeout.

const DAY_MS = 86_400_000;
const PERIOD_DAYS = { "7d": 7, "30d": 30 } as const;
const STRATEGIES = [Strategy.volumeMaker, Strategy.volumeFarm] as const;
/** Giá đầu / cuối kỳ: close nến 1 phút gần nhất, không cũ hơn 1 giờ (như Platform Stats). */
const MARK_MAX_AGE_MS = 3_600_000;
/** Giới hạn thời gian của mỗi truy vấn (ms). */
const QUERY_TIMEOUT_MS = 10_000;
/** Lượt VB đóng trong kỳ có thể vào trước đầu kỳ: đọc fill từ (đầu kỳ − 1 ngày). */
const VB_ENTRY_LOOKBACK_MS = DAY_MS;

type Q = Parameters<Parameters<Db["transaction"]>[0]>[0];

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

const rows = <T>(r: unknown): T[] => (r as { rows: T[] }).rows;

/** Tổng theo bot × market cho kỳ [from, to): vị thế trước kỳ, tiền, phí, builder fee, volume, số fill trong kỳ. */
async function legsOf(q: Q, botIds: readonly string[], from: Date, to: Date): Promise<Leg[]> {
  const notional = sql`${fills.price} * ${fills.size}`;
  const qty = sql`case when ${orders.side} = 'buy' then ${fills.size} else -${fills.size} end`;
  const cash = sql`case when ${orders.side} = 'sell' then ${notional} else -(${notional}) end`;
  const inCur = sql`${fills.filledAt} >= ${from} and ${fills.filledAt} < ${to}`;
  const r = await q
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
  return r.map((x) => ({
    botId: x.botId,
    market: x.market,
    posBefore: dec(x.posBefore),
    posIn: dec(x.posIn),
    cashIn: dec(x.cashIn),
    feesIn: dec(x.feesIn),
    builderIn: dec(x.builderIn),
    volIn: dec(x.volIn),
    fillsIn: x.fillsIn,
  }));
}

/** Close nến 1 phút gần nhất tại hoặc trước `at`, trong `MARK_MAX_AGE_MS`. */
async function closesAt(q: Q, markets: readonly string[], at: Date): Promise<Map<string, string>> {
  if (markets.length === 0) return new Map();
  const r = await q
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
  q: Q,
  prices: BotDeps["prices"],
  botIds: readonly string[],
  from: Date,
  to: Date,
  live: boolean,
): Promise<Map<string, CostTotals>> {
  const legs = await legsOf(q, botIds, from, to);
  const startMarkets = [...new Set(legs.filter((l) => !l.posBefore.isZero()).map((l) => l.market))];
  const endMarkets = [
    ...new Set(legs.filter((l) => !l.posBefore.add(l.posIn).isZero()).map((l) => l.market)),
  ];
  const liveMarks: Record<string, string> =
    live && endMarkets.length > 0 ? await prices(endMarkets).catch(() => ({})) : {};
  const startMarks = await closesAt(q, startMarkets, from);
  const endCloses = await closesAt(
    q,
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
    out.set(
      l.botId,
      add(out.get(l.botId) ?? ZERO(), {
        volume: l.volIn,
        fills: l.fillsIn,
        fees: l.feesIn,
        builderFee: l.builderIn,
        net,
      }),
    );
  }
  return out;
}

/**
 * 24 giờ địa phương, cùng một cơ sở cho cả ba số: chỉ fill có giá tham chiếu (close nến chứa thời điểm fill + 60 s),
 * như khối 3 của Market hours. Phí / $1M = Σphí ÷ Σvolume có giá; giá / $1M = −Σmarkout ÷ Σvolume có giá; chi phí =
 * phí + giá. Thiếu giá > 20% volume của giờ → cả ba null.
 */
async function hourCells(q: Q, botIds: readonly string[], from: Date, tz: string) {
  const r = rows<{
    h: number;
    fills: number;
    volume: string;
    priced: string;
    priced_fees: string;
    pnl: string;
  }>(
    await q.execute(sql`
    select extract(hour from f.filled_at at time zone ${tz})::int as h,
           count(*)::int as fills,
           sum(f.price * f.size)::text as volume,
           coalesce(sum(f.price * f.size) filter (where c.close is not null), 0)::text as priced,
           coalesce(sum(f.fee) filter (where c.close is not null), 0)::text as priced_fees,
           coalesce(sum(case when o.side = 'buy' then (c.close - f.price) * f.size
                             else (f.price - c.close) * f.size end)
                    filter (where c.close is not null), 0)::text as pnl
      from orders o
      join fills f on f.order_id = o.id and f.filled_at >= ${from}
      left join candles_1m c
        on c.market = o.market and c.ts = date_trunc('minute', f.filled_at + interval '60 seconds')
      where o.bot_id in (${sql.join(
        botIds.map((id) => sql`${id}::uuid`),
        sql`, `,
      )}) and o.created_at >= ${new Date(from.getTime() - DAY_MS)}
      group by 1`),
  );
  const byHour = new Map(r.map((x) => [x.h, x]));
  const per = (v: Decimal, base: Decimal) =>
    v.div(base).mul(1_000_000).toDecimalPlaces(2).toString();
  const sums = Array.from({ length: 24 }, (_, h) => {
    const x = byHour.get(h);
    if (x === undefined) return null;
    const s = {
      volume: dec(x.volume),
      priced: dec(x.priced),
      pricedFees: dec(x.priced_fees),
      pnl: dec(x.pnl),
    };
    return { fills: x.fills, ...s, cost: costPerMillionOfSums(s) };
  });
  const hours = sums.map((s, hour) => ({
    hour,
    fills: s?.fills ?? 0,
    feesPerMillion: s?.cost == null ? null : per(s.pricedFees, s.priced),
    pricePerMillion: s?.cost == null ? null : per(s.pnl.neg(), s.priced),
    costPerMillion: s?.cost == null ? null : s.cost.toDecimalPlaces(2).toString(),
    thin: (s?.fills ?? 0) < PERFORMANCE_MIN_FILLS,
  }));
  const windows = costWindows(
    sums.map((s) =>
      s?.cost == null
        ? null
        : { fills: s.fills, costUsd: s.pricedFees.sub(s.pnl), priced: s.priced },
    ),
  );
  return { hours, ...windows };
}

interface VbTrade {
  t0: number;
  t1: number;
  net: Decimal;
  volume: Decimal;
  exitByStop: boolean;
}

const TAG = /^vf:(\d+):(in|out|sl)/;

/**
 * Ghép fill Volume Builder thành lượt (cùng cách ghép của Review this run / Strategy Analytics, `buildTrades`), nhưng
 * tính tiền bằng Decimal: net = (bán − mua) − phí; volume = Σ giá × size của mọi fill trong lượt.
 */
function groupTrades(
  fs: readonly {
    tag: string;
    side: "buy" | "sell";
    price: Decimal;
    size: Decimal;
    fee: Decimal;
    at: number;
  }[],
): VbTrade[] {
  const out: VbTrade[] = [];
  type F = (typeof fs)[number];
  // `as`: TypeScript không theo dõi lần gán trong `close`, nên khai báo kiểu rộng (như `buildTrades`).
  let cur = null as { cycle: number; ins: F[]; outs: F[] } | null;
  const close = () => {
    if (cur === null || cur.ins.length === 0 || cur.outs.length === 0) return;
    const qIn = cur.ins.reduce((s, f) => s.add(f.size), new Decimal(0));
    const qOut = cur.outs.reduce((s, f) => s.add(f.size), new Decimal(0));
    if (qOut.lt(qIn.mul(0.999))) return;
    const first = cur.ins[0];
    const last = cur.outs.at(-1);
    if (first === undefined || last === undefined) return;
    const all = [...cur.ins, ...cur.outs];
    // Lượt đóng đủ: phần lệch nhỏ (≤ 0,1%) giữa vào và ra tính theo giá ra trung bình, như `buildTrades`.
    const entry = cur.ins.reduce((s, f) => s.add(f.price.mul(f.size)), new Decimal(0)).div(qIn);
    const exit = cur.outs.reduce((s, f) => s.add(f.price.mul(f.size)), new Decimal(0)).div(qOut);
    const long = first.side === "buy";
    const gross = (long ? exit.sub(entry) : entry.sub(exit)).mul(qIn);
    out.push({
      t0: first.at,
      t1: last.at,
      net: gross.sub(all.reduce((s, f) => s.add(f.fee), new Decimal(0))),
      volume: all.reduce((s, f) => s.add(f.price.mul(f.size)), new Decimal(0)),
      exitByStop: cur.outs.some((f) => f.tag.endsWith(":sl")),
    });
  };
  for (const f of [...fs].sort((a, b) => a.at - b.at)) {
    const m = TAG.exec(f.tag);
    if (m === null) continue;
    const cycle = Number(m[1]);
    const kind = m[2];
    if (kind === "in" && (cur?.cycle !== cycle || cur.outs.length > 0)) {
      close();
      cur = { cycle, ins: [], outs: [] };
    }
    if (cur === null) continue;
    if (kind === "in") cur.ins.push(f);
    else cur.outs.push(f);
  }
  close();
  return out;
}

interface VbClosed {
  net: Decimal;
  volume: Decimal;
  reason: ReturnType<typeof exitReasonOf>;
  regime: string | null;
  spreadBps: number | null;
}

/** Lượt Volume Builder đóng trong [from, to) của một bot, kèm regime / spread lúc vào (chỉ dùng ở server). */
async function vbTrades(q: Q, botId: string, from: number, to: number): Promise<VbClosed[]> {
  const since = new Date(from - VB_ENTRY_LOOKBACK_MS);
  const r = await q
    .select({
      tag: orders.tag,
      side: orders.side,
      price: fills.price,
      size: fills.size,
      fee: fills.fee,
      at: fills.filledAt,
    })
    .from(fills)
    .innerJoin(orders, eq(orders.id, fills.orderId))
    .where(
      and(
        eq(orders.botId, botId),
        like(orders.tag, "vf:%"),
        sql`${orders.createdAt} >= ${new Date(since.getTime() - DAY_MS)}`,
        sql`${fills.filledAt} >= ${since}`,
        sql`${fills.filledAt} < ${new Date(to)}`,
      ),
    );
  const trades = groupTrades(
    r.map((x) => ({
      tag: x.tag,
      side: x.side,
      price: dec(x.price),
      size: dec(x.size),
      fee: dec(x.fee),
      at: x.at.getTime(),
    })),
  ).filter((t) => t.t1 >= from && t.t1 < to);
  if (trades.length === 0) return [];
  const events = await q
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
        sql`${botEvents.occurredAt} >= ${new Date(since.getTime() - DAY_MS)}`,
        sql`${botEvents.occurredAt} < ${new Date(to + DAY_MS)}`,
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
    const ff = await q
      .select({
        clOrdId: orders.clOrdId,
        at: sql<number>`(extract(epoch from min(${fills.filledAt})) * 1000)::float8`,
      })
      .from(orders)
      .innerJoin(fills, eq(fills.orderId, orders.id))
      .where(and(eq(orders.botId, botId), inArray(orders.clOrdId, [...signals.keys()])))
      .groupBy(orders.clOrdId);
    for (const x of ff) {
      const s = signals.get(x.clOrdId);
      if (s !== undefined) firstFill.set(Math.round(x.at), s);
    }
  }
  return trades.map((t) => {
    const c = closes.find((x) => x.at >= t.t1 - 5_000 && x.at <= t.t1 + 120_000) ?? null;
    const sig = firstFill.get(t.t0) ?? null;
    return {
      net: t.net,
      volume: t.volume,
      reason: exitReasonOf(c?.why ?? null, t.exitByStop),
      regime: sig?.regime ?? null,
      spreadBps: sig?.spreadBps ?? null,
    };
  });
}

const group = (ts: readonly VbClosed[]): TradeGroup => ({
  trades: ts.length,
  net: ts.reduce((s, t) => s.add(t.net), new Decimal(0)),
  volume: ts.reduce((s, t) => s.add(t.volume), new Decimal(0)),
});

/** Gợi ý chỉ trong cài đặt có thật của bot ("Only trade sideways", "Max spread"); chỉ trả số đã tính. */
function ideasOf(
  bot: OwnBot,
  ts: readonly VbClosed[],
  config: Record<string, unknown> | null,
): PerformanceIdea[] {
  const out: PerformanceIdea[] = [];
  const known = ts.filter((t) => t.regime !== null && t.regime !== "UNKNOWN");
  if (config?.sidewaysOnly !== true) {
    const side = known.filter((t) => t.regime === "SIDEWAY");
    const trend = known.filter((t) => t.regime !== "SIDEWAY");
    const c = compareGroups(group(trend), group(side), ts.length);
    if (c !== null)
      out.push({
        kind: "sidewaysOnly",
        botId: bot.id,
        botName: bot.name,
        trades: known.length,
        worseCostPerMillion: c.worseCost.toDecimalPlaces(2).toString(),
        betterCostPerMillion: c.betterCost.toDecimalPlaces(2).toString(),
        worseShare: c.worseShare,
      });
  }
  const raw = config?.maxSpreadBps;
  const current = typeof raw === "string" || typeof raw === "number" ? Number(raw) : NaN;
  if (Number.isFinite(current)) {
    const to = Math.max(IDEA_SPREAD_FLOOR_BPS, current - IDEA_SPREAD_STEP_BPS);
    if (to < current) {
      const priced = ts.filter((t) => t.spreadBps !== null);
      const wide = priced.filter((t) => (t.spreadBps ?? 0) > to);
      const narrow = priced.filter((t) => (t.spreadBps ?? 0) <= to);
      const c = compareGroups(group(wide), group(narrow), ts.length);
      if (c !== null)
        out.push({
          kind: "maxSpread",
          botId: bot.id,
          botName: bot.name,
          trades: priced.length,
          fromBps: String(current),
          toBps: String(to),
          worseCostPerMillion: c.worseCost.toDecimalPlaces(2).toString(),
          betterCostPerMillion: c.betterCost.toDecimalPlaces(2).toString(),
          worseShare: c.worseShare,
        });
    }
  }
  return out;
}

export async function deskPerformance(
  deps: BotDeps,
  userId: string,
  query: DeskPerformanceQuery,
): Promise<DeskPerformance> {
  return deps.db.transaction(async (q) => {
    await q.execute(sql`SET TRANSACTION READ ONLY`);
    await q.execute(sql.raw(`SET LOCAL statement_timeout = ${String(QUERY_TIMEOUT_MS)}`));
    return compute(q, deps.prices, deps.now(), userId, query);
  });
}

async function compute(
  q: Q,
  prices: BotDeps["prices"],
  now: Date,
  userId: string,
  query: DeskPerformanceQuery,
): Promise<DeskPerformance> {
  const span = PERIOD_DAYS[query.period] * DAY_MS;
  const from = new Date(now.getTime() - span);
  const prevFrom = new Date(from.getTime() - span);
  const own: OwnBot[] = (
    await q
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
  const base = {
    period: query.period,
    tz: query.tz,
    previous: null,
    hours: [],
    cheapest: null,
    dearest: null,
    exits: null,
    bots: [],
    ideas: [],
  };
  if (own.length === 0) return { ...base, state: "noBots", current: performanceCost(ZERO()) };
  const ids = own.map((b) => b.id);
  // Một kết nối (transaction): chạy lần lượt.
  const cur = await totalsByBot(q, prices, ids, from, now, true);
  const prev = await totalsByBot(q, prices, ids, prevFrom, from, false);
  const total = (m: Map<string, CostTotals>) => [...m.values()].reduce(add, ZERO());
  const current = total(cur);
  if (current.fills < PERFORMANCE_MIN_FILLS)
    return { ...base, state: "notEnough", current: performanceCost(current) };
  const previous = total(prev);

  const hours = await hourCells(q, ids, from, query.tz);

  // Volume Builder: lý do thoát và gợi ý.
  const vb = own.filter((b) => b.strategy === Strategy.volumeFarm && cur.has(b.id));
  const configs = new Map<string, Record<string, unknown>>();
  if (vb.length > 0) {
    const vs = await q
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
  const vbByBot: { bot: OwnBot; trades: VbClosed[] }[] = [];
  for (const b of vb)
    vbByBot.push({ bot: b, trades: await vbTrades(q, b.id, from.getTime(), now.getTime()) });
  const allVb = vbByBot.flatMap((x) => x.trades);
  const exits =
    allVb.length === 0
      ? null
      : {
          bots: vbByBot.filter((x) => x.trades.length > 0).length,
          trades: allVb.length,
          items: [...new Set(allVb.map((t) => t.reason))]
            .map((reason) => {
              const g = group(allVb.filter((t) => t.reason === reason));
              return {
                reason,
                trades: g.trades,
                share: g.trades / allVb.length,
                avgNet: g.net.div(g.trades).toDecimalPlaces(4).toString(),
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
      .sort((a, b) => dec(b.current.volume).cmp(a.current.volume)),
    ideas,
  };
}

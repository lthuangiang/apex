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
import { buildTradesExact } from "@drift/strategies";
import { and, asc, desc, eq, inArray, like, sql } from "drizzle-orm";

import { periodNetPnl } from "../account/stats-overview";
import { exitReasonOf } from "../bots/analytics";
import type { BotDeps } from "../bots/service";

// AI Desk › "How your bots performed" (#234, DEC-314). Chỉ bot tiền thật Market Making / Volume
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

interface PeriodSums {
  /** Vị thế (base) lúc đầu kỳ. */
  posBefore: Decimal;
  posIn: Decimal;
  cashIn: Decimal;
  feesIn: Decimal;
  builderIn: Decimal;
  volIn: Decimal;
  fillsIn: number;
}

interface Leg {
  botId: string;
  market: string;
  prev: PeriodSums;
  cur: PeriodSums;
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

/**
 * Tổng theo bot × market cho cả hai kỳ trong MỘT lần quét lịch sử fill: kỳ trước [prevFrom, from) và kỳ này [from, to).
 * Vị thế đầu kỳ trước = Σ fill trước `prevFrom`; vị thế đầu kỳ này = vị thế đầu kỳ trước + Σ fill kỳ trước.
 */
async function legsOf(
  q: Q,
  botIds: readonly string[],
  prevFrom: Date,
  from: Date,
  to: Date,
): Promise<Leg[]> {
  const notional = sql`${fills.price} * ${fills.size}`;
  const qty = sql`case when ${orders.side} = 'buy' then ${fills.size} else -${fills.size} end`;
  const cash = sql`case when ${orders.side} = 'sell' then ${notional} else -(${notional}) end`;
  const inPrev = sql`${fills.filledAt} >= ${prevFrom} and ${fills.filledAt} < ${from}`;
  const inCur = sql`${fills.filledAt} >= ${from} and ${fills.filledAt} < ${to}`;
  const sums = (inP: typeof inCur) => ({
    pos: sql<string>`coalesce(sum(${qty}) filter (where ${inP}), 0)::text`,
    cash: sql<string>`coalesce(sum(${cash}) filter (where ${inP}), 0)::text`,
    fees: sql<string>`coalesce(sum(${fills.fee}) filter (where ${inP}), 0)::text`,
    builder: sql<string>`coalesce(sum(coalesce(${fills.builderFee}, 0)) filter (where ${inP}), 0)::text`,
    vol: sql<string>`coalesce(sum(${notional}) filter (where ${inP}), 0)::text`,
    n: sql<number>`(count(*) filter (where ${inP}))::int`,
  });
  const p = sums(inPrev);
  const c = sums(inCur);
  const r = await q
    .select({
      botId: orders.botId,
      market: orders.market,
      posBefore: sql<string>`coalesce(sum(${qty}) filter (where ${fills.filledAt} < ${prevFrom}), 0)::text`,
      pPos: p.pos,
      pCash: p.cash,
      pFees: p.fees,
      pBuilder: p.builder,
      pVol: p.vol,
      pN: p.n,
      cPos: c.pos,
      cCash: c.cash,
      cFees: c.fees,
      cBuilder: c.builder,
      cVol: c.vol,
      cN: c.n,
    })
    .from(fills)
    .innerJoin(orders, eq(orders.id, fills.orderId))
    .where(and(inArray(orders.botId, [...botIds]), sql`${fills.filledAt} < ${to}`))
    .groupBy(orders.botId, orders.market)
    .having(
      sql`count(*) filter (where ${fills.filledAt} >= ${prevFrom} and ${fills.filledAt} < ${to}) > 0`,
    );
  return r.map((x) => {
    const posBefore = dec(x.posBefore);
    const prevPos = dec(x.pPos);
    return {
      botId: x.botId,
      market: x.market,
      prev: {
        posBefore,
        posIn: prevPos,
        cashIn: dec(x.pCash),
        feesIn: dec(x.pFees),
        builderIn: dec(x.pBuilder),
        volIn: dec(x.pVol),
        fillsIn: x.pN,
      },
      cur: {
        posBefore: posBefore.add(prevPos),
        posIn: dec(x.cPos),
        cashIn: dec(x.cCash),
        feesIn: dec(x.cFees),
        builderIn: dec(x.cBuilder),
        volIn: dec(x.cVol),
        fillsIn: x.cN,
      },
    };
  });
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

/** Tổng theo bot của một kỳ từ các leg: chỉ leg có fill trong kỳ; `mark(start / end)` là giá đầu / cuối kỳ. */
function periodTotals(
  legs: readonly Leg[],
  pick: (l: Leg) => PeriodSums,
  markStart: (market: string) => string | undefined,
  markEnd: (market: string) => string | undefined,
): Map<string, CostTotals> {
  const out = new Map<string, CostTotals>();
  for (const l of legs) {
    const s = pick(l);
    if (s.fillsIn === 0) continue;
    const ms = markStart(l.market);
    const me = markEnd(l.market);
    const net = periodNetPnl({
      posBefore: s.posBefore,
      posIn: s.posIn,
      cashIn: s.cashIn,
      feesIn: s.feesIn,
      markStart: ms === undefined ? null : dec(ms),
      markEnd: me === undefined ? null : dec(me),
    });
    out.set(
      l.botId,
      add(out.get(l.botId) ?? ZERO(), {
        volume: s.volIn,
        fills: s.fillsIn,
        fees: s.feesIn,
        builderFee: s.builderIn,
        net,
      }),
    );
  }
  return out;
}

/**
 * Tổng theo bot của kỳ trước và kỳ này. Giá cuối kỳ này = giá live (`liveMarks`, đọc TRƯỚC khi mở transaction), không có
 * thì close nến; các mốc khác = close nến 1 phút.
 */
async function totalsByBot(
  q: Q,
  liveMarks: Readonly<Record<string, string>>,
  botIds: readonly string[],
  prevFrom: Date,
  from: Date,
  to: Date,
): Promise<{ cur: Map<string, CostTotals>; prev: Map<string, CostTotals> }> {
  const legs = await legsOf(q, botIds, prevFrom, from, to);
  const open = (s: PeriodSums) => !s.posBefore.isZero();
  const prevStart = await closesAt(
    q,
    [...new Set(legs.filter((l) => open(l.prev)).map((l) => l.market))],
    prevFrom,
  );
  // Cuối kỳ trước = đầu kỳ này: cùng một giá.
  const mid = await closesAt(
    q,
    [...new Set(legs.filter((l) => open(l.cur)).map((l) => l.market))],
    from,
  );
  const endMarkets = [
    ...new Set(legs.filter((l) => !l.cur.posBefore.add(l.cur.posIn).isZero()).map((l) => l.market)),
  ];
  const endCloses = await closesAt(
    q,
    endMarkets.filter((m) => liveMarks[m] === undefined),
    to,
  );
  return {
    prev: periodTotals(
      legs,
      (l) => l.prev,
      (m) => prevStart.get(m),
      (m) => mid.get(m),
    ),
    cur: periodTotals(
      legs,
      (l) => l.cur,
      (m) => mid.get(m),
      (m) => liveMarks[m] ?? endCloses.get(m),
    ),
  };
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
      builderFee: fills.builderFee,
      isMaker: fills.isMaker,
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
  // Cùng cách ghép lượt với Review this run / Strategy Analytics (`groupFills`), tiền bằng Decimal.
  const trades = buildTradesExact(
    r.map((x) => ({
      tag: x.tag,
      side: x.side,
      price: dec(x.price),
      size: dec(x.size),
      fee: dec(x.fee),
      builderFee: dec(x.builderFee ?? "0"),
      isMaker: x.isMaker === true,
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
      net: t.gross.sub(t.fees),
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
  const now = deps.now();
  const own = await ownBots(deps.db, userId);
  // Danh sách bot và giá live (Redis MGET) đọc TRƯỚC khi mở transaction chỉ đọc, để transaction không giữ kết nối DB
  // chờ Redis (sửa DEC-314 (6): câu lấy bot không còn nằm trong transaction đó).
  const markets = [...new Set(own.map((b) => b.market))];
  const liveMarks: Record<string, string> =
    markets.length === 0 ? {} : await deps.prices(markets).catch(() => ({}));
  return deps.db.transaction(async (q) => {
    await q.execute(sql`SET TRANSACTION READ ONLY`);
    await q.execute(sql.raw(`SET LOCAL statement_timeout = ${String(QUERY_TIMEOUT_MS)}`));
    return compute(q, own, liveMarks, now, query);
  });
}

/** Bot tiền thật Market Making / Volume Builder của chính người gọi. */
async function ownBots(db: Db, userId: string): Promise<OwnBot[]> {
  return (
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
}

async function compute(
  q: Q,
  own: readonly OwnBot[],
  liveMarks: Readonly<Record<string, string>>,
  now: Date,
  query: DeskPerformanceQuery,
): Promise<DeskPerformance> {
  const span = PERIOD_DAYS[query.period] * DAY_MS;
  const from = new Date(now.getTime() - span);
  const prevFrom = new Date(from.getTime() - span);
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
  // Một lần quét lịch sử fill cho cả hai kỳ (#245).
  const { cur, prev } = await totalsByBot(q, liveMarks, ids, prevFrom, from, now);
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

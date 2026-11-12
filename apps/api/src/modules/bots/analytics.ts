import { botEvents, botVersions, candles1m, fills, orders } from "@drift/db";
import {
  AppError,
  ErrorCode,
  HOLD_BUCKETS,
  Strategy,
  type AnalyticsPeriod,
  type AnalyticsTrade,
  type BotAnalytics,
  type ExitReason,
  type TradeDetail,
} from "@drift/shared";
import { buildTrades, type ReviewFill, type ReviewTrade } from "@drift/strategies";
import { and, asc, eq, gte, like, lte, sql } from "drizzle-orm";

import { mmAnalytics } from "./mm-analytics";
import { ownBot, type BotDeps } from "./service";

// Strategy Analytics (DEC-141, giai đoạn 1): dựng lượt từ fill thật của bot (giống Review this run), ghép lý do thoát
// từ Decisions, MFE / MAE từ nến 1 phút, rồi tổng hợp theo kỳ: hiệu quả, theo thời gian giữ lệnh, theo lý do thoát,
// chất lượng khớp và vài nhận xét tính thẳng từ số (không phải dự đoán). Giai đoạn 1 chỉ Volume Builder.

const PERIOD_MS: Record<Exclude<AnalyticsPeriod, "all">, number> = {
  h1: 3_600_000,
  h24: 86_400_000,
  d7: 7 * 86_400_000,
  d30: 30 * 86_400_000,
};
const MAX_TRADES = 5_000;
const SUPPORTED = new Set<string>([Strategy.volumeFarm, Strategy.volumeMaker]);

const round = (v: number, dp = 4) => Math.round(v * 10 ** dp) / 10 ** dp;
const pct = (a: number, b: number) => (b > 0 ? round((a / b) * 100, 1) : null);

function bucketOf(secs: number): string {
  return (HOLD_BUCKETS.find((b) => secs >= b.from && secs < b.to) ?? HOLD_BUCKETS[0]).key;
}

/** Lý do thoát từ dòng "Closed long/short" (phần trước dấu ";"), hoặc stop trên SoDEX. */
function exitReasonOf(why: string | null, byStop: boolean): ExitReason {
  const w = why ?? "";
  if (w.startsWith("Take profit")) return "takeProfit";
  if (w.startsWith("Early profit")) return "earlyProfit";
  if (w.startsWith("Hold time")) return "holdTime";
  if (w.startsWith("Max hold")) return "maxHold";
  if (w.startsWith("Trailing")) return "trailing";
  if (/on SoDEX/i.test(w) || byStop) return "exchangeStop";
  if (w.startsWith("Stop loss")) return "stopLoss";
  return "other";
}

interface Loaded {
  trades: ReviewTrade[];
  closes: { at: number; why: string | null }[];
  versions: { version: number; at: number; config: unknown }[];
  candles: Map<number, { o: number; h: number; l: number; c: number }>;
}

async function load(deps: BotDeps, botId: string, market: string): Promise<Loaded> {
  const rows = await deps.db
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
  const trades = buildTrades(fs).slice(-MAX_TRADES);
  const closes = (
    await deps.db
      .select({ at: botEvents.occurredAt, why: botEvents.why })
      .from(botEvents)
      .where(and(eq(botEvents.botId, botId), sql`${botEvents.decision} like 'Closed%'`))
      .orderBy(asc(botEvents.occurredAt))
  ).map((e) => ({ at: e.at.getTime(), why: e.why }));
  const versions = (
    await deps.db
      .select({
        version: botVersions.version,
        appliedAt: botVersions.appliedAt,
        createdAt: botVersions.createdAt,
        config: botVersions.config,
      })
      .from(botVersions)
      .where(eq(botVersions.botId, botId))
      .orderBy(asc(botVersions.version))
  ).map((v) => ({
    version: v.version,
    at: (v.appliedAt ?? v.createdAt).getTime(),
    config: v.config,
  }));
  const candles = new Map<number, { o: number; h: number; l: number; c: number }>();
  const first = trades[0];
  const last = trades.at(-1);
  if (first !== undefined && last !== undefined) {
    const ks = await deps.db
      .select()
      .from(candles1m)
      .where(
        and(
          eq(candles1m.market, market),
          gte(candles1m.ts, new Date(Math.floor(first.t0 / 60_000) * 60_000)),
          lte(candles1m.ts, new Date(last.t1 + 60_000)),
        ),
      );
    for (const k of ks)
      candles.set(k.ts.getTime(), {
        o: Number(k.open),
        h: Number(k.high),
        l: Number(k.low),
        c: Number(k.close),
      });
  }
  return { trades, closes, versions, candles };
}

function toTrade(t: ReviewTrade, d: Loaded): AnalyticsTrade {
  const close = d.closes.find((c) => c.at >= t.t1 - 5_000 && c.at <= t.t1 + 120_000) ?? null;
  const holdSecs = Math.max(0, Math.round((t.t1 - t.t0) / 1000));
  let hi = -Infinity;
  let lo = Infinity;
  for (let m = Math.floor(t.t0 / 60_000) * 60_000; m <= t.t1; m += 60_000) {
    const k = d.candles.get(m);
    if (k === undefined) continue;
    hi = Math.max(hi, k.h);
    lo = Math.min(lo, k.l);
  }
  const has = Number.isFinite(hi) && Number.isFinite(lo);
  const mfe = !has ? null : t.long ? (hi - t.entry) / t.entry : (t.entry - lo) / t.entry;
  const mae = !has ? null : t.long ? (t.entry - lo) / t.entry : (hi - t.entry) / t.entry;
  const version = [...d.versions].reverse().find((v) => v.at <= t.t0 + 1_000)?.version ?? null;
  return {
    key: String(t.t0),
    cycle: t.cycle,
    openedAt: t.t0,
    closedAt: t.t1,
    side: t.long ? "long" : "short",
    entry: t.entry,
    exit: t.exit,
    qty: t.qty,
    notional: round(t.notional, 2),
    gross: round(t.gross),
    fees: round(t.fees),
    net: round(t.gross - t.fees),
    holdSecs,
    bucket: bucketOf(holdSecs),
    exitReason: exitReasonOf(close?.why ?? null, t.exitByStop),
    mfePct: mfe === null ? null : round(Math.max(0, mfe) * 100, 4),
    maePct: mae === null ? null : round(Math.max(0, mae) * 100, 4),
    version,
    allMaker: t.allMaker,
  };
}

export async function botAnalytics(
  deps: BotDeps,
  userId: string,
  botId: string,
  period: AnalyticsPeriod,
): Promise<BotAnalytics> {
  const b = await ownBot(deps.db, userId, botId);
  const now = deps.now().getTime();
  const from = period === "all" ? b.createdAt.getTime() : now - PERIOD_MS[period];
  const empty: BotAnalytics = {
    period,
    from,
    to: now,
    supported: SUPPORTED.has(b.strategy),
    summary: {
      trades: 0,
      net: 0,
      gross: 0,
      fees: 0,
      volume: 0,
      winRateGross: null,
      winRateNet: null,
      profitFactor: null,
      maxDrawdown: 0,
      avgHoldSecs: null,
      medianHoldSecs: null,
      prevNet: null,
    },
    equity: [],
    holding: HOLD_BUCKETS.map((h) => ({
      bucket: h.key,
      trades: 0,
      winRateGross: null,
      winRateNet: null,
      avgNet: null,
      totalNet: 0,
    })),
    execution: {
      makerRatioPct: null,
      feePerTrade: null,
      feePerMillion: null,
      ordersPlaced: 0,
      ordersFilled: 0,
      fillRatePct: null,
      rejected: 0,
    },
    exits: [],
    trades: [],
    best: null,
    worst: null,
    insights: [],
    mm: null,
  };
  if (!SUPPORTED.has(b.strategy)) return empty;
  // Market Making: theo từng lần khớp (DEC-144).
  if (b.strategy === Strategy.volumeMaker) {
    const r = await mmAnalytics(deps, botId, b.market, from, now);
    return {
      ...empty,
      summary: { ...empty.summary, volume: r.volume, fees: r.fees },
      insights: r.insights,
      mm: r.mm,
    };
  }

  const d = await load(deps, botId, b.market);
  const all = d.trades.map((t) => toTrade(t, d));
  const ts = all.filter((t) => t.closedAt >= from);
  const raw = d.trades.filter((t) => t.t1 >= from);
  const prevFrom = from - (now - from);
  const prevNet =
    period === "all"
      ? null
      : round(
          all
            .filter((t) => t.closedAt >= prevFrom && t.closedAt < from)
            .reduce((n, t) => n + t.net, 0),
        );

  // Lệnh đã gửi trong kỳ (không tính stop gốc trên SoDEX).
  const [ord] = await deps.db
    .select({
      placed: sql<number>`count(*)::int`,
      filled: sql<number>`count(*) filter (where ${orders.filledSize} > 0)::int`,
      rejected: sql<number>`count(*) filter (where ${orders.status} = 'rejected')::int`,
    })
    .from(orders)
    .where(
      and(
        eq(orders.botId, botId),
        gte(orders.createdAt, new Date(from)),
        sql`${orders.tag} not like '%:sl'`,
      ),
    );

  const net = ts.reduce((n, t) => n + t.net, 0);
  const gross = ts.reduce((n, t) => n + t.gross, 0);
  const fees = ts.reduce((n, t) => n + t.fees, 0);
  const volume = raw.reduce((n, t) => n + t.volume, 0);
  const makerVol = raw.reduce((n, t) => n + t.makerVolume, 0);
  const wins = ts.filter((t) => t.net > 0).reduce((n, t) => n + t.net, 0);
  const losses = -ts.filter((t) => t.net < 0).reduce((n, t) => n + t.net, 0);
  const ordered = [...ts].sort((x, y) => x.closedAt - y.closedAt);
  let cum = 0;
  let peak = 0;
  let maxDd = 0;
  const equity = ordered.map((t) => {
    cum += t.net;
    peak = Math.max(peak, cum);
    maxDd = Math.min(maxDd, cum - peak);
    return { t: t.closedAt, net: round(cum) };
  });
  const holds = ts.map((t) => t.holdSecs).sort((x, y) => x - y);
  const holding = HOLD_BUCKETS.map((h) => {
    const g = ts.filter((t) => t.bucket === h.key);
    const tot = g.reduce((n, t) => n + t.net, 0);
    return {
      bucket: h.key,
      trades: g.length,
      winRateGross: pct(g.filter((t) => t.gross > 0).length, g.length),
      winRateNet: pct(g.filter((t) => t.net > 0).length, g.length),
      avgNet: g.length === 0 ? null : round(tot / g.length),
      totalNet: round(tot),
    };
  });
  const exits = [...new Set(ts.map((t) => t.exitReason))]
    .map((reason) => {
      const g = ts.filter((t) => t.exitReason === reason);
      return {
        reason,
        trades: g.length,
        avgNet: round(g.reduce((n, t) => n + t.net, 0) / g.length),
      };
    })
    .sort((x, y) => y.trades - x.trades);
  const best = ts.reduce<AnalyticsTrade | null>(
    (m, t) => (m === null || t.net > m.net ? t : m),
    null,
  );
  const worst = ts.reduce<AnalyticsTrade | null>(
    (m, t) => (m === null || t.net < m.net ? t : m),
    null,
  );

  // Nhận xét tính thẳng từ số của kỳ.
  const insights: BotAnalytics["insights"] = [];
  const n = ts.length;
  const wrGross = pct(ts.filter((t) => t.gross > 0).length, n);
  const wrNet = pct(ts.filter((t) => t.net > 0).length, n);
  if (n > 0 && n < 30) insights.push({ key: "smallSample", params: { n } });
  const minN = Math.max(5, Math.ceil(n * 0.1));
  const bestBucket = holding
    .filter((h) => h.trades >= minN && h.avgNet !== null)
    .sort((x, y) => (y.avgNet ?? 0) - (x.avgNet ?? 0))[0];
  if (bestBucket !== undefined && n >= 10)
    insights.push({
      key: "bestBucket",
      params: {
        bucket: bestBucket.bucket,
        trades: bestBucket.trades,
        winRate: bestBucket.winRateNet ?? 0,
        avgNet: bestBucket.avgNet ?? 0,
      },
    });
  if (wrGross !== null && wrNet !== null && wrGross - wrNet >= 15)
    insights.push({ key: "feesEatWins", params: { gross: wrGross, net: wrNet } });
  const topExit = exits[0];
  if (topExit !== undefined && n >= 10 && topExit.trades / n >= 0.6)
    insights.push({
      key: "exitMostly",
      params: {
        reason: topExit.reason,
        pct: round((topExit.trades / n) * 100, 0),
        avgNet: topExit.avgNet,
      },
    });
  const makerPct = pct(makerVol, volume);
  if (makerPct !== null && makerPct < 90)
    insights.push({ key: "takerShare", params: { pct: makerPct } });
  const fillPct = pct(ord?.filled ?? 0, ord?.placed ?? 0);
  if (fillPct !== null && (ord?.placed ?? 0) >= 20 && fillPct < 40)
    insights.push({ key: "lowFills", params: { pct: fillPct } });

  return {
    ...empty,
    summary: {
      trades: n,
      net: round(net),
      gross: round(gross),
      fees: round(fees),
      volume: round(volume, 2),
      winRateGross: wrGross,
      winRateNet: wrNet,
      profitFactor: losses > 0 && wins > 0 ? round(wins / losses, 2) : null,
      maxDrawdown: round(maxDd),
      avgHoldSecs: n === 0 ? null : Math.round(holds.reduce((s, x) => s + x, 0) / n),
      medianHoldSecs: n === 0 ? null : (holds[Math.floor(n / 2)] ?? null),
      prevNet,
    },
    equity,
    holding,
    execution: {
      makerRatioPct: makerPct,
      feePerTrade: n === 0 ? null : round(fees / n),
      feePerMillion: volume > 0 ? round((fees / volume) * 1e6, 1) : null,
      ordersPlaced: ord?.placed ?? 0,
      ordersFilled: ord?.filled ?? 0,
      fillRatePct: fillPct,
      rejected: ord?.rejected ?? 0,
    },
    exits,
    trades: [...ts].sort((x, y) => y.closedAt - x.closedAt),
    best: best?.key ?? null,
    worst: worst?.key ?? null,
    insights,
  };
}

export async function tradeDetail(
  deps: BotDeps,
  userId: string,
  botId: string,
  key: string,
): Promise<TradeDetail> {
  const b = await ownBot(deps.db, userId, botId);
  const d = await load(deps, botId, b.market);
  const raw = d.trades.find((t) => String(t.t0) === key);
  if (raw === undefined) throw new AppError(ErrorCode.notFound, "Trade not found.");
  const trade = toTrade(raw, d);
  const prefix = `vf:${String(raw.cycle)}:`;
  const od = await deps.db
    .select()
    .from(orders)
    .where(
      and(
        eq(orders.botId, botId),
        like(orders.tag, `${prefix}%`),
        gte(orders.createdAt, new Date(raw.t0 - 10 * 60_000)),
        lte(orders.createdAt, new Date(raw.t1 + 60_000)),
      ),
    )
    .orderBy(asc(orders.createdAt));
  const fl = await deps.db
    .select({
      at: fills.filledAt,
      tag: orders.tag,
      side: orders.side,
      price: fills.price,
      size: fills.size,
      fee: fills.fee,
      isMaker: fills.isMaker,
    })
    .from(fills)
    .innerJoin(orders, eq(orders.id, fills.orderId))
    .where(
      and(
        eq(orders.botId, botId),
        like(orders.tag, `${prefix}%`),
        gte(fills.filledAt, new Date(raw.t0 - 1_000)),
        lte(fills.filledAt, new Date(raw.t1 + 1_000)),
      ),
    )
    .orderBy(asc(fills.filledAt));
  const ks = await deps.db
    .select()
    .from(candles1m)
    .where(
      and(
        eq(candles1m.market, b.market),
        gte(candles1m.ts, new Date(raw.t0 - 15 * 60_000)),
        lte(candles1m.ts, new Date(raw.t1 + 15 * 60_000)),
      ),
    )
    .orderBy(asc(candles1m.ts));
  const evs = await deps.db
    .select()
    .from(botEvents)
    .where(
      and(
        eq(botEvents.botId, botId),
        gte(botEvents.occurredAt, new Date(raw.t0 - 15 * 60_000)),
        lte(botEvents.occurredAt, new Date(raw.t1 + 120_000)),
      ),
    )
    .orderBy(asc(botEvents.occurredAt));
  const enter =
    [...evs]
      .reverse()
      .find((e) => e.decision?.startsWith("Enter") === true && e.occurredAt.getTime() <= raw.t0) ??
    null;
  const closed =
    evs.find(
      (e) =>
        e.decision?.startsWith("Closed") === true &&
        e.occurredAt.getTime() >= raw.t1 - 5_000 &&
        e.occurredAt.getTime() <= raw.t1 + 120_000,
    ) ?? null;
  const v = d.versions.find((x) => x.version === trade.version) ?? null;
  return {
    trade,
    orders: od.map((o) => ({
      tag: o.tag,
      side: o.side,
      type: o.type,
      price: o.price,
      size: o.size,
      filledSize: o.filledSize,
      status: o.status,
      rejectCode: o.rejectCode,
      at: (o.submittedAt ?? o.createdAt).getTime(),
    })),
    fills: fl.map((f) => ({
      at: f.at.getTime(),
      tag: f.tag,
      side: f.side,
      price: Number(f.price),
      size: Number(f.size),
      fee: Number(f.fee),
      maker: f.isMaker === true,
    })),
    candles: ks.map((k) => ({
      t: k.ts.getTime(),
      o: Number(k.open),
      h: Number(k.high),
      l: Number(k.low),
      c: Number(k.close),
    })),
    enter:
      enter === null
        ? null
        : { at: enter.occurredAt.getTime(), decision: enter.decision ?? "", why: enter.why ?? "" },
    closed:
      closed === null
        ? null
        : {
            at: closed.occurredAt.getTime(),
            decision: closed.decision ?? "",
            why: closed.why ?? "",
          },
    config: v === null ? null : { version: v.version, config: v.config as Record<string, unknown> },
  };
}

import type { DbTx } from "@drift/db";
import { dec, Decimal } from "@drift/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";

import { groupTrades } from "../replay/load";

import type { SpreadHour } from "./costs";
import type { FundingPoint } from "./funding";
import type { Candle } from "./market";
import { markOpening, type MmFill, type VbRoundTrip } from "./risk-filter";
import { walletKey, type WalletSnapshot, type WhaleEvent } from "./whales";

// Bộ nạp chỉ đọc của replay tín hiệu (#274). Mọi hàm nhận transaction của `readOnlyTx` (READ ONLY, statement timeout, trần
// thời gian tổng). Không gọi REST SoDEX. Bộ nhớ có trần: nến nạp từng market một, mọi truy vấn có `limit trần + 1` và vượt
// trần thì dừng với lỗi rõ (không bao giờ ra báo cáo thiếu mà không nói).

export type Q = DbTx;

const DAY = 86_400_000;
const rows = <T>(r: unknown): T[] => (r as { rows: T[] }).rows;

export const LIMITS = {
  maxRangeDays: 90,
  candlesPerMarket: 200_000,
  whaleEvents: 500_000,
  walletRows: 500_000,
  fundingPerMarket: 50_000,
  spreadHoursPerMarket: 20_000,
  ledgerFills: 1_000_000,
} as const;

export class SignalReplayLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SignalReplayLimitError";
  }
}

function capped<T>(list: T[], cap: number, what: string): T[] {
  if (list.length > cap)
    throw new SignalReplayLimitError(
      `more than ${String(cap)} ${what}; use a shorter range (--from / --to)`,
    );
  return list;
}

export function checkRange(from: Date, to: Date): void {
  if (to <= from) throw new SignalReplayLimitError("--to must be after --from");
  if (to.getTime() - from.getTime() > LIMITS.maxRangeDays * DAY)
    throw new SignalReplayLimitError(
      `range is longer than ${String(LIMITS.maxRangeDays)} days; run several shorter ranges instead`,
    );
}

/** Market Perps (`*-USD`) có nến, đọc bằng skip-scan trên khoá chính (market, ts), không quét cả bảng. */
export async function listPerpMarkets(q: Q): Promise<string[]> {
  const r = rows<{ market: string }>(
    await q.execute(sql`
      with recursive m as (
        (select market from candles_1m order by market limit 1)
        union all
        select (select c.market from candles_1m c where c.market > m.market order by c.market limit 1)
          from m where m.market is not null)
      select market from m where market is not null`),
  );
  return r.map((x) => x.market).filter((m) => m.endsWith("-USD"));
}

export async function loadCandles(q: Q, market: string, from: Date, to: Date): Promise<Candle[]> {
  const r = rows<{
    ts: Date;
    open: string;
    high: string;
    low: string;
    close: string;
    volume: number;
  }>(
    await q.execute(sql`
      select ts, open::text as open, high::text as high, low::text as low, close::text as close,
             volume::float8 as volume
        from candles_1m
       where market = ${market} and ts >= ${from} and ts < ${to}
       order by ts
       limit ${LIMITS.candlesPerMarket + 1}`),
  );
  return capped(r, LIMITS.candlesPerMarket, `candles for ${market}`).map((c) => ({
    ts: new Date(c.ts).getTime(),
    open: dec(c.open),
    high: dec(c.high),
    low: dec(c.low),
    close: dec(c.close),
    volume: c.volume,
  }));
}

const histSchema = z.record(z.string(), z.number());

export async function loadSpreadHours(
  q: Q,
  market: string,
  from: Date,
  to: Date,
): Promise<SpreadHour[]> {
  const r = rows<{ hour: Date; spread_ticks: unknown }>(
    await q.execute(sql`
      select hour, spread_ticks from mm_market_hourly
       where market = ${market} and hour >= ${from} and hour < ${to}
       order by hour
       limit ${LIMITS.spreadHoursPerMarket + 1}`),
  );
  return capped(r, LIMITS.spreadHoursPerMarket, `spread hours for ${market}`).flatMap((h) => {
    const p = histSchema.safeParse(h.spread_ticks);
    return p.success ? [{ hour: new Date(h.hour).getTime(), spreadTicks: p.data }] : [];
  });
}

/** Giá giữa đầu tiên trong 5 s sau mỗi mốc (mid_1s, chỉ market có bot MM, giữ 48 giờ), một câu cho cả lô. */
export async function loadMidAfter(
  q: Q,
  market: string,
  ats: readonly number[],
): Promise<Map<number, Decimal>> {
  const out = new Map<number, Decimal>();
  const uniq = [...new Set(ats)];
  for (let i = 0; i < uniq.length; i += 5_000) {
    const batch = uniq.slice(i, i + 5_000);
    const arr = `{${batch.map((t) => new Date(t).toISOString()).join(",")}}`;
    const r = rows<{ i: number; mid: string | null }>(
      await q.execute(sql`
        select t.i::int as i, m.mid::text as mid
          from unnest(${arr}::timestamptz[]) with ordinality as t(at, i)
          left join lateral (
            select mid from mid_1s
             where market = ${market} and ts >= t.at and ts <= t.at + interval '5 seconds'
             order by ts limit 1) m on true`),
    );
    for (const x of r) {
      const at = batch[x.i - 1];
      if (at !== undefined && x.mid !== null) out.set(at, dec(x.mid));
    }
  }
  return out;
}

const statsSchema = z.object({
  winRate: z.string().nullable().optional(),
  medianEntryNotional: z.string().nullable().optional(),
});

/**
 * Lịch sử xếp hạng theo ví: mỗi dòng `leader_stats_daily` ghép với lần `leaderboard_runs` cùng ngày đã xong (status ok,
 * có finished_at), xếp theo finished_at. Chỉ lần xong trước `to`.
 */
export async function loadWallets(q: Q, to: Date): Promise<Map<string, WalletSnapshot[]>> {
  const r = rows<{
    source: string;
    address: string;
    date: string;
    finished_at: Date;
    profit: string;
    stats: unknown;
    steady_score: number | null;
    hidden: string[];
  }>(
    await q.execute(sql`
      select s.source, s.address, s.date::text as date, r.finished_at, s.profit::text as profit,
             jsonb_build_object('winRate', s.stats -> 'winRate',
                                'medianEntryNotional', s.stats -> 'medianEntryNotional') as stats,
             s.steady_score, s.hidden
        from leader_stats_daily s
        join leaderboard_runs r on r.date = s.date and r.status = 'ok' and r.finished_at is not null
       where r.finished_at < ${to}
       order by r.finished_at
       limit ${LIMITS.walletRows + 1}`),
  );
  const out = new Map<string, WalletSnapshot[]>();
  for (const w of capped(r, LIMITS.walletRows, "wallet stats rows")) {
    const st = statsSchema.safeParse(w.stats);
    const snap: WalletSnapshot = {
      date: w.date,
      finishedAt: new Date(w.finished_at).getTime(),
      profit: dec(w.profit),
      winRate: st.success && st.data.winRate != null ? dec(st.data.winRate) : null,
      medianEntryNotional:
        st.success && st.data.medianEntryNotional != null ? dec(st.data.medianEntryNotional) : null,
      steadyScore: w.steady_score,
      hidden: w.hidden,
    };
    const key = walletKey(w.source, w.address);
    const list = out.get(key);
    if (list === undefined) out.set(key, [snap]);
    else list.push(snap);
  }
  return out;
}

export interface WhaleCoverage {
  eventsInRange: number;
  notListedOnSodex: number;
  notOpenOrAdd: number;
  firstEventSeenAt: number | null;
  firstRankingFinishedAt: number | null;
  /** Phân bố độ trễ seen_at − at của mọi sự kiện trong khoảng. */
  delays: { under1m: number; under5m: number; under1h: number; over1h: number };
}

export async function whaleCoverage(q: Q, from: Date, to: Date): Promise<WhaleCoverage> {
  const r = rows<{
    total: number;
    not_listed: number;
    not_open: number;
    first_seen: Date | null;
    first_run: Date | null;
    d1m: number;
    d5m: number;
    d1h: number;
    dmore: number;
  }>(
    await q.execute(sql`
      select count(*)::int as total,
             count(*) filter (where market is null)::int as not_listed,
             count(*) filter (where market is not null and kind not in ('open', 'add', 'flip'))::int as not_open,
             (select min(seen_at) from leader_events) as first_seen,
             (select min(finished_at) from leaderboard_runs where status = 'ok') as first_run,
             count(*) filter (where seen_at - at < interval '1 minute')::int as d1m,
             count(*) filter (where seen_at - at >= interval '1 minute' and seen_at - at < interval '5 minutes')::int as d5m,
             count(*) filter (where seen_at - at >= interval '5 minutes' and seen_at - at < interval '1 hour')::int as d1h,
             count(*) filter (where seen_at - at >= interval '1 hour')::int as dmore
        from leader_events
       where seen_at >= ${from} and seen_at < ${to}`),
  );
  const x = r[0];
  return {
    eventsInRange: x?.total ?? 0,
    notListedOnSodex: x?.not_listed ?? 0,
    notOpenOrAdd: x?.not_open ?? 0,
    firstEventSeenAt: x?.first_seen == null ? null : new Date(x.first_seen).getTime(),
    firstRankingFinishedAt: x?.first_run == null ? null : new Date(x.first_run).getTime(),
    delays: {
      under1m: x?.d1m ?? 0,
      under5m: x?.d5m ?? 0,
      under1h: x?.d1h ?? 0,
      over1h: x?.dmore ?? 0,
    },
  };
}

/**
 * Sự kiện ứng viên của A (mở / tăng / đảo vị thế, market có trên SoDEX) thấy trong khoảng, gồm 30 phút trước `from` cho
 * phần đồng thuận, nhóm theo market.
 */
export async function loadWhaleEvents(
  q: Q,
  from: Date,
  to: Date,
): Promise<Map<string, WhaleEvent[]>> {
  const r = rows<{
    id: string;
    source: string;
    address: string;
    market: string;
    kind: string;
    position_before: string;
    position_after: string;
    notional: string;
    price: string;
    at: Date;
    seen_at: Date;
  }>(
    await q.execute(sql`
      select id, source, address, market, kind, position_before::text as position_before,
             position_after::text as position_after, notional::text as notional, price::text as price, at, seen_at
        from leader_events
       where seen_at >= ${new Date(from.getTime() - 30 * 60_000)} and seen_at < ${to}
         and market is not null and kind in ('open', 'add', 'flip')
       order by seen_at
       limit ${LIMITS.whaleEvents + 1}`),
  );
  const out = new Map<string, WhaleEvent[]>();
  for (const e of capped(r, LIMITS.whaleEvents, "whale events")) {
    const ev: WhaleEvent = {
      id: e.id,
      source: e.source,
      address: e.address,
      market: e.market,
      kind: e.kind,
      positionBefore: dec(e.position_before),
      positionAfter: dec(e.position_after),
      notional: dec(e.notional),
      price: dec(e.price),
      at: new Date(e.at).getTime(),
      seenAt: new Date(e.seen_at).getTime(),
    };
    const list = out.get(ev.market);
    if (list === undefined) out.set(ev.market, [ev]);
    else list.push(ev);
  }
  return out;
}

/** Funding của một market từ `from` (đã lùi 90 ngày lịch sử) tới `to`, theo giờ funding. */
export async function loadFunding(
  q: Q,
  market: string,
  from: Date,
  to: Date,
): Promise<FundingPoint[]> {
  const r = rows<{ at: Date; rate: string }>(
    await q.execute(sql`
      select funding_time as at, rate::text as rate from funding_rates
       where market = ${market} and funding_time >= ${from} and funding_time < ${to}
       order by funding_time
       limit ${LIMITS.fundingPerMarket + 1}`),
  );
  return capped(r, LIMITS.fundingPerMarket, `funding rows for ${market}`).map((p) => ({
    at: new Date(p.at).getTime(),
    rate: dec(p.rate),
  }));
}

/** D1 · Lượt Volume Builder tiền thật có fill vào đầu tiên trong [from, to) (ghép fill như Signal Analysis). */
export async function loadVbRoundTrips(q: Q, from: Date, to: Date): Promise<VbRoundTrip[]> {
  const r = rows<{
    bot_id: string;
    market: string;
    tag: string;
    side: "buy" | "sell";
    price: string;
    size: string;
    fee: string;
    at: Date;
  }>(
    await q.execute(sql`
      select o.bot_id, b.market, o.tag, o.side, f.price::text as price, f.size::text as size,
             f.fee::text as fee, f.filled_at as at
        from fills f
        join orders o on o.id = f.order_id
        join bots b on b.id = o.bot_id
       where b.strategy = 'volume_farm' and b.mode = 'live' and o.tag like 'vf:%'
         and f.filled_at >= ${new Date(from.getTime() - DAY)} and f.filled_at < ${new Date(to.getTime() + 2 * 3_600_000)}
       order by f.filled_at
       limit ${LIMITS.ledgerFills + 1}`),
  );
  const byBot = new Map<
    string,
    { market: string; fills: Parameters<typeof groupTrades>[0][number][] }
  >();
  for (const f of capped(r, LIMITS.ledgerFills, "Volume Builder fills")) {
    const fill = {
      tag: f.tag,
      side: f.side,
      price: dec(f.price),
      size: dec(f.size),
      fee: dec(f.fee),
      at: new Date(f.at).getTime(),
    };
    const b = byBot.get(f.bot_id);
    if (b === undefined) byBot.set(f.bot_id, { market: f.market, fills: [fill] });
    else b.fills.push(fill);
  }
  const out: VbRoundTrip[] = [];
  for (const [botId, b] of byBot)
    for (const t of groupTrades(b.fills))
      if (t.t0 >= from.getTime() && t.t0 < to.getTime())
        out.push({ botId, market: b.market, ...t });
  return out;
}

/** D1 · Fill Market Making tiền thật trong [from, to), có giá markout 5 phút và cờ mở vị thế. */
export async function loadMmFills(q: Q, from: Date, to: Date): Promise<MmFill[]> {
  const starts = rows<{ bot_id: string; pos: string }>(
    await q.execute(sql`
      select o.bot_id, sum(case when o.side = 'buy' then f.size else -f.size end)::text as pos
        from fills f
        join orders o on o.id = f.order_id
        join bots b on b.id = o.bot_id
       where b.strategy = 'volume_maker' and b.mode = 'live' and f.filled_at < ${from}
       group by o.bot_id`),
  );
  const startPos = new Map(starts.map((s) => [s.bot_id, dec(s.pos)]));
  const r = rows<{
    bot_id: string;
    market: string;
    side: "buy" | "sell";
    price: string;
    size: string;
    fee: string;
    at: Date;
    markout: string | null;
  }>(
    await q.execute(sql`
      select o.bot_id, b.market, o.side, f.price::text as price, f.size::text as size, f.fee::text as fee,
             f.filled_at as at, c.close::text as markout
        from fills f
        join orders o on o.id = f.order_id
        join bots b on b.id = o.bot_id
        left join candles_1m c
          on c.market = b.market and c.ts = date_trunc('minute', f.filled_at + interval '300 seconds')
       where b.strategy = 'volume_maker' and b.mode = 'live'
         and f.filled_at >= ${from} and f.filled_at < ${to}
       order by f.filled_at
       limit ${LIMITS.ledgerFills + 1}`),
  );
  const byBot = new Map<string, Omit<MmFill, "opening">[]>();
  for (const f of capped(r, LIMITS.ledgerFills, "Market Making fills")) {
    const fill = {
      botId: f.bot_id,
      market: f.market,
      side: f.side,
      price: dec(f.price),
      size: dec(f.size),
      fee: dec(f.fee),
      at: new Date(f.at).getTime(),
      markout: f.markout === null ? null : dec(f.markout),
    };
    const list = byBot.get(f.bot_id);
    if (list === undefined) byBot.set(f.bot_id, [fill]);
    else list.push(fill);
  }
  return [...byBot].flatMap(([botId, fills]) =>
    markOpening(fills, startPos.get(botId) ?? new Decimal(0)),
  );
}

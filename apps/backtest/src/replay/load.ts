import { type DbTx } from "@drift/db";
import { dec, Decimal, SIGNAL_SNAPSHOT_RETENTION_DAYS } from "@drift/shared";
import { vbSignalSnapshotSchema } from "@drift/shared/vb-signal";
import { sql } from "drizzle-orm";

import type { ReplayEntry, Side } from "./vb-replay";

// Bộ nạp dữ liệu cho replay VB (#235). Chỉ đọc: chạy trong `readOnlyTx` (READ ONLY, statement timeout, trần thời gian tổng). Lấy
// lượt vào thật của bot Volume Builder tiền thật có snapshot tín hiệu v1 (DEC-311), ghép với lượt đã đóng từ fill thật,
// và giá xa nhất trong 10 s sau lúc quyết định (mid_1s khi có, không thì nến 1 phút).

export type Q = DbTx;

const DAY_MS = 86_400_000;
/** Lệnh vào post-only sống 10 s (FARM_TIMING.entryFillMs). */
const ENTRY_WINDOW_MS = 10_000;
/** Lượt có thể đóng sau cuối khoảng tới thời gian giữ tối đa (3600 s) + đợi thoát. */
const CLOSE_LOOKAHEAD_MS = 2 * 3_600_000;

const rows = <T>(r: unknown): T[] => (r as { rows: T[] }).rows;

interface Fill {
  tag: string;
  side: "buy" | "sell";
  price: Decimal;
  size: Decimal;
  fee: Decimal;
  at: number;
}

interface Trade {
  t0: number;
  t1: number;
  side: Side;
  entryPrice: Decimal;
  exitPrice: Decimal;
  qty: Decimal;
  fees: Decimal;
  volume: Decimal;
}

const TAG = /^vf:(\d+):(in|out|sl)/;

/**
 * Ghép fill thành lượt theo đúng quy tắc của `buildTrades` (Review this run / Strategy Analytics), tính tiền bằng Decimal.
 * Cùng logic với `groupTrades` của API AI Desk; gộp ba bản làm một ở #245.
 */
export function groupTrades(fills: readonly Fill[]): Trade[] {
  const out: Trade[] = [];
  // `as`: TypeScript không theo dõi lần gán trong `close`.
  let cur = null as { cycle: number; ins: Fill[]; outs: Fill[] } | null;
  const sum = (fs: readonly Fill[], f: (x: Fill) => Decimal) =>
    fs.reduce((s, x) => s.add(f(x)), new Decimal(0));
  const close = () => {
    if (cur === null || cur.ins.length === 0 || cur.outs.length === 0) return;
    const qIn = sum(cur.ins, (f) => f.size);
    const qOut = sum(cur.outs, (f) => f.size);
    if (qOut.lt(qIn.mul(0.999))) return;
    const first = cur.ins[0];
    const last = cur.outs.at(-1);
    if (first === undefined || last === undefined) return;
    const all = [...cur.ins, ...cur.outs];
    out.push({
      t0: first.at,
      t1: last.at,
      side: first.side === "buy" ? "long" : "short",
      entryPrice: sum(cur.ins, (f) => f.price.mul(f.size)).div(qIn),
      exitPrice: sum(cur.outs, (f) => f.price.mul(f.size)).div(qOut),
      qty: qIn,
      fees: sum(all, (f) => f.fee),
      volume: sum(all, (f) => f.price.mul(f.size)),
    });
  };
  for (const f of [...fills].sort((a, b) => a.at - b.at)) {
    const m = TAG.exec(f.tag);
    if (m === null) continue;
    const cycle = Number(m[1]);
    if (m[2] === "in" && (cur?.cycle !== cycle || cur.outs.length > 0)) {
      close();
      cur = { cycle, ins: [], outs: [] };
    }
    if (cur === null) continue;
    if (m[2] === "in") cur.ins.push(f);
    else cur.outs.push(f);
  }
  close();
  return out;
}

/** Khoảng tối đa một lần chạy (PM: bounded ranges and memory; container backtest có 2 GB). */
export const MAX_RANGE_DAYS = 14;
/** Trần số event "Enter" có snapshot và trần tổng số fill nạp vào bộ nhớ. */
export const MAX_EVENTS = 100_000;
export const MAX_FILLS = 1_000_000;
/** Số mốc thời gian mỗi câu giá 10 s (một câu LATERAL cho cả lô). */
const REACH_BATCH = 5_000;

/** Vượt trần: CLI dừng với thông báo rõ ràng, không in báo cáo thiếu. */
export class ReplayLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReplayLimitError";
  }
}

/**
 * Kiểm khoảng chạy. `now` là giờ hiện tại (ms): scheduler bỏ snapshot tín hiệu cũ hơn `SIGNAL_SNAPSHOT_RETENTION_DAYS`
 * ngày (#229), nên khoảng bắt đầu trước mốc đó sẽ mất lượt vào mà không ai biết (quy tắc 1.8): từ chối thay vì chạy.
 */
export function checkRange(from: Date, to: Date, now: number): void {
  if (to <= from) throw new ReplayLimitError("--to must be after --from");
  if (to.getTime() - from.getTime() > MAX_RANGE_DAYS * DAY_MS)
    throw new ReplayLimitError(
      `range is longer than ${String(MAX_RANGE_DAYS)} days; run several shorter ranges instead`,
    );
  const kept = new Date(now - SIGNAL_SNAPSHOT_RETENTION_DAYS * DAY_MS);
  if (from < kept)
    throw new ReplayLimitError(
      `--from is more than ${String(SIGNAL_SNAPSHOT_RETENTION_DAYS)} days ago; signal snapshots older than ${String(SIGNAL_SNAPSHOT_RETENTION_DAYS)} days are removed, so entries before ${kept.toISOString()} cannot be replayed`,
    );
}

export interface LoadResult {
  entries: ReplayEntry[];
  /** Số event "Enter" có snapshot hợp lệ trong khoảng. */
  snapshots: number;
  /** Snapshot không parse được (bỏ). */
  invalid: number;
  /** Lượt vào không khớp (lệnh vào huỷ sau 10 s) hoặc chưa đóng trước khi hết dữ liệu. */
  unmatched: number;
  /** Số lượt có giá 10 s từ mid_1s / từ nến 1 phút / không có. */
  reach: { mid1s: number; candle: number; none: number };
}

export async function loadEntries(
  q: Q,
  opts: {
    from: Date;
    to: Date;
    /** Giờ hiện tại (ms), để kiểm `from` còn trong thời hạn giữ snapshot. */
    now: number;
    ticks: ReadonlyMap<string, Decimal>;
    /** Gọi giữa các câu để dừng khi quá trần thời gian tổng (`readOnlyTx`). */
    checkDeadline?: () => void;
  },
): Promise<LoadResult> {
  checkRange(opts.from, opts.to, opts.now);
  const check = opts.checkDeadline ?? (() => undefined);
  const events = rows<{ bot_id: string; market: string; at: Date; signal: unknown }>(
    await q.execute(sql`
      select e.bot_id, b.market, e.occurred_at as at, e.payload -> 'signal' as signal
        from bot_events e
        join bots b on b.id = e.bot_id
       where b.strategy = 'volume_farm' and b.mode = 'live'
         and e.decision like 'Enter%'
         and e.occurred_at >= ${opts.from} and e.occurred_at < ${opts.to}
         and e.payload ? 'signal'
       order by e.occurred_at
       limit ${MAX_EVENTS + 1}`),
  );
  if (events.length > MAX_EVENTS)
    throw new ReplayLimitError(
      `more than ${String(MAX_EVENTS)} entry decisions in range; use a shorter range`,
    );
  let invalid = 0;
  const parsed = events.flatMap((e) => {
    const s = vbSignalSnapshotSchema.safeParse(e.signal);
    if (!s.success) {
      invalid += 1;
      return [];
    }
    return [{ botId: e.bot_id, market: e.market, at: new Date(e.at).getTime(), s: s.data }];
  });
  const byBot = new Map<string, typeof parsed>();
  // Thêm vào mảng sẵn có (không chép lại mảng mỗi lần: O(n), không O(n²)).
  for (const p of parsed) {
    const list = byBot.get(p.botId);
    if (list === undefined) byBot.set(p.botId, [p]);
    else list.push(p);
  }

  const matched: { p: (typeof parsed)[number]; trade: Trade }[] = [];
  let unmatched = 0;
  let fillsRead = 0;
  for (const [botId, list] of byBot) {
    check();
    const since = new Date(opts.from.getTime() - DAY_MS);
    const until = new Date(opts.to.getTime() + CLOSE_LOOKAHEAD_MS);
    const left = MAX_FILLS - fillsRead;
    const fs = rows<{
      tag: string;
      side: "buy" | "sell";
      price: string;
      size: string;
      fee: string;
      at: Date;
      cl_ord_id: string;
    }>(
      await q.execute(sql`
        select o.tag, o.side, o.cl_ord_id, f.price::text as price, f.size::text as size,
               f.fee::text as fee, f.filled_at as at
          from orders o join fills f on f.order_id = o.id
         where o.bot_id = ${botId}::uuid and o.tag like 'vf:%'
           and o.created_at >= ${new Date(since.getTime() - DAY_MS)}
           and f.filled_at >= ${since} and f.filled_at < ${until}
         limit ${left + 1}`),
    );
    fillsRead += fs.length;
    if (fillsRead > MAX_FILLS)
      throw new ReplayLimitError(
        `more than ${String(MAX_FILLS)} fills in range; use a shorter range`,
      );
    const firstFill = new Map<string, number>();
    for (const f of fs) {
      const t = new Date(f.at).getTime();
      const prev = firstFill.get(f.cl_ord_id);
      if (prev === undefined || t < prev) firstFill.set(f.cl_ord_id, t);
    }
    const trades = new Map(
      groupTrades(
        fs.map((f) => ({
          tag: f.tag,
          side: f.side,
          price: dec(f.price),
          size: dec(f.size),
          fee: dec(f.fee),
          at: new Date(f.at).getTime(),
        })),
      ).map((t) => [t.t0, t]),
    );
    for (const p of list) {
      const t0 = firstFill.get(p.s.order.clOrdID);
      const trade = t0 === undefined ? undefined : trades.get(t0);
      if (trade === undefined) unmatched += 1;
      else matched.push({ p, trade });
    }
  }

  // Giá 10 s: một câu cho mỗi lô mốc thời gian của từng market (không N+1).
  const byMarket = new Map<string, number[]>();
  for (const m of matched) {
    const ats = byMarket.get(m.p.market);
    if (ats === undefined) byMarket.set(m.p.market, [m.p.at]);
    else ats.push(m.p.at);
  }
  const reachAt = new Map<string, ReplayEntry["reach"]>();
  for (const [market, ats] of byMarket) {
    const uniq = [...new Set(ats)];
    for (let i = 0; i < uniq.length; i += REACH_BATCH) {
      check();
      const batch = uniq.slice(i, i + REACH_BATCH);
      for (const [at, r] of await reachBatch(q, market, batch))
        reachAt.set(`${market}@${String(at)}`, r);
    }
  }

  const entries: ReplayEntry[] = [];
  const reach = { mid1s: 0, candle: 0, none: 0 };
  for (const { p, trade } of matched) {
    const r = reachAt.get(`${p.market}@${String(p.at)}`) ?? null;
    if (r === null) reach.none += 1;
    else if (r.source === "mid_1s") reach.mid1s += 1;
    else reach.candle += 1;
    entries.push({
      botId: p.botId,
      market: p.market,
      at: p.at,
      direction: p.s.direction,
      side: p.s.side,
      reversed: p.s.reversed,
      balanced: p.s.balanced,
      regime: p.s.regime,
      components: p.s.components,
      chgBps: { m1: p.s.price.chg1mBps, m3: p.s.price.chg3mBps, m5: p.s.price.chg5mBps },
      entryPrice: trade.entryPrice,
      exitPrice: trade.exitPrice,
      qty: trade.qty,
      fees: trade.fees,
      volume: trade.volume,
      t0: trade.t0,
      t1: trade.t1,
      tick: opts.ticks.get(p.market) ?? null,
      reach: r,
    });
  }
  return { entries, snapshots: parsed.length, invalid, unmatched, reach };
}

/**
 * Giá thấp / cao nhất trong 10 s sau mỗi lúc quyết định của một market, một câu cho cả lô: mid_1s khi có, không thì nến 1
 * phút chứa khung đó (gồm cả phần phút TRƯỚC lúc quyết định).
 */
async function reachBatch(
  q: Q,
  market: string,
  ats: readonly number[],
): Promise<Map<number, ReplayEntry["reach"]>> {
  // Một tham số mảng (chuỗi ISO không chứa dấu phẩy hay ngoặc nhọn).
  const arr = `{${ats.map((t) => new Date(t).toISOString()).join(",")}}`;
  const r = rows<{
    i: number;
    mlo: string | null;
    mhi: string | null;
    clo: string | null;
    chi: string | null;
  }>(
    await q.execute(sql`
      select t.i::int as i, m.lo::text as mlo, m.hi::text as mhi, c.lo::text as clo, c.hi::text as chi
        from unnest(${arr}::timestamptz[]) with ordinality as t(at, i)
        left join lateral (
          select min(mid) as lo, max(mid) as hi from mid_1s
           where market = ${market} and ts >= t.at and ts <= t.at + make_interval(secs => ${ENTRY_WINDOW_MS / 1000}::float8)) m on true
        left join lateral (
          select min(low) as lo, max(high) as hi from candles_1m
           where market = ${market}
             and ts >= date_trunc('minute', t.at)
             and ts <= date_trunc('minute', t.at + make_interval(secs => ${ENTRY_WINDOW_MS / 1000}::float8))) c on true`),
  );
  const out = new Map<number, ReplayEntry["reach"]>();
  for (const x of r) {
    const at = ats[x.i - 1];
    if (at === undefined) continue;
    out.set(
      at,
      x.mlo !== null && x.mhi !== null
        ? { low: dec(x.mlo), high: dec(x.mhi), source: "mid_1s" }
        : x.clo !== null && x.chi !== null
          ? { low: dec(x.clo), high: dec(x.chi), source: "candle" }
          : null,
    );
  }
  return out;
}

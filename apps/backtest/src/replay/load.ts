import { type Db } from "@drift/db";
import { dec, Decimal } from "@drift/shared";
import { vbSignalSnapshotSchema } from "@drift/shared/vb-signal";
import { sql } from "drizzle-orm";

import type { ReplayEntry, Side } from "./vb-replay";

// Bộ nạp dữ liệu cho replay VB (#235). Chỉ đọc: chạy trong transaction READ ONLY có statement timeout (do CLI mở). Lấy
// lượt vào thật của bot Volume Builder tiền thật có snapshot tín hiệu v1 (DEC-311), ghép với lượt đã đóng từ fill thật,
// và giá xa nhất trong 10 s sau lúc quyết định (mid_1s khi có, không thì nến 1 phút).

export type Q = Parameters<Parameters<Db["transaction"]>[0]>[0];

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
  opts: { from: Date; to: Date; ticks: ReadonlyMap<string, Decimal> },
): Promise<LoadResult> {
  const events = rows<{ bot_id: string; market: string; at: Date; signal: unknown }>(
    await q.execute(sql`
      select e.bot_id, b.market, e.occurred_at as at, e.payload -> 'signal' as signal
        from bot_events e
        join bots b on b.id = e.bot_id
       where b.strategy = 'volume_farm' and b.mode = 'live'
         and e.decision like 'Enter%'
         and e.occurred_at >= ${opts.from} and e.occurred_at < ${opts.to}
         and e.payload ? 'signal'
       order by e.occurred_at`),
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
  for (const p of parsed) byBot.set(p.botId, [...(byBot.get(p.botId) ?? []), p]);

  const entries: ReplayEntry[] = [];
  const reach = { mid1s: 0, candle: 0, none: 0 };
  let unmatched = 0;
  for (const [botId, list] of byBot) {
    const since = new Date(opts.from.getTime() - DAY_MS);
    const until = new Date(opts.to.getTime() + CLOSE_LOOKAHEAD_MS);
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
           and f.filled_at >= ${since} and f.filled_at < ${until}`),
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
      if (trade === undefined) {
        unmatched += 1;
        continue;
      }
      const r = await reachOf(q, p.market, p.at);
      if (r === null) reach.none += 1;
      else if (r.source === "mid_1s") reach.mid1s += 1;
      else reach.candle += 1;
      entries.push({
        botId,
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
  }
  return { entries, snapshots: parsed.length, invalid, unmatched, reach };
}

/** Giá thấp / cao nhất trong 10 s sau lúc quyết định: mid_1s khi có, không thì nến 1 phút chứa khung đó. */
async function reachOf(q: Q, market: string, at: number): Promise<ReplayEntry["reach"]> {
  const a = new Date(at);
  const b = new Date(at + ENTRY_WINDOW_MS);
  const [m] = rows<{ lo: string | null; hi: string | null }>(
    await q.execute(sql`
      select min(mid)::text as lo, max(mid)::text as hi from mid_1s
       where market = ${market} and ts >= ${a} and ts <= ${b}`),
  );
  if (m?.lo != null && m.hi != null) return { low: dec(m.lo), high: dec(m.hi), source: "mid_1s" };
  const minute = (t: number) => new Date(Math.floor(t / 60_000) * 60_000);
  const [c] = rows<{ lo: string | null; hi: string | null }>(
    await q.execute(sql`
      select min(low)::text as lo, max(high)::text as hi from candles_1m
       where market = ${market} and ts >= ${minute(at)} and ts <= ${minute(at + ENTRY_WINDOW_MS)}`),
  );
  if (c?.lo != null && c.hi != null) return { low: dec(c.lo), high: dec(c.hi), source: "candle" };
  return null;
}

import type { DbTx } from "@drift/db";
import { dec, Decimal } from "@drift/shared";
import { sql } from "drizzle-orm";

import { StudyLimitError } from "../vb-counter-trend/load";

// Dòng hiệu chỉnh của #363: so cost / $1M của baseline backtest với cost THẬT của bot Volume Builder tiền thật cùng market,
// cùng kỳ. Cost thật tính đúng công thức tab Volume Builder của trang Signal Analysis (DEC-318,
// `apps/api/src/modules/signal-analysis/vb.ts` `buildVbTrades` / `tradeOf` / `rowOf`): fill của mỗi bot gom theo lượt
// `vf:<n>:in|out|sl`; lượt chỉ tính khi đã đóng đủ (khối lượng đóng ≥ 99.9% khối lượng vào); volume = khối lượng vào × giá vào
// trung bình + khối lượng đóng × giá đóng trung bình; kết quả = lãi / lỗ giá trên khối lượng vào − tổng phí các fill;
// Net / $1M = Σ kết quả ÷ Σ volume × 1M (`perM`). Ở đây cost = −Net / $1M (dương = tốn), cùng dấu với bảng của công cụ.
// Chỉ đọc (SELECT trong `readOnlyTx` của CLI), có trần số dòng.

const MAX_LIVE_FILLS = 300_000;
const TAG = /^vf:(\d+):(in|out|sl)/;

export interface LiveVbFill {
  botId: string;
  /** Epoch ms. */
  at: number;
  side: "buy" | "sell";
  price: string;
  size: string;
  fee: string;
  maker: boolean | null;
  tag: string;
}

export interface CostTrade {
  at: number;
  volume: Decimal;
  net: Decimal;
  fees: Decimal;
  makerVolume: Decimal;
}

const rows = <T>(r: unknown): T[] => (r as { rows: T[] }).rows;

/** Fill của bot Volume Builder tiền thật (`mode = live`) trên `market`, khớp trong [from, to), theo bot rồi thời gian. */
export async function loadLiveVbFills(
  q: DbTx,
  o: { market: string; from: Date; to: Date },
): Promise<LiveVbFill[]> {
  const r = rows<{
    botId: string;
    at: number;
    side: "buy" | "sell";
    price: string;
    size: string;
    fee: string;
    maker: boolean | null;
    tag: string | null;
  }>(
    await q.execute(sql`
      select o.bot_id::text as "botId", (extract(epoch from f.filled_at) * 1000)::float8 as at, o.side,
             f.price::text as price, f.size::text as size, f.fee::text as fee, f.is_maker as maker, o.tag
        from fills f
        join orders o on o.id = f.order_id
        join bots b on b.id = o.bot_id
       where b.mode = 'live' and b.strategy = 'volume_farm' and o.market = ${o.market}
         and f.filled_at >= ${o.from} and f.filled_at < ${o.to}
       order by o.bot_id, f.filled_at, f.id
       limit ${MAX_LIVE_FILLS + 1}`),
  );
  if (r.length > MAX_LIVE_FILLS)
    throw new StudyLimitError(
      `${o.market}: more than ${String(MAX_LIVE_FILLS)} live Volume Builder fills; use a shorter range`,
    );
  return r.flatMap((x) => (x.tag === null ? [] : [{ ...x, tag: x.tag }]));
}

const sum = <T>(xs: readonly T[], f: (x: T) => Decimal) =>
  xs.reduce((s, x) => s.add(f(x)), new Decimal(0));

/** Lượt đã đóng của bot thật, như `buildVbTrades` + `tradeOf` của trang Signal Analysis. Fill phải theo bot rồi thời gian. */
export function liveTrades(fills: readonly LiveVbFill[]): CostTrade[] {
  const out: CostTrade[] = [];
  interface Cycle {
    bot: string;
    cycle: number;
    ins: LiveVbFill[];
    outs: LiveVbFill[];
  }
  const close = (cur: Cycle | null) => {
    if (cur === null || cur.ins.length === 0 || cur.outs.length === 0) return;
    const { ins, outs } = cur;
    const qIn = sum(ins, (f) => dec(f.size));
    const qOut = sum(outs, (f) => dec(f.size));
    if (qIn.isZero() || qOut.lt(qIn.mul(0.999))) return;
    const entry = sum(ins, (f) => dec(f.price).mul(f.size)).div(qIn);
    const exit = sum(outs, (f) => dec(f.price).mul(f.size)).div(qOut);
    const long = ins[0]?.side === "buy";
    const all = [...ins, ...outs];
    const fees = sum(all, (f) => dec(f.fee));
    const gross = (long ? exit.sub(entry) : entry.sub(exit)).mul(qIn);
    out.push({
      at: ins[0]?.at ?? 0,
      volume: qIn.mul(entry).add(qOut.mul(exit)),
      net: gross.sub(fees),
      fees,
      makerVolume: sum(all, (f) => (f.maker === true ? dec(f.price).mul(f.size) : new Decimal(0))),
    });
  };
  const st: { cur: Cycle | null } = { cur: null };
  for (const f of fills) {
    const m = TAG.exec(f.tag);
    if (m === null) continue;
    const cycle = Number(m[1]);
    const isIn = m[2] === "in";
    const prev = st.cur?.bot === f.botId ? st.cur : null;
    if (prev !== st.cur) close(st.cur);
    st.cur = prev;
    const continues = prev !== null && prev.cycle === cycle && prev.outs.length === 0;
    if (isIn && !continues) {
      close(prev);
      st.cur = { bot: f.botId, cycle, ins: [], outs: [] };
    }
    if (st.cur === null) continue;
    if (isIn) st.cur.ins.push(f);
    else st.cur.outs.push(f);
  }
  close(st.cur);
  return out.sort((a, b) => a.at - b.at);
}

export interface CostSplit {
  trades: number;
  volume: Decimal;
  /** −Σ kết quả ÷ Σ volume × 1M; null = không có volume ("Not available"). */
  costPerM: Decimal | null;
  /** Σ phí ÷ Σ volume × 1M. */
  feesPerM: Decimal | null;
  /** Phần còn lại: −Σ lãi / lỗ giá ÷ Σ volume × 1M (trượt, khớp, chọn hướng). */
  pricePerM: Decimal | null;
  /** % volume khớp maker. */
  makerPct: Decimal | null;
}

export function costSplit(ts: readonly CostTrade[]): CostSplit {
  const volume = sum(ts, (t) => t.volume);
  const per = (v: Decimal) => (volume.isZero() ? null : v.div(volume).mul(1_000_000));
  const net = sum(ts, (t) => t.net);
  const fees = sum(ts, (t) => t.fees);
  return {
    trades: ts.length,
    volume,
    costPerM: per(net.neg()),
    feesPerM: per(fees),
    pricePerM: per(net.add(fees).neg()),
    makerPct: volume.isZero()
      ? null
      : sum(ts, (t) => t.makerVolume)
          .div(volume)
          .mul(100),
  };
}

/**
 * Lệch lớn: |backtest − thật| > max(50, 30% × |thật|) USDC / $1M. Khi đó số tuyệt đối của backtest không đáng tin, chỉ
 * nên đọc Δ cost (ô − baseline, cùng mô hình).
 */
export function largeGap(backtest: Decimal | null, live: Decimal | null): boolean {
  if (backtest === null || live === null) return false;
  return backtest
    .sub(live)
    .abs()
    .gt(Decimal.max(50, live.abs().mul(0.3)));
}

import {
  AppError,
  decimalStringSchema,
  ErrorCode,
  MM_BREAKDOWNS,
  SIGNAL_MIN_GROUP,
  SIGNAL_MM_HORIZONS,
  SIGNAL_PAGE_SIZE,
  SIGNAL_RANGE_MS,
  signalMmFillsQuerySchema,
  signalMmQuerySchema,
  type MmBreakdown,
  type MmFill,
  type MmFillDetail,
  type MmRow,
  type SignalHiddenLead,
  type SignalMmFillsPage,
  type SignalMmQuery,
  type SignalMmView,
  type SignalSuggestion,
} from "@drift/shared";
import {
  mmOrderContextSchema,
  mmQuoteSnapshotSchema,
  type MmOrderContext,
} from "@drift/shared/mm-quote";
import { VM_ORACLE } from "@drift/strategies";
import { sql, type SQL } from "drizzle-orm";
import { z } from "zod";

import { parseOrThrow } from "../../lib/http";

import { activeBots, botFacets } from "./all";
import {
  costBasisAt,
  D0,
  dec,
  Decimal,
  inList,
  isThin,
  liveBots,
  marksAt,
  perM,
  positionsAt,
  r2,
  readOnly,
  rowsOf,
  str,
  team,
  type BotInfo,
  type Exec,
  type SignalDeps,
  type Window,
} from "./common";
import {
  addSums,
  baseCte,
  carriedOf,
  costOf,
  deltaOf,
  previousNet,
  sumsOf,
  SUMS_SQL,
  type Marks,
  type Sums,
  type SumsRow,
} from "./data";
import { extraSet, previousSet, snapshotOf, type Snapshot } from "./sets";
import { timelineOf } from "./timeline";

// Tab Market Making: mỗi fill của bot Market Making tiền thật, cộng trong SQL (review #246 điểm 4: 30 ngày ~300k fill
// không kéo về Node). bp theo notional của fill, + = có lợi cho fill:
//   spread kiếm được = chiều × (mid lúc fill − giá khớp) ÷ giá khớp; mid lúc fill = mid SoDEX trong giây đó (mid_1s, 48 giờ),
//   không có thì mid lúc đặt lệnh (`orders.context.mid`, DEC-312 / #233).
//   markout t = chiều × (giá sau t − giá khớp) ÷ giá khớp (đã gồm spread); giá chạy ngược = markout 1 phút − spread.
// $ / 1M (dương = tốn) dùng `costOf` như tab All. Quote level / Smart quoting / Binance clamp lấy từ `orders.context`
// (đọc an toàn: giá trị sai kiểu → null); fill cũ hơn không có → "Not available".

/** Sai số làm tròn tick khi so giá báo với giới hạn Binance (bp). */
const CLAMP_TOLERANCE_BP = 0.25;
/** Số lần cắt tối đa tính kết quả (mỗi lần một truy vấn có giới hạn); nhiều hơn → tổng "Not available". */
const MAX_CUTS = 500;

/**
 * Lệnh mở của bot bật Smart quoting nằm đúng giới hạn Binance (mua = giá Binance − 0,5 bp, bán = + 0,5 bp, sai số làm
 * tròn tick ≤ 0,25 bp) → "hit"; còn lại "normal". Tắt Smart quoting / lệnh đóng / không có bối cảnh → null. Cùng điều kiện
 * với cột `clamp` trong SQL (`derived`).
 */
export function clampOf(side: "buy" | "sell", ctx: MmOrderContext | null, reduceOnly: boolean) {
  if (ctx === null || !ctx.smart || reduceOnly) return null;
  if (ctx.fairBp === null || ctx.fairAgeMs === null || ctx.fairAgeMs > VM_ORACLE.maxAgeMs)
    return "normal";
  const limit = side === "buy" ? -VM_ORACLE.marginBp : VM_ORACLE.marginBp;
  return Math.abs(ctx.fairBp - limit) <= CLAMP_TOLERANCE_BP ? "hit" : "normal";
}

const botLevel = (q: SignalMmQuery, b: BotInfo) =>
  (q.market === undefined || b.market === q.market) && (q.botId === undefined || b.id === q.botId);
const fillLevel = (q: SignalMmQuery) =>
  q.level !== undefined || q.smart !== undefined || q.side !== undefined;

function botWhere(q: SignalMmQuery): SQL | undefined {
  const p: SQL[] = [];
  if (q.market !== undefined) p.push(sql`b.market = ${q.market}`);
  if (q.botId !== undefined) p.push(sql`b.id = ${q.botId}::uuid`);
  return p.length === 0 ? undefined : sql.join(p, sql` and `);
}

function fillWhere(q: SignalMmQuery): SQL {
  const p: SQL[] = [sql`true`];
  if (q.level !== undefined) p.push(sql`lvl = ${q.level}`);
  if (q.smart !== undefined) p.push(sql`smart = ${q.smart === "on"}`);
  if (q.side !== undefined) p.push(sql`side = ${q.side}`);
  return sql.join(p, sql` and `);
}

/** CTE `x`: các cột cần cho thống kê của những fill qua bộ lọc theo fill (hẹp, không chép cả dòng nền). */
function derived(q: SignalMmQuery, w: Window, extraWhere?: SQL, ids?: SQL): SQL {
  const where = [botWhere(q), extraWhere].filter((x): x is SQL => x !== undefined);
  return sql`${baseCte({
    w,
    strategies: ["volume_maker"],
    mm: true,
    // `x` được đọc hai lần (nhóm và phân vị): tính nền một lần.
    materialized: true,
    tz: q.tz,
    clamp: {
      maxAgeMs: VM_ORACLE.maxAgeMs,
      marginBp: VM_ORACLE.marginBp,
      toleranceBp: CLAMP_TOLERANCE_BP,
    },
    ...(where.length === 0 ? {} : { where: sql.join(where, sql` and `) }),
    ...(ids === undefined ? {} : { ids }),
  })},
    x as not materialized (
      select id, at, bot_id, market, side, usd, fee, builder_fee, r60, mk_usd, end_usd, mid0, spread_usd,
             b0, b10, b30, b60, b120, b300, fee_bp, has_ctx, lvl, smart, clamp, kind, block, band
        from base where ${fillWhere(q)})`;
}

interface Stats {
  sums: Sums;
  /** Trung bình bp lúc fill, 10 s, 30 s, 1, 2, 5 phút. */
  avg: (number | null)[];
  cnt: number[];
  /** % markout < 0 ở mỗi mốc. */
  against: (number | null)[];
  againstBp: number | null;
  naf: number | null;
  feeBp: number | null;
  ctx: number;
  bots: string[];
  /** Fill có cả giá 1 phút và mid lúc fill: volume và Σ spread (USDC). */
  sVol: Decimal;
  sUsd: Decimal;
}

const H = ["0", "10", "30", "60", "120", "300"] as const;

/** Một nhóm nhỏ nhất (mọi chiều breakdown cùng lúc); Node cộng lại thành từng chiều (cộng được: tổng và số đếm). */
interface FineRow extends SumsRow {
  lvl_k: string;
  smart_k: string;
  clamp_k: string;
  block: string;
  market: string;
  band: string;
  side: string;
  /** Σ bp, số mẫu, số mẫu < 0 ở mỗi mốc (lúc fill, 10 s, 30 s, 1, 2, 5 phút). */
  sb: (number | null)[];
  nb: number[];
  neg: number[];
  ab_s: number | null;
  ab_n: number;
  naf_s: number | null;
  naf_n: number;
  fee_s: number | null;
  fee_n: number;
  ctx: number;
  s_vol: string;
  s_usd: string;
}

interface WalkRow {
  bot: string;
  flat_ms: number | null;
  span_ms: number | null;
  held_ms: number | null;
  held_usd_ms: number | null;
}

interface CutRow {
  id: string;
  at: number;
  created_at: number;
  bot: string;
  market: string;
  price: string;
  size: string;
  fee: string;
  pos_before: string;
  /** Giá vào bình quân của vị thế bị cắt; null = không tính được. */
  entry: string | null;
  opened_at: number | null;
}

interface MmData {
  window: Window;
  bots: Map<string, BotInfo>;
  active: Set<string>;
  groups: Map<string, Stats>;
  quant: { p25: (number | null)[]; p75: (number | null)[] };
  walk: WalkRow[];
  cuts: CutView[];
  cutsComplete: boolean;
  marks: Marks;
  orders: OrderCount[] | null;
}

interface OrderCount {
  bot: string;
  level: number;
  smart: boolean;
  side: "buy" | "sell";
  placed: number;
  filled: number;
}

interface CutView {
  fillId: string;
  at: number;
  botId: string;
  market: string;
  position: "long" | "short";
  entry: Decimal | null;
  price: Decimal;
  heldSecs: number | null;
  result: Decimal | null;
  moveBp: number | null;
}

interface Fine {
  sums: Sums;
  sb: number[];
  nb: number[];
  neg: number[];
  abS: number;
  abN: number;
  nafS: number;
  nafN: number;
  feeS: number;
  feeN: number;
  ctx: number;
  sVol: Decimal;
  sUsd: Decimal;
}

const fineOf = (r: FineRow): Fine => ({
  sums: sumsOf(r),
  sb: H.map((_, i) => r.sb[i] ?? 0),
  nb: H.map((_, i) => r.nb[i] ?? 0),
  neg: H.map((_, i) => r.neg[i] ?? 0),
  abS: r.ab_s ?? 0,
  abN: r.ab_n,
  nafS: r.naf_s ?? 0,
  nafN: r.naf_n,
  feeS: r.fee_s ?? 0,
  feeN: r.fee_n,
  ctx: r.ctx,
  sVol: dec(r.s_vol),
  sUsd: dec(r.s_usd),
});

const addFine = (a: Fine, b: Fine): Fine => ({
  sums: addSums(a.sums, b.sums),
  sb: a.sb.map((x, i) => x + (b.sb[i] ?? 0)),
  nb: a.nb.map((x, i) => x + (b.nb[i] ?? 0)),
  neg: a.neg.map((x, i) => x + (b.neg[i] ?? 0)),
  abS: a.abS + b.abS,
  abN: a.abN + b.abN,
  nafS: a.nafS + b.nafS,
  nafN: a.nafN + b.nafN,
  feeS: a.feeS + b.feeS,
  feeN: a.feeN + b.feeN,
  ctx: a.ctx + b.ctx,
  sVol: a.sVol.add(b.sVol),
  sUsd: a.sUsd.add(b.sUsd),
});

const ratio = (s: number, n: number): number | null => (n === 0 ? null : s / n);

const statsOfFine = (f: Fine, bots: string[]): Stats => ({
  sums: f.sums,
  avg: f.sb.map((x, i) => ratio(x, f.nb[i] ?? 0)),
  cnt: f.nb,
  against: f.neg.map((x, i) => {
    const r = ratio(x, f.nb[i] ?? 0);
    return r === null ? null : r * 100;
  }),
  againstBp: ratio(f.abS, f.abN),
  naf: ratio(f.nafS, f.nafN),
  feeBp: ratio(f.feeS, f.feeN),
  ctx: f.ctx,
  bots,
  sVol: f.sVol,
  sUsd: f.sUsd,
});

/** Cộng các nhóm nhỏ nhất thành thống kê theo từng chiều ("dim|key") và "all|all". */
export function rollUp(rows: readonly FineRow[], bots: string[]): Map<string, Stats> {
  const acc = new Map<string, Fine>();
  const add = (k: string, f: Fine) => {
    const cur = acc.get(k);
    acc.set(k, cur === undefined ? f : addFine(cur, f));
  };
  for (const r of rows) {
    const f = fineOf(r);
    add("all|all", f);
    add(`level|${r.lvl_k}`, f);
    add(`smart|${r.smart_k}`, f);
    add(`clamp|${r.clamp_k}`, f);
    add(`hour|${r.block}`, f);
    add(`market|${r.market}`, f);
    add(`size|${r.band}`, f);
    add(`side|${r.side}`, f);
  }
  return new Map([...acc].map(([k, f]) => [k, statsOfFine(f, k === "all|all" ? bots : [])]));
}

/**
 * Một truy vấn cho cả trang (nền tính một lần): thống kê theo mọi chiều breakdown, phân vị của "Price after the fill",
 * đi lại vị thế từng bot (thời gian phẳng, vị thế trung bình) và các lần cắt vị thế. Vị thế đầu kỳ của bot đưa vào
 * bằng VALUES.
 */
async function loadMm(q: Exec, w: Window, qq: SignalMmQuery): Promise<MmData> {
  const botsAll = await liveBots(q, ["volume_maker"]);
  const bots = new Map(botsAll.map((b) => [b.id, b]));
  const active = await activeBots(q, w, ["volume_maker"]);
  const ids = [...active].filter((id) => {
    const b = bots.get(id);
    return b !== undefined && botLevel(qq, b);
  });
  const [posStart] = await positionsAt(q, ids, [w.from]);
  const pos = posStart ?? new Map<string, Decimal>();
  const hz = (fn: (h: string) => string) => sql.raw(H.map(fn).join(", "));
  const r = await q.execute(sql`
    with ${derived(qq, w)},
    g as (
      select coalesce(lvl::text, 'unknown') as lvl_k,
             case when smart is null then 'unknown' when smart then 'on' else 'off' end as smart_k,
             case when not has_ctx then 'unknown' when smart is false then 'off' else coalesce(clamp, 'normal') end as clamp_k,
             block, market, band, side, ${SUMS_SQL},
             array[${hz((h) => `sum(b${h})`)}] as sb,
             array[${hz((h) => `count(b${h})::int`)}] as nb,
             array[${hz((h) => `(count(*) filter (where b${h} < 0))::int`)}] as neg,
             sum(b60 - b0) as ab_s, count(b60 - b0)::int as ab_n,
             sum(b60 - fee_bp) as naf_s, count(b60 - fee_bp)::int as naf_n,
             sum(fee_bp) as fee_s, count(fee_bp)::int as fee_n,
             (count(*) filter (where has_ctx))::int as ctx,
             coalesce(sum(usd) filter (where r60 is not null and mid0 is not null), 0)::text as s_vol,
             coalesce(sum(spread_usd) filter (where r60 is not null and mid0 is not null), 0)::text as s_usd
        from x
        group by 1, 2, 3, 4, 5, 6, 7),
    qn as (
      select ${hz((h) => `percentile_cont(0.25) within group (order by b${h}) as p25_${h}, percentile_cont(0.75) within group (order by b${h}) as p75_${h}`)},
             array_agg(distinct bot_id::text) as bot_ids
        from x)
    select (select coalesce(json_agg(g), '[]') from g) as groups,
           (select to_json(bot_ids) from qn) as bots,
           (select row_to_json(qn) from qn) as quant`);
  const row = rowsOf<{
    groups: FineRow[];
    bots: string[];
    quant: Record<string, number | null> | null;
  }>(r)[0];
  // Vị thế mang sang: giá vốn và lúc mở từ lịch sử trước kỳ (review #246 B2), đưa vào đi lại như một fill ảo lúc mở.
  // Không tìm được → giá null: lần cắt trên vị thế đó "Not available".
  const carry: SQL[] = [];
  for (const id of ids) {
    const p0 = pos.get(id) ?? D0;
    if (p0.isZero()) continue;
    const basis = await costBasisAt(q, id, w.from, p0);
    carry.push(
      sql`(${id}::uuid, ${basis === null ? w.from.getTime() : basis.openedAt}::float8, ${basis?.entry.toFixed() ?? null}::numeric, ${p0.abs().toFixed()}::numeric, ${p0.isNeg() ? -1 : 1}::int)`,
    );
  }
  const cv =
    carry.length === 0
      ? sql`select null::uuid as bot_id, 0::float8 as at, null::numeric as price, 0::numeric as size, 1 as d where false`
      : sql`select * from (values ${sql.join(carry, sql`, `)}) v(bot_id, at, price, size, d)`;
  // Đi lại vị thế: truy vấn riêng, chỉ fill / lệnh (không cần giá tham chiếu), để mỗi truy vấn nhẹ. Sổ cái giá vốn bình
  // quân bằng window: đoạn = từ lúc mở (đi từ phẳng / đổi chiều); giá vào = Σ giá × khối lượng thêm vào ÷ Σ khối lượng
  // thêm vào trong đoạn (giảm vị thế không đổi giá vào; fill đổi chiều chỉ tính phần mở mới).
  const wr = await q.execute(sql`
    with k as (
      select f.id, (extract(epoch from f.filled_at) * 1000)::float8 as at, o.bot_id, o.market, f.price,
             f.size, f.fee, case when o.side = 'buy' then 1 else -1 end as d, o.created_at,
             case when o.tag like '%:cut:%' then 'cut' else 'other' end as kind
        from fills f
        join orders o on o.id = f.order_id
        join bots b on b.id = o.bot_id
        where f.filled_at >= ${w.from} and f.filled_at < ${w.to}
          and b.mode = 'live' and b.strategy = 'volume_maker'
          ${botWhere(qq) === undefined ? sql`` : sql`and ${botWhere(qq)}`}
      union all
      select null::uuid, at, bot_id, null, price, size, 0::numeric, d, null::timestamptz, 'carry' from (${cv}) c),
    w1 as (
      select k.*, sum(d * size) over (partition by bot_id order by at, id nulls first) as pos_after,
             coalesce(lead(at) over (partition by bot_id order by at, id nulls first) - at, 0) as dt
        from k),
    w2 as (
      select w1.*, pos_after - d * size as pos_before,
             (pos_after <> 0 and (pos_after - d * size = 0 or sign(pos_after - d * size) <> sign(pos_after))) as opens
        from w1),
    w3 as (
      select w2.*, sum(opens::int) over (partition by bot_id order by at, id nulls first) as seg,
             case when opens then abs(pos_after) when pos_after <> 0 and sign(d) = sign(pos_after) then size else 0 end as add_qty
        from w2),
    w4 as (
      select w3.*,
             sum(add_qty) over s as seg_qty,
             sum(add_qty * price) over s as seg_cash,
             bool_or(add_qty > 0 and price is null) over s as seg_unknown,
             min(at) over s as opened_at
        from w3
        window s as (partition by bot_id, seg order by at, id nulls first)),
    wf as (
      -- Vị thế USDC theo float (chỉ để đo thời gian / số lệnh, không phải tiền); bỏ fill ảo.
      select bot_id, dt, abs(pos_after::float8 * price::float8) as usd_pos from w4 where kind <> 'carry'),
    wa as (
      select bot_id::text as bot,
             sum(dt) filter (where usd_pos < 1) as flat_ms, sum(dt) as span_ms,
             sum(dt) filter (where usd_pos >= 1) as held_ms,
             sum(usd_pos * dt) filter (where usd_pos >= 1) as held_usd_ms
        from wf group by bot_id),
    cu as (
      select id::text as id, at, (extract(epoch from created_at) * 1000)::float8 as created_at, bot_id::text as bot,
             market, price::text as price, size::text as size, fee::text as fee, pos_before::text as pos_before,
             case when seg_unknown or pos_before = 0 or seg_qty = 0 then null else (seg_cash / seg_qty)::text end as entry,
             case when pos_before = 0 then null else opened_at end as opened_at
        from w4 where kind = 'cut' order by at desc limit ${MAX_CUTS + 1})
    select (select coalesce(json_agg(wa), '[]') from wa) as walk,
           (select coalesce(json_agg(cu), '[]') from cu) as cuts`);
  const walkRow = rowsOf<{ walk: WalkRow[]; cuts: CutRow[] }>(wr)[0];
  const groups = rollUp(row?.groups ?? [], row?.bots ?? []);
  const quant = {
    p25: H.map((h) => row?.quant?.[`p25_${h}`] ?? null),
    p75: H.map((h) => row?.quant?.[`p75_${h}`] ?? null),
  };
  const markets = [...new Set(ids.map((id) => bots.get(id)?.market ?? ""))].filter((m) => m !== "");
  const markEnd = await marksAt(q, markets, w.to);
  const markStart = await marksAt(q, markets, w.from);
  const rawCuts = walkRow?.cuts ?? [];
  const cutsComplete = rawCuts.length <= MAX_CUTS;
  const cuts = await cutViews(q, rawCuts.slice(0, MAX_CUTS), w);
  const orders = SIGNAL_RANGE_MS[qq.range] > 7 * 86_400_000 ? null : await orderCounts(q, w, ids);
  return {
    window: w,
    bots,
    active,
    groups,
    quant,
    walk: walkRow?.walk ?? [],
    cuts,
    cutsComplete,
    marks: { markEnd, markStart, posStart: pos },
    orders,
  };
}

/**
 * Kết quả mỗi lần cắt (review #246 B2): giá vào bình quân và lúc mở của vị thế bị cắt tính từ lịch sử fill (kể cả trước
 * kỳ, `costBasisOf`); không tìm được → "Not available", không lấy giá fill đầu kỳ. Binance move từ dòng "Position cut"
 * (payload.quote, DEC-312) gần lúc đặt lệnh cắt.
 */
async function cutViews(q: Exec, cuts: readonly CutRow[], w: Window): Promise<CutView[]> {
  if (cuts.length === 0) return [];
  const ids = [...new Set(cuts.map((c) => c.bot))];
  const ev = await q.execute(sql`
    select bot_id::text as bot, (extract(epoch from occurred_at) * 1000)::float8 as at, payload->'quote' as quote
      from bot_events
      where bot_id in (${inList(ids)}) and decision = 'Position cut'
        and occurred_at >= ${new Date(w.from.getTime() - 60_000)} and occurred_at < ${w.to}`);
  const events = rowsOf<{ bot: string; at: number; quote: unknown }>(ev).map((e) => {
    const s = mmQuoteSnapshotSchema.safeParse(e.quote);
    let moveBp: number | null = null;
    if (s.success && s.data.inv.entry !== null && s.data.fair.price !== null) {
      const entry = Number(s.data.inv.entry);
      const fair = Number(s.data.fair.price);
      const long = dec(s.data.inv.position).gt(0);
      moveBp = entry > 0 ? ((long ? entry - fair : fair - entry) / entry) * 10_000 : null;
    }
    return { bot: e.bot, at: e.at, moveBp };
  });
  return cuts.map((c) => {
    const before = dec(c.pos_before);
    const price = dec(c.price);
    const entry = c.entry === null ? null : dec(c.entry);
    const hit = events
      .filter(
        (e) => e.bot === c.bot && e.at >= c.created_at - 10_000 && e.at <= c.created_at + 2_000,
      )
      .sort((a, b) => Math.abs(a.at - c.created_at) - Math.abs(b.at - c.created_at))[0];
    return {
      fillId: c.id,
      at: c.at,
      botId: c.bot,
      market: c.market,
      position: before.gte(0) ? "long" : "short",
      entry,
      price,
      heldSecs:
        entry === null || c.opened_at === null ? null : Math.round((c.at - c.opened_at) / 1000),
      result:
        entry === null
          ? null
          : price
              .sub(entry)
              .mul(dec(c.size))
              .mul(before.gt(0) ? 1 : -1)
              .sub(dec(c.fee)),
      moveBp: hit?.moveBp ?? null,
    };
  });
}

/** Lệnh mở đã đặt / đã khớp theo (bot, level, smart, phía) trong kỳ (chỉ kỳ ≤ 7 ngày). Cast an toàn. */
async function orderCounts(q: Exec, w: Window, ids: readonly string[]): Promise<OrderCount[]> {
  if (ids.length === 0) return [];
  const r = await q.execute(sql`
    select bot, level, smart, side, count(*)::int as placed, (count(*) filter (where filled))::int as filled
      from (
        select o.bot_id::text as bot,
               least(case when jsonb_typeof(o.context->'level') = 'number' then (o.context->>'level')::numeric::int end, 3) as level,
               coalesce(case when jsonb_typeof(o.context->'smart') = 'boolean' then (o.context->>'smart')::boolean end, false) as smart,
               o.side, o.filled_size > 0 as filled
          from orders o
          where o.bot_id in (${inList(ids)}) and o.created_at >= ${w.from} and o.created_at < ${w.to}
            and o.context is not null and not o.reduce_only and o.type = 'limit'
            and o.status not in ('rejected', 'not_placed')) t
      where level is not null
      group by 1, 2, 3, 4`);
  return rowsOf<OrderCount>(r);
}

function dataFor(deps: SignalDeps, snap: Snapshot, q: SignalMmQuery): Promise<MmData> {
  const key = `mm|${q.tz}|${q.market ?? ""}|${q.botId ?? ""}|${String(q.level ?? "")}|${q.smart ?? ""}|${q.side ?? ""}`;
  return extraSet(snap, key, () => readOnly(deps.db, (x) => loadMm(x, snap.window, q)));
}

const ORDER: Record<MmBreakdown, readonly string[] | null> = {
  level: ["0", "1", "2", "3", "unknown"],
  smart: ["on", "off", "unknown"],
  clamp: ["hit", "normal", "off", "unknown"],
  hour: ["0", "4", "8", "12", "16", "20"],
  market: null,
  size: ["0", "200", "500", "1000"],
  side: ["buy", "sell"],
};

function rowOf(key: string, s: Stats, total: number): MmRow {
  // Nhóm theo chiều fill: không cộng vị thế mang sang.
  const c = costOf(s.sums, D0);
  return {
    key,
    n: s.sums.n,
    sharePct: total === 0 ? null : r2((s.sums.n / total) * 100),
    spread: r2(s.avg[0]),
    markout10s: r2(s.avg[1]),
    markout1m: r2(s.avg[3]),
    markout5m: r2(s.avg[5]),
    againstPct: r2(s.against[3]),
    netAfterFees: r2(s.naf),
    netPerM: str(c.net),
    thin: isThin(s.sums.n),
  };
}

function breakdownOf(d: MmData): SignalMmView["breakdown"] {
  const total = d.groups.get("all|all");
  const n = total?.sums.n ?? 0;
  const out = {} as SignalMmView["breakdown"];
  for (const by of MM_BREAKDOWNS) {
    const keys = [...d.groups.keys()]
      .filter((k) => k.startsWith(`${by}|`))
      .map((k) => k.slice(by.length + 1));
    const order = ORDER[by] ?? [...keys].sort();
    out[by] = {
      rows: order
        .filter((k) => keys.includes(k))
        .map((k) => rowOf(k, d.groups.get(`${by}|${k}`) ?? emptyStats(), n)),
      total: rowOf("all", total ?? emptyStats(), n),
    };
  }
  return out;
}

const emptyStats = (): Stats => ({
  sums: {
    n: 0,
    vol: D0,
    fees: D0,
    builder: D0,
    bNull: 0,
    end: D0,
    noMark: 0,
    pVol: D0,
    pFees: D0,
    pBuilder: D0,
    pBNull: 0,
    pEnd: D0,
    pNoMark: 0,
    mk: D0,
  },
  avg: H.map(() => null),
  cnt: H.map(() => 0),
  against: H.map(() => null),
  againstBp: null,
  naf: null,
  feeBp: null,
  ctx: 0,
  bots: [],
  sVol: D0,
  sUsd: D0,
});

const orderSizeSchema = z.object({ orderSize: decimalStringSchema });

/** Thời gian phẳng / vị thế trung bình (số lệnh) từ phần đi lại trong SQL; bot thiếu order size → vị thế "Not available". */
export function inventoryOf(walk: readonly WalkRow[], bots: Map<string, BotInfo>) {
  let flat = 0;
  let span = 0;
  let held = 0;
  let heldOrders = 0;
  let sized = true;
  for (const w of walk) {
    flat += w.flat_ms ?? 0;
    span += w.span_ms ?? 0;
    const cfg = orderSizeSchema.safeParse(bots.get(w.bot)?.config);
    const size = cfg.success ? Number(cfg.data.orderSize) : NaN;
    if ((w.held_ms ?? 0) > 0) {
      if (!(size > 0)) sized = false;
      held += w.held_ms ?? 0;
      heldOrders += (w.held_usd_ms ?? 0) / size;
    }
  }
  return {
    timeFlatPct: span > 0 ? (flat / span) * 100 : null,
    avgPositionOrders: sized && held > 0 ? heldOrders / held : null,
  };
}

/** Gợi ý của tab MM (chỉ khi nhóm ≥ 30, cần duyệt; câu thiếu số thì bỏ gợi ý hoặc dùng bản không có vế đó). */
export function mmSuggestions(
  groups: Map<string, Stats>,
  levels: SignalMmView["levels"],
  hours: SignalMmView["breakdown"]["hour"],
  cuts: number,
  overallNet: string | null,
): { suggestions: SignalSuggestion[]; hidden: SignalHiddenLead[] } {
  const suggestions: SignalSuggestion[] = [];
  const hidden: SignalHiddenLead[] = [];
  const ok = (n: number) => n >= SIGNAL_MIN_GROUP;
  // 1. Quote level có net sau phí tốt nhất so với "At best price".
  const base = levels.find((l) => l.level === 0);
  const best = levels
    .filter((l) => ok(l.n) && l.netAfterFees !== null)
    .reduce<(typeof levels)[number] | null>(
      (a, b) => (a === null || (b.netAfterFees ?? 0) > (a.netAfterFees ?? 0) ? b : a),
      null,
    );
  if (
    base !== undefined &&
    ok(base.n) &&
    best !== null &&
    best.level !== 0 &&
    base.netAfterFees !== null &&
    best.netAfterFees !== null &&
    best.netAfterFees > base.netAfterFees
  ) {
    const baseAgainst = r2(groups.get("level|0")?.against[3] ?? null);
    const bestAgainst = r2(groups.get(`level|${String(best.level)}`)?.against[3] ?? null);
    const rates = best.fillRatePct !== null && base.fillRatePct !== null;
    const against = baseAgainst !== null && bestAgainst !== null;
    suggestions.push({
      key: `level${against ? "" : "NoAgainst"}${rates ? "" : "NoRate"}`,
      n: base.n + best.n,
      values: {
        level: best.level,
        baseNet: base.netAfterFees,
        bestNet: best.netAfterFees,
        ...(against ? { baseAgainst, bestAgainst } : {}),
        ...(rates ? { bestRate: best.fillRatePct ?? 0, baseRate: base.fillRatePct ?? 0 } : {}),
      },
    });
  } else if (levels.some((l) => l.n > 0 && !ok(l.n))) {
    hidden.push({ key: "level", n: Math.min(...levels.filter((l) => l.n > 0).map((l) => l.n)) });
  }
  // 2. Smart quoting bật vs tắt.
  const on = groups.get("smart|on");
  const off = groups.get("smart|off");
  if (on !== undefined && off !== undefined && ok(on.sums.n) && ok(off.sums.n)) {
    const a = on.avg[3] ?? null;
    const b = off.avg[3] ?? null;
    if (a !== null && b !== null && a > b) {
      const invOn = costOf(on.sums, D0).inventory;
      const invOff = costOf(off.sums, D0).inventory;
      const vol = on.sums.vol.add(off.sums.vol);
      const inv = invOn !== null && invOff !== null;
      suggestions.push({
        key: inv ? "smart" : "smartNoInventory",
        n: on.sums.n + off.sums.n,
        values: {
          on: r2(a) ?? 0,
          off: r2(b) ?? 0,
          ...(inv ? { invOn: str(invOn, 0) ?? "", invOff: str(invOff, 0) ?? "" } : {}),
          offShare: vol.isZero() ? 0 : (r2(off.sums.vol.div(vol).mul(100).toNumber()) ?? 0),
        },
      });
    }
  } else if (on !== undefined && off !== undefined) {
    hidden.push({ key: "smart", n: Math.min(on.sums.n, off.sums.n) });
  }
  // 3. Khối 4 giờ tốn nhất (≥ 1,25 × trung bình).
  const overall = overallNet === null ? null : Number(overallNet);
  const worst = hours.rows
    .filter((r) => ok(r.n) && r.netPerM !== null)
    .reduce<MmRow | null>(
      (a, b) => (a === null || Number(b.netPerM) > Number(a.netPerM) ? b : a),
      null,
    );
  if (worst !== null && overall !== null && overall > 0 && Number(worst.netPerM) > overall * 1.25) {
    suggestions.push({
      key: worst.againstPct === null ? "hoursNoAgainst" : "hours",
      n: worst.n,
      values: {
        from: Number(worst.key),
        net: str(dec(worst.netPerM ?? "0"), 0) ?? "",
        overall: str(dec(overallNet ?? "0"), 0) ?? "",
        ...(worst.againstPct === null ? {} : { against: worst.againstPct }),
      },
    });
  } else if (worst === null && hours.rows.some((r) => r.n > 0)) {
    hidden.push({ key: "hours", n: Math.max(0, ...hours.rows.map((r) => r.n)) });
  }
  if (cuts > 0 && !ok(cuts)) hidden.push({ key: "cuts", n: cuts });
  return { suggestions, hidden };
}

export async function signalMm(
  deps: SignalDeps,
  userId: string,
  query: unknown,
): Promise<SignalMmView> {
  await team(deps, userId);
  const q = parseOrThrow(signalMmQuerySchema, query);
  const snap = snapshotOf(deps, q.range, deps.now());
  const [d, prev] = await Promise.all([dataFor(deps, snap, q), previousSet(deps, snap)]);
  const total = d.groups.get("all|all") ?? emptyStats();
  const marketOf = (id: string) => d.bots.get(id)?.market;
  // Vị thế mang sang chỉ cộng khi bộ lọc theo bot (không theo level / Smart quoting / phía).
  const carried = fillLevel(q) ? D0 : carriedOf(d.marks, total.bots, marketOf);
  const res = costOf(total.sums, carried);
  // Spread trên các fill có cả giá 1 phút và mid lúc fill; dưới 80% volume có giá 1 phút → Not available.
  const spreadCost =
    total.sums.pVol.gt(0) && total.sVol.div(total.sums.pVol).gte(0.8)
      ? perM(total.sUsd.neg(), total.sVol)
      : null;
  const cutsUsd =
    !d.cutsComplete || d.cuts.some((c) => c.result === null)
      ? null
      : d.cuts.reduce((s, c) => s.add(c.result ?? D0), D0);
  const levelRates = (level: number) => {
    if (d.orders === null) return null;
    const rows = d.orders.filter(
      (o) =>
        o.level === level &&
        (q.smart === undefined || o.smart === (q.smart === "on")) &&
        (q.side === undefined || o.side === q.side),
    );
    const placed = rows.reduce((s, o) => s + o.placed, 0);
    return placed === 0 ? null : (rows.reduce((s, o) => s + o.filled, 0) / placed) * 100;
  };
  const levels = [0, 1, 2, 3].map((level) => {
    const g = d.groups.get(`level|${String(level)}`) ?? emptyStats();
    return {
      level,
      n: g.sums.n,
      spread: r2(g.avg[0]),
      priceAgainst: r2(g.againstBp),
      netAfterFees: r2(g.naf),
      fillRatePct: r2(levelRates(level)),
      thin: isThin(g.sums.n),
    };
  });
  const breakdown = breakdownOf(d);
  const netStr = str(res.net);
  const { suggestions, hidden } = mmSuggestions(
    d.groups,
    levels,
    breakdown.hour,
    d.cuts.length,
    netStr,
  );
  const prevNet = fillLevel(q)
    ? null
    : previousNet(
        prev,
        [...prev.legs.keys()].filter((id) => {
          const b = d.bots.get(id);
          return b !== undefined && botLevel(q, b);
        }),
      );
  const inv = inventoryOf(d.walk, d.bots);
  const facet = [...d.active].filter((id) => d.bots.has(id));
  const w = d.window;
  return {
    computedAt: new Date(snap.at).toISOString(),
    range: q.range,
    tz: q.tz,
    from: w.from.toISOString(),
    to: w.to.toISOString(),
    bots: total.bots.length,
    accounts: new Set(total.bots.map((id) => d.bots.get(id)?.userId)).size,
    markets: [...new Set(facet.map((id) => d.bots.get(id)?.market ?? ""))].sort(),
    botList: botFacets(facet, d.bots),
    summary: {
      fills: total.sums.n,
      volume: str(total.sums.vol) ?? "0",
      spread: r2(total.avg[0]),
      markout1m: r2(total.avg[3]),
      feesBp: r2(total.feeBp),
      againstPct: r2(total.against[3]),
      cuts: d.cuts.length,
      cutsUsd: str(cutsUsd, 4),
      netPerM: netStr,
      netUsd: str(res.netUsd),
      prevNetPerM: str(prevNet),
      vsPrev: deltaOf(res.net, prevNet),
      withContext: total.ctx,
    },
    waterfall: {
      spread: str(spreadCost),
      priceAgainst: str(
        spreadCost === null || res.markout === null ? null : res.markout.sub(spreadCost),
      ),
      fees: str(res.fees),
      sodexFees: str(res.sodexFees),
      builderFees: str(res.builderFees),
      inventory: str(res.inventory),
      net: netStr,
    },
    suggestions,
    hidden,
    curve: {
      all: SIGNAL_MM_HORIZONS.map((_, i) => ({
        n: total.cnt[i] ?? 0,
        mean: r2(total.avg[i] ?? null),
        p25: r2(d.quant.p25[i] ?? null),
        p75: r2(d.quant.p75[i] ?? null),
        againstPct: i === 0 ? null : r2(total.against[i] ?? null),
      })),
      on: SIGNAL_MM_HORIZONS.map((_, i) => r2(d.groups.get("smart|on")?.avg[i] ?? null)),
      off: SIGNAL_MM_HORIZONS.map((_, i) => r2(d.groups.get("smart|off")?.avg[i] ?? null)),
      feesBp: r2(total.feeBp),
    },
    levels,
    inventory: {
      timeFlatPct: r2(inv.timeFlatPct),
      avgPositionOrders: r2(inv.avgPositionOrders),
      inventoryPerM: str(res.inventory),
      cuts: d.cuts.length,
      cutsUsd: str(cutsUsd, 4),
      avgCutMoveBp: r2(avg(d.cuts.map((c) => c.moveBp))),
      latestCuts: d.cuts.slice(0, 5).map((c) => ({
        fillId: c.fillId,
        at: new Date(c.at).toISOString(),
        market: c.market,
        botName: d.bots.get(c.botId)?.name ?? "",
        position: c.position,
        moveBp: r2(c.moveBp),
        entry: str(c.entry, 8),
        price: str(c.price, 8) ?? "0",
        heldSecs: c.heldSecs,
        resultUsd: str(c.result, 4),
      })),
    },
    breakdown,
  };
}

function avg(xs: readonly (number | null)[]): number | null {
  const v = xs.filter((x): x is number => x !== null);
  return v.length === 0 ? null : v.reduce((a, b) => a + b, 0) / v.length;
}

interface FillListRow {
  id: string;
  at: number;
  bot: string;
  market: string;
  side: "buy" | "sell";
  lvl: number | null;
  smart: boolean | null;
  clamp: "hit" | "normal" | null;
  kind: MmFill["kind"];
  usd: string;
  b0: number | null;
  b10: number | null;
  b60: number | null;
  b300: number | null;
  naf: number | null;
}

const fillOf = (r: FillListRow, bots: Map<string, BotInfo>): MmFill => ({
  id: r.id,
  filledAt: new Date(r.at).toISOString(),
  market: r.market,
  botId: r.bot,
  botName: bots.get(r.bot)?.name ?? "",
  side: r.side,
  level: r.lvl,
  smart: r.smart,
  clamp: r.clamp,
  kind: r.kind,
  usd: str(dec(r.usd)) ?? "0",
  spread: r2(r.b0),
  markout10s: r2(r.b10),
  markout1m: r2(r.b60),
  markout5m: r2(r.b300),
  netAfterFees: r2(r.naf),
});

const FILL_COLS = sql`x.id::text as id, x.at, x.bot_id::text as bot, x.market, x.side, x.lvl, x.smart, x.clamp,
  x.kind, x.usd::text as usd, x.b0, x.b10, x.b60, x.b300, (x.b60 - x.fee_bp) as naf`;

export async function signalMmFills(
  deps: SignalDeps,
  userId: string,
  query: unknown,
): Promise<SignalMmFillsPage> {
  await team(deps, userId);
  const q = parseOrThrow(signalMmFillsQuerySchema, query);
  const snap = snapshotOf(deps, q.range, deps.now());
  const bots = new Map(
    (await readOnly(deps.db, (x) => liveBots(x, ["volume_maker"]))).map((b) => [b.id, b]),
  );
  const rows = await readOnly(deps.db, async (x) => {
    if (q.sort === "worst") {
      // "Worst 1 min" cần markout của mọi fill: tính trên cả nền.
      return rowsOf<FillListRow & { total: number }>(
        await x.execute(sql`
          with ${derived(q, snap.window)}
          select ${FILL_COLS}, count(*) over ()::int as total
            from x
            order by (x.b60 - x.fee_bp) asc nulls last, x.at desc, x.id
            limit ${SIGNAL_PAGE_SIZE} offset ${q.offset}`),
      );
    }
    // Mới nhất / Position cuts: chọn trang trên fill + lệnh trước (index fills_filled_at_idx), rồi chỉ tính giá tham
    // chiếu cho 50 fill của trang.
    const p: SQL[] = [];
    const bw = botWhere(q);
    if (bw !== undefined) p.push(bw);
    if (q.side !== undefined) p.push(sql`o.side = ${q.side}`);
    if (q.level !== undefined)
      p.push(
        sql`least(case when jsonb_typeof(o.context->'level') = 'number' then (o.context->>'level')::numeric::int end, 3) = ${q.level}`,
      );
    if (q.smart !== undefined)
      p.push(
        sql`case when jsonb_typeof(o.context->'smart') = 'boolean' then (o.context->>'smart')::boolean end = ${q.smart === "on"}`,
      );
    if (q.sort === "cuts") p.push(sql`o.tag like '%:cut:%'`);
    const w = snap.window;
    return rowsOf<FillListRow & { total: number }>(
      await x.execute(sql`
        with pg as (
          select f.id, ${q.sort === "cuts" ? sql`count(*) over ()::int` : sql`null::int`} as total
            from fills f
            join orders o on o.id = f.order_id
            join bots b on b.id = o.bot_id
            where f.filled_at >= ${w.from} and f.filled_at < ${w.to}
              and b.mode = 'live' and b.strategy = 'volume_maker'
              and o.created_at >= ${new Date(w.from.getTime() - 86_400_000)}
              ${p.length === 0 ? sql`` : sql`and ${sql.join(p, sql` and `)}`}
            order by f.filled_at desc, f.id
            limit ${SIGNAL_PAGE_SIZE} offset ${q.offset}),
        ${derived(q, w, undefined, sql`select id from pg`)}
        select ${FILL_COLS}, (select max(total) from pg) as total
          from x
          order by x.at desc, x.id`),
    );
  });
  // Mới nhất: tổng lấy từ số fill của trang (ảnh chụp đã có), không đếm lại cả kỳ.
  const total =
    q.sort === "newest"
      ? ((await dataFor(deps, snap, q)).groups.get("all|all")?.sums.n ?? 0)
      : (rows[0]?.total ?? 0);
  const next = q.offset + SIGNAL_PAGE_SIZE;
  return {
    total,
    items: rows.map((r) => fillOf(r, bots)),
    nextOffset: next < total ? next : null,
  };
}

const idSchema = z.uuid();

/** Bộ lọc chỉ theo bot (bỏ level / Smart quoting / phía). */
const botOnly = (q: SignalMmQuery): SignalMmQuery => ({
  range: q.range,
  tz: q.tz,
  ...(q.market === undefined ? {} : { market: q.market }),
  ...(q.botId === undefined ? {} : { botId: q.botId }),
});

/** Spread của sổ lúc đặt lệnh (bp theo mid); thiếu bid / ask / mid → null. */
function spreadOf(ctx: MmOrderContext | null): number | null {
  if (ctx === null) return null;
  const { bid, ask, mid } = ctx;
  if (bid === null || ask === null || mid === null) return null;
  return r2(((Number(ask) - Number(bid)) / Number(mid)) * 10_000);
}

export async function signalMmFill(
  deps: SignalDeps,
  userId: string,
  id: string,
  query: unknown,
): Promise<MmFillDetail> {
  await team(deps, userId);
  const q = parseOrThrow(signalMmQuerySchema, query);
  if (!idSchema.safeParse(id).success) throw new AppError(ErrorCode.notFound, "Fill not found.");
  const snap = snapshotOf(deps, q.range, deps.now());
  const one = await readOnly(deps.db, async (x) => {
    const r = await x.execute(sql`
      with ${derived(botOnly(q), snap.window, sql`f.id = ${id}::uuid`)}
      select ${FILL_COLS}, x.b30, x.b120, x.price::text as price, x.size::text as size, x.fee::text as fee,
             x.builder_fee::text as builder, x.mid0::text as mid0, x.r60::text as r60, x.reduce_only as "reduceOnly",
             (extract(epoch from x.created_at) * 1000)::float8 as "createdAt", o.context, o.id::text as "orderId"
        from base x join fills f on f.id = x.id join orders o on o.id = f.order_id`);
    return rowsOf<
      FillListRow & {
        b30: number | null;
        b120: number | null;
        price: string;
        size: string;
        fee: string;
        builder: string | null;
        mid0: string | null;
        r60: string | null;
        reduceOnly: boolean;
        createdAt: number;
        context: unknown;
        orderId: string;
      }
    >(r)[0];
  });
  if (one === undefined) throw new AppError(ErrorCode.notFound, "Fill not found.");
  const bots = new Map(
    (await readOnly(deps.db, (x) => liveBots(x, ["volume_maker"]))).map((b) => [b.id, b]),
  );
  const bot = bots.get(one.bot);
  const d = await dataFor(deps, snap, q);
  const all = d.groups.get("all|all") ?? emptyStats();
  const at = one.at;
  const extra = await readOnly(deps.db, async (t) => {
    const mids = await t.execute(sql`
      select ts, mid::text as p from mid_1s
        where market = ${one.market} and ts >= ${new Date(at - 60_000)} and ts <= ${new Date(at + 300_000)}
        order by ts limit 400`);
    const midRows = rowsOf<{ ts: string | Date; p: string }>(mids);
    const candles =
      midRows.length > 0
        ? []
        : rowsOf<{ ts: string | Date; p: string }>(
            await t.execute(sql`
              select ts, close::text as p from candles_1m
                where market = ${one.market} and ts >= ${new Date(at - 5 * 60_000)} and ts <= ${new Date(at + 10 * 60_000)}
                order by ts limit 20`),
          );
    const timeline = await timelineOf(t, one.bot, one.createdAt - 1_000, at + 300_000, "vm:%", {
      orderId: one.orderId,
      filledOnly: true,
    });
    return { midRows, candles, timeline };
  });
  const parsed = mmOrderContextSchema.safeParse(one.context);
  const ctx = parsed.success ? parsed.data : null;
  const dir = one.side === "buy" ? 1 : -1;
  const size = dec(one.size);
  const price = dec(one.price);
  const fee = dec(one.fee);
  const builder = one.builder === null ? null : dec(one.builder);
  const spreadUsd = one.mid0 === null ? null : dec(one.mid0).sub(price).mul(size).mul(dir);
  const markoutUsd = one.r60 === null ? null : dec(one.r60).sub(price).mul(size).mul(dir);
  const cfg = orderSizeSchema.safeParse(bot?.config);
  const pts = (extra.midRows.length > 0 ? extra.midRows : extra.candles).map((r) => ({
    t: new Date(r.ts).toISOString(),
    p: r.p,
  }));
  const limit = one.side === "buy" ? -VM_ORACLE.marginBp : VM_ORACLE.marginBp;
  return {
    fill: fillOf(one, bots),
    price: one.price,
    size: one.size,
    mid: one.mid0,
    prices: pts,
    priceSource: extra.midRows.length > 0 ? "mid" : extra.candles.length > 0 ? "candles" : null,
    quote: {
      level: ctx?.level ?? null,
      smart: ctx?.smart ?? null,
      clamp: one.clamp,
      insideLimitBp:
        ctx === null || !ctx.smart || ctx.fairBp === null || one.reduceOnly
          ? null
          : r2(one.side === "buy" ? limit - ctx.fairBp : ctx.fairBp - limit),
      spreadBp: spreadOf(ctx),
      bookSecs: r2((one.at - one.createdAt) / 1000),
      positionBefore: ctx?.pos ?? null,
      positionOrders:
        ctx === null || !cfg.success || !(Number(cfg.data.orderSize) > 0)
          ? null
          : r2((Math.abs(Number(ctx.pos)) * Number(one.price)) / Number(cfg.data.orderSize)),
    },
    markouts: [one.b0, one.b10, one.b30, one.b60, one.b120, one.b300].map(r2),
    markoutsAll: SIGNAL_MM_HORIZONS.map((_, i) => r2(all.avg[i] ?? null)),
    split: {
      spread: str(spreadUsd, 4),
      priceAgainst: str(
        spreadUsd === null || markoutUsd === null ? null : markoutUsd.sub(spreadUsd),
        4,
      ),
      sodexFee: builder === null ? null : (str(fee.sub(builder).neg(), 4) ?? "0"),
      builderFee: builder === null ? null : (str(builder.neg(), 4) ?? "0"),
      net: str(markoutUsd === null ? null : markoutUsd.sub(fee), 4),
    },
    timeline: extra.timeline,
  };
}

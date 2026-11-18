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
  type SignalMmQuantiles,
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
  costBasesAt,
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
  ledgerStep,
  type BotInfo,
  type Exec,
  type Ledger,
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
import { extraSet, previousSet, singleFlight, snapshotOf, type Snapshot } from "./sets";
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
  /** Bot (market suy ra từ bot, nên lọc market / bot làm trong Node). */
  bot: string;
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

/** Đi lại vị thế của một bot trong kỳ (ms; vị thế USDC × ms). */
export interface WalkAgg {
  flatMs: number;
  spanMs: number;
  heldMs: number;
  heldUsdMs: number;
}

interface MmBase {
  window: Window;
  bots: Map<string, BotInfo>;
  active: Set<string>;
  fine: FineRow[];
  walk: Map<string, WalkAgg>;
  /** Mọi lần cắt trong kỳ (mọi bot), mới nhất trước. */
  cuts: CutView[];
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
  createdAt: number;
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
export function rollUp(
  rows: readonly FineRow[],
  botMarket: (id: string) => string | undefined,
): Map<string, Stats> {
  const acc = new Map<string, Fine>();
  const bots = [...new Set(rows.map((r) => r.bot))];
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
    add(`market|${botMarket(r.bot) ?? "unknown"}`, f);
    add(`size|${r.band}`, f);
    add(`side|${r.side}`, f);
  }
  return new Map([...acc].map(([k, f]) => [k, statsOfFine(f, k === "all|all" ? bots : [])]));
}

interface WalkFill {
  bot: string;
  id: string;
  at: number;
  createdAt: number;
  side: "buy" | "sell";
  size: string;
  price: string;
  fee: string;
  cut: boolean;
}

/**
 * Đi lại vị thế từng bot bằng MỘT sổ cái (`ledgerStep`, dùng chung với vị thế mang sang): thời gian phẳng / vị thế trung
 * bình (từ fill đầu tới fill cuối của bot trong kỳ) và kết quả mỗi lần cắt = (giá cắt − giá vào bình quân) × size × chiều
 * − phí của fill cắt; giá vào chưa biết (vị thế mang sang không tìm được giá vốn) → "Not available".
 * `fills` đã xếp theo (bot, thời gian).
 */
export function walkLedger(
  fills: readonly WalkFill[],
  start: ReadonlyMap<string, Ledger>,
): { walk: Map<string, WalkAgg>; cuts: Omit<CutView, "moveBp" | "market">[] } {
  const walk = new Map<string, WalkAgg>();
  const cuts: Omit<CutView, "moveBp" | "market">[] = [];
  let bot = "";
  let l: Ledger = { pos: D0, entry: null, openedAt: null };
  let lastAt = 0;
  let lastUsd = 0;
  let agg: WalkAgg = { flatMs: 0, spanMs: 0, heldMs: 0, heldUsdMs: 0 };
  for (const f of fills) {
    if (f.bot !== bot) {
      bot = f.bot;
      l = start.get(bot) ?? { pos: D0, entry: null, openedAt: null };
      agg = { flatMs: 0, spanMs: 0, heldMs: 0, heldUsdMs: 0 };
      walk.set(bot, agg);
      lastAt = f.at;
      lastUsd = 0;
    } else {
      // Khoảng [fill trước, fill này] với vị thế sau fill trước (USDC theo float: chỉ để đo thời gian / số lệnh).
      const dt = f.at - lastAt;
      agg.spanMs += dt;
      if (lastUsd < 1) agg.flatMs += dt;
      else {
        agg.heldMs += dt;
        agg.heldUsdMs += lastUsd * dt;
      }
    }
    const price = dec(f.price);
    const size = dec(f.size);
    if (f.cut && !l.pos.isZero()) {
      const long = l.pos.gt(0);
      cuts.push({
        fillId: f.id,
        at: f.at,
        createdAt: f.createdAt,
        botId: bot,
        position: long ? "long" : "short",
        entry: l.entry,
        price,
        heldSecs:
          l.entry === null || l.openedAt === null ? null : Math.round((f.at - l.openedAt) / 1000),
        result:
          l.entry === null
            ? null
            : price
                .sub(l.entry)
                .mul(size)
                .mul(long ? 1 : -1)
                .sub(dec(f.fee)),
      });
    }
    l = ledgerStep(l, f.side, size, price, f.at);
    lastAt = f.at;
    lastUsd = Math.abs(l.pos.toNumber() * price.toNumber());
  }
  return { walk, cuts: cuts.sort((a, b) => b.at - a.at) };
}

type MmRange = Omit<MmBase, "fine">;

/**
 * Phần không phụ thuộc múi giờ của một kỳ (review #246 lần 3: dùng chung cho mọi múi giờ): bot, vị thế đầu kỳ và giá vốn,
 * đi lại vị thế (fill hẹp, sổ cái trong Node), lần cắt, số lệnh, giá đầu / cuối kỳ.
 */
async function loadMmRange(q: Exec, w: Window, range: SignalMmQuery["range"]): Promise<MmRange> {
  const botsAll = await liveBots(q, ["volume_maker"]);
  const bots = new Map(botsAll.map((b) => [b.id, b]));
  const active = await activeBots(q, w, ["volume_maker"]);
  const ids = [...active].filter((id) => bots.has(id));
  const [posStart] = await positionsAt(q, ids, [w.from]);
  const pos = posStart ?? new Map<string, Decimal>();
  const bases = await costBasesAt(q, pos, w.from);
  // Fill hẹp, theo (bot, thời gian), cho sổ cái trong Node (không giữ lại sau khi tính).
  const wr = await q.execute(sql`
    select o.bot_id::text as bot, f.id::text as id, (extract(epoch from f.filled_at) * 1000)::float8 as at,
           (extract(epoch from o.created_at) * 1000)::float8 as "createdAt", o.side, f.size::text as size,
           f.price::text as price, f.fee::text as fee, o.tag like '%:cut:%' as cut
      from fills f
      join orders o on o.id = f.order_id
      join bots b on b.id = o.bot_id
      where f.filled_at >= ${w.from} and f.filled_at < ${w.to}
        and b.mode = 'live' and b.strategy = 'volume_maker'
        and o.created_at >= ${new Date(w.from.getTime() - 86_400_000)} and o.filled_size > 0
      order by o.bot_id, f.filled_at, f.id`);
  const start = new Map<string, Ledger>(
    ids.map((id) => {
      const p0 = pos.get(id) ?? D0;
      const b = bases.get(id);
      return [id, { pos: p0, entry: b?.entry ?? null, openedAt: b?.openedAt ?? null }];
    }),
  );
  const { walk, cuts } = walkLedger(rowsOf<WalkFill>(wr), start);
  const markets = [...new Set(ids.map((id) => bots.get(id)?.market ?? ""))].filter((m) => m !== "");
  const markEnd = await marksAt(q, markets, w.to);
  const markStart = await marksAt(q, markets, w.from);
  const views = await cutViews(q, cuts, bots, w);
  const orders = SIGNAL_RANGE_MS[range] > 7 * 86_400_000 ? null : await orderCounts(q, w, ids);
  return {
    window: w,
    bots,
    active,
    walk,
    cuts: views,
    marks: { markEnd, markStart, posStart: pos },
    orders,
  };
}

/** Nhóm nhỏ nhất theo mọi chiều + bot của một (kỳ, múi giờ): chỉ phần này cần múi giờ (khối 4 giờ). */
async function loadMmFine(q: Exec, w: Window, tz: string, range: SignalMmQuery["range"]) {
  const hz = (fn: (h: string) => string) => sql.raw(H.map(fn).join(", "));
  const r = await q.execute(sql`
    with ${derived({ range, tz }, w)}
    select coalesce(lvl::text, 'unknown') as lvl_k,
           case when smart is null then 'unknown' when smart then 'on' else 'off' end as smart_k,
           case when not has_ctx then 'unknown' when smart is false then 'off' else coalesce(clamp, 'normal') end as clamp_k,
           block, bot_id::text as bot, band, side, ${SUMS_SQL},
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
      group by 1, 2, 3, 4, 5, 6, 7`);
  return rowsOf<FineRow>(r);
}

/** Binance move lúc cắt từ dòng "Position cut" (payload.quote, DEC-312) gần lúc đặt lệnh cắt. */
async function cutViews(
  q: Exec,
  cuts: readonly Omit<CutView, "moveBp" | "market">[],
  bots: Map<string, BotInfo>,
  w: Window,
): Promise<CutView[]> {
  if (cuts.length === 0) return [];
  const ids = [...new Set(cuts.map((c) => c.botId))];
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
    const hit = events
      .filter(
        (e) => e.bot === c.botId && e.at >= c.createdAt - 10_000 && e.at <= c.createdAt + 2_000,
      )
      .sort((a, b) => Math.abs(a.at - c.createdAt) - Math.abs(b.at - c.createdAt))[0];
    return { ...c, market: bots.get(c.botId)?.market ?? "", moveBp: hit?.moveBp ?? null };
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

/** Dữ liệu MM một (kỳ, múi giờ), gắn vào ảnh chụp của kỳ (LRU). */
/**
 * Dữ liệu MM của một (kỳ, múi giờ), không theo bộ lọc (bộ lọc áp trong Node bằng `rollUp`): phần theo kỳ dùng chung mọi
 * múi giờ, phần nhóm theo (kỳ, múi giờ). Mỗi lần tải nặng chạy một mình trong process (`singleFlight`).
 */
async function dataFor(deps: SignalDeps, snap: Snapshot, tz: string): Promise<MmBase> {
  const range = extraSet(snap, "mm-range", () =>
    singleFlight(() => readOnly(deps, (x) => loadMmRange(x, snap.window, snap.range))),
  );
  const fine = extraSet(snap, `mm-fine|${tz}`, () =>
    singleFlight(() => readOnly(deps, (x) => loadMmFine(x, snap.window, tz, snap.range))),
  );
  return { ...(await range), fine: await fine };
}

/** Áp bộ lọc trong Node: nhóm theo bot / level / Smart quoting / phía. */
function viewOf(d: MmBase, q: SignalMmQuery): Map<string, Stats> {
  const rows = d.fine.filter((r) => {
    const b = d.bots.get(r.bot);
    return (
      b !== undefined &&
      botLevel(q, b) &&
      (q.level === undefined || r.lvl_k === String(q.level)) &&
      (q.smart === undefined || r.smart_k === q.smart) &&
      (q.side === undefined || r.side === q.side)
    );
  });
  return rollUp(rows, (id) => d.bots.get(id)?.market);
}

/**
 * Phân vị p25 / p75 của "Price after the fill" cho đúng bộ lọc (SQL, cache theo bộ lọc trong ảnh chụp): endpoint riêng,
 * web tải sau, nên đổi bộ lọc không chờ truy vấn này.
 */
export async function signalMmQuantiles(
  deps: SignalDeps,
  userId: string,
  query: unknown,
): Promise<SignalMmQuantiles> {
  await team(deps, userId);
  const q = parseOrThrow(signalMmQuerySchema, query);
  const snap = snapshotOf(deps, q.range, deps.now());
  const key = `mmq|${q.market ?? ""}|${q.botId ?? ""}|${String(q.level ?? "")}|${q.smart ?? ""}|${q.side ?? ""}`;
  return extraSet(snap, key, () =>
    readOnly(deps, async (x) => {
      const hz = (fn: (h: string) => string) => sql.raw(H.map(fn).join(", "));
      const r = await x.execute(sql`
        with ${derived({ ...q, tz: "UTC" }, snap.window)}
        select ${hz((h) => `percentile_cont(0.25) within group (order by b${h}) as p25_${h}, percentile_cont(0.75) within group (order by b${h}) as p75_${h}`)}
          from x`);
      const row = rowsOf<Record<string, number | null>>(r)[0];
      return {
        p25: H.map((h) => r2(row?.[`p25_${h}`] ?? null)),
        p75: H.map((h) => r2(row?.[`p75_${h}`] ?? null)),
      };
    }),
  );
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

function breakdownOf(groups: Map<string, Stats>): SignalMmView["breakdown"] {
  const total = groups.get("all|all");
  const n = total?.sums.n ?? 0;
  const out = {} as SignalMmView["breakdown"];
  for (const by of MM_BREAKDOWNS) {
    const keys = [...groups.keys()]
      .filter((k) => k.startsWith(`${by}|`))
      .map((k) => k.slice(by.length + 1));
    const order = ORDER[by] ?? [...keys].sort();
    out[by] = {
      rows: order
        .filter((k) => keys.includes(k))
        .map((k) => rowOf(k, groups.get(`${by}|${k}`) ?? emptyStats(), n)),
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

/** Thời gian phẳng / vị thế trung bình (số lệnh) từ phần đi lại; bot thiếu order size → vị thế "Not available". */
export function inventoryOf(walk: ReadonlyMap<string, WalkAgg>, bots: Map<string, BotInfo>) {
  let flat = 0;
  let span = 0;
  let held = 0;
  let heldOrders = 0;
  let sized = true;
  for (const [bot, w] of walk) {
    flat += w.flatMs;
    span += w.spanMs;
    const cfg = orderSizeSchema.safeParse(bots.get(bot)?.config);
    const size = cfg.success ? Number(cfg.data.orderSize) : NaN;
    if (w.heldMs > 0) {
      if (!(size > 0)) sized = false;
      held += w.heldMs;
      heldOrders += w.heldUsdMs / size;
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
  const [d, prev] = await Promise.all([dataFor(deps, snap, q.tz), previousSet(deps, snap)]);
  const groups = viewOf(d, q);
  const total = groups.get("all|all") ?? emptyStats();
  const okBot = (id: string) => {
    const b = d.bots.get(id);
    return b !== undefined && botLevel(q, b);
  };
  const cuts = d.cuts.filter((c) => okBot(c.botId));
  const walk = new Map([...d.walk].filter(([id]) => okBot(id)));
  const marketOf = (id: string) => d.bots.get(id)?.market;
  // Vị thế mang sang chỉ cộng khi bộ lọc theo bot (không theo level / Smart quoting / phía).
  const carried = fillLevel(q) ? D0 : carriedOf(d.marks, total.bots, marketOf);
  const res = costOf(total.sums, carried);
  // Spread trên các fill có cả giá 1 phút và mid lúc fill; dưới 80% volume có giá 1 phút → Not available.
  const spreadCost =
    total.sums.pVol.gt(0) && total.sVol.div(total.sums.pVol).gte(0.8)
      ? perM(total.sUsd.neg(), total.sVol)
      : null;
  const cutsUsd = cuts.some((c) => c.result === null)
    ? null
    : cuts.reduce((s, c) => s.add(c.result ?? D0), D0);
  const levelRates = (level: number) => {
    if (d.orders === null) return null;
    const rows = d.orders.filter(
      (o) =>
        o.level === level &&
        okBot(o.bot) &&
        (q.smart === undefined || o.smart === (q.smart === "on")) &&
        (q.side === undefined || o.side === q.side),
    );
    const placed = rows.reduce((s, o) => s + o.placed, 0);
    return placed === 0 ? null : (rows.reduce((s, o) => s + o.filled, 0) / placed) * 100;
  };
  const levels = [0, 1, 2, 3].map((level) => {
    const g = groups.get(`level|${String(level)}`) ?? emptyStats();
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
  const breakdown = breakdownOf(groups);
  const netStr = str(res.net);
  const { suggestions, hidden } = mmSuggestions(
    groups,
    levels,
    breakdown.hour,
    cuts.length,
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
  const inv = inventoryOf(walk, d.bots);
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
      cuts: cuts.length,
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
        // Phân vị theo bộ lọc: endpoint riêng (`/mm/quantiles`), web tải sau.
        p25: null,
        p75: null,
        againstPct: i === 0 ? null : r2(total.against[i] ?? null),
      })),
      on: SIGNAL_MM_HORIZONS.map((_, i) => r2(groups.get("smart|on")?.avg[i] ?? null)),
      off: SIGNAL_MM_HORIZONS.map((_, i) => r2(groups.get("smart|off")?.avg[i] ?? null)),
      feesBp: r2(total.feeBp),
    },
    levels,
    inventory: {
      timeFlatPct: r2(inv.timeFlatPct),
      avgPositionOrders: r2(inv.avgPositionOrders),
      inventoryPerM: str(res.inventory),
      cuts: cuts.length,
      cutsUsd: str(cutsUsd, 4),
      avgCutMoveBp: r2(avg(cuts.map((c) => c.moveBp))),
      latestCuts: cuts.slice(0, 5).map((c) => ({
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
    (await readOnly(deps, (x) => liveBots(x, ["volume_maker"]))).map((b) => [b.id, b]),
  );
  const rows = await readOnly(deps, async (x) => {
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
      ? (viewOf(await dataFor(deps, snap, q.tz), q).get("all|all")?.sums.n ?? 0)
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
  const one = await readOnly(deps, async (x) => {
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
    (await readOnly(deps, (x) => liveBots(x, ["volume_maker"]))).map((b) => [b.id, b]),
  );
  const bot = bots.get(one.bot);
  const all = viewOf(await dataFor(deps, snap, q.tz), q).get("all|all") ?? emptyStats();
  const at = one.at;
  const extra = await readOnly(deps, async (t) => {
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

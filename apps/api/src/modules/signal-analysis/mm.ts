import {
  AppError,
  decimalStringSchema,
  ErrorCode,
  MM_BREAKDOWNS,
  SIGNAL_MM_HORIZONS,
  SIGNAL_MIN_GROUP,
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
import { sql } from "drizzle-orm";
import { z } from "zod";

import { parseOrThrow } from "../../lib/http";

import { botFacets } from "./all";
import {
  bpOf,
  D0,
  dec,
  Decimal,
  inList,
  isThin,
  localClock,
  mean,
  negPct,
  perM,
  quantileOf,
  r2,
  readOnly,
  rowsOf,
  str,
  team,
  type BotInfo,
  type SignalDeps,
} from "./common";
import { CostAcc, dirOf, previousNet, type FillRow, type FillSet } from "./data";
import { extraSet, fillSet, previousSet } from "./sets";
import { timelineOf } from "./timeline";
import { desc } from "./vb";

// Tab Market Making: mỗi fill của bot Market Making tiền thật. bp theo notional của fill, + = có lợi cho fill:
//   spread kiếm được = chiều × (mid lúc fill − giá khớp) ÷ giá khớp; mid lúc fill = mid SoDEX trong giây đó (mid_1s, 48 giờ),
//   không có thì mid lúc đặt lệnh (`orders.context.mid`, DEC-312 / #233).
//   markout t = chiều × (giá sau t − giá khớp) ÷ giá khớp (đã gồm spread); giá chạy ngược = markout 1 phút − spread.
// $ / 1M (dương = tốn) dùng CostAcc như tab All. Quote level / Smart quoting / Binance clamp lấy từ `orders.context`;
// fill cũ hơn không có → "Not available".

type Kind = MmFill["kind"];

export interface MmX {
  f: FillRow;
  bot: BotInfo;
  dir: 1 | -1;
  usd: Decimal;
  feeBp: number;
  ctx: MmOrderContext | null;
  level: number | null;
  smart: boolean | null;
  clamp: "hit" | "normal" | null;
  kind: Kind;
  mid0: string | null;
  /** [lúc fill (spread), 10 s, 30 s, 1 phút, 2 phút, 5 phút]. */
  marks: (number | null)[];
  netAfterFees: number | null;
}

/**
 * Lệnh mở của bot bật Smart quoting nằm đúng giới hạn Binance (mua = giá Binance − 0,5 bp, bán = + 0,5 bp, sai số làm
 * tròn tick ≤ 0,25 bp) → "hit"; còn lại "normal". Tắt Smart quoting / lệnh đóng / không có bối cảnh → null.
 */
export function clampOf(side: "buy" | "sell", ctx: MmOrderContext | null, reduceOnly: boolean) {
  if (ctx === null || !ctx.smart || reduceOnly) return null;
  if (ctx.fairBp === null || ctx.fairAgeMs === null || ctx.fairAgeMs > VM_ORACLE.maxAgeMs)
    return "normal";
  const limit = side === "buy" ? -VM_ORACLE.marginBp : VM_ORACLE.marginBp;
  return Math.abs(ctx.fairBp - limit) <= 0.25 ? "hit" : "normal";
}

function enrich(f: FillRow, bot: BotInfo): MmX {
  const parsed = f.context === null ? null : mmOrderContextSchema.safeParse(f.context);
  const ctx = parsed?.success === true ? parsed.data : null;
  const dir = dirOf(f.side);
  const usd = dec(f.price).mul(dec(f.size));
  const n = usd.toNumber();
  const feeBp = n > 0 ? (Number(f.fee) / n) * 10_000 : 0;
  const mid0 = f.m0 ?? ctx?.mid ?? null;
  const marks = [mid0, f.m10, f.m30, f.r60, f.r120, f.r300].map((r) => bpOf(dir, f.price, r));
  const kind: Kind = f.tag.includes(":cut:")
    ? "cut"
    : f.reduceOnly || ctx?.reason === "stop" || ctx?.reason === "dust"
      ? "close"
      : "quote";
  const m60 = marks[3] ?? null;
  return {
    f,
    bot,
    dir,
    usd,
    feeBp,
    ctx,
    level: ctx?.level === null || ctx?.level === undefined ? null : Math.min(ctx.level, 3),
    smart: ctx === null ? null : ctx.smart,
    clamp: clampOf(f.side, ctx, f.reduceOnly),
    kind,
    mid0,
    marks,
    netAfterFees: m60 === null ? null : m60 - feeBp,
  };
}

interface MmData {
  set: FillSet;
  xs: MmX[];
  bots: Map<string, BotInfo>;
  /** Lệnh đặt / đã khớp theo (bot, level, smart, side); null khi kỳ > 7 ngày. */
  orders:
    | {
        bot: string;
        level: number;
        smart: boolean;
        side: "buy" | "sell";
        placed: number;
        filled: number;
      }[]
    | null;
  /** Dòng "Position cut": giá Binance và giá vào lúc cắt, theo bot. */
  cutEvents: Map<string, { at: number; moveBp: number | null }[]>;
}

async function dataFor(
  deps: SignalDeps,
  range: SignalMmQuery["range"],
  now: Date,
): Promise<MmData> {
  const set = await fillSet(deps, "volume_maker", range, now);
  return extraSet(deps, `mm|${range}`, now, async () => {
    const bots = new Map(set.bots.map((b) => [b.id, b]));
    const xs = set.fills.flatMap((f) => {
      const b = bots.get(f.botId);
      return b === undefined ? [] : [enrich(f, b)];
    });
    const botIds = [...new Set(set.fills.map((f) => f.botId))];
    const { orders, cutEvents } = await readOnly(deps.db, async (q) => {
      const cut = new Map<string, { at: number; moveBp: number | null }[]>();
      if (botIds.length === 0) return { orders: [], cutEvents: cut };
      const ev = await q.execute(sql`
        select bot_id::text as bot, (extract(epoch from occurred_at) * 1000)::float8 as at, payload->'quote' as quote
          from bot_events
          where bot_id in (${inList(botIds)}) and decision = 'Position cut'
            and occurred_at >= ${set.window.from} and occurred_at < ${set.window.to}`);
      for (const e of rowsOf<{ bot: string; at: number; quote: unknown }>(ev)) {
        const s = mmQuoteSnapshotSchema.safeParse(e.quote);
        let moveBp: number | null = null;
        if (s.success && s.data.inv.entry !== null && s.data.fair.price !== null) {
          const entry = Number(s.data.inv.entry);
          const fair = Number(s.data.fair.price);
          const long = dec(s.data.inv.position).gt(0);
          moveBp = entry > 0 ? ((long ? entry - fair : fair - entry) / entry) * 10_000 : null;
        }
        const xs2 = cut.get(e.bot) ?? [];
        xs2.push({ at: e.at, moveBp });
        cut.set(e.bot, xs2);
      }
      // Tỷ lệ khớp theo quote level: đếm lệnh mở đã đặt trong kỳ (chỉ kỳ ≤ 7 ngày để truy vấn có giới hạn).
      if (SIGNAL_RANGE_MS[range] > 7 * 86_400_000) return { orders: null, cutEvents: cut };
      const r = await q.execute(sql`
        select o.bot_id::text as bot, least((o.context->>'level')::int, 3) as level,
               coalesce((o.context->>'smart')::boolean, false) as smart, o.side,
               count(*)::int as placed, count(*) filter (where o.filled_size > 0)::int as filled
          from orders o
          where o.bot_id in (${inList(botIds)})
            and o.created_at >= ${set.window.from} and o.created_at < ${set.window.to}
            and o.context is not null and o.context->>'level' is not null
            and not o.reduce_only and o.type = 'limit' and o.status not in ('rejected', 'not_placed')
          group by 1, 2, 3, 4`);
      return {
        orders: rowsOf<{
          bot: string;
          level: number;
          smart: boolean;
          side: "buy" | "sell";
          placed: number;
          filled: number;
        }>(r),
        cutEvents: cut,
      };
    });
    return { set, xs, bots, orders, cutEvents };
  });
}

const botLevel = (q: SignalMmQuery, b: BotInfo) =>
  (q.market === undefined || b.market === q.market) && (q.botId === undefined || b.id === q.botId);
const fillLevel = (q: SignalMmQuery) =>
  q.level !== undefined || q.smart !== undefined || q.side !== undefined;

function filterX(xs: readonly MmX[], q: SignalMmQuery): MmX[] {
  return xs.filter(
    (x) =>
      botLevel(q, x.bot) &&
      (q.level === undefined || x.level === q.level) &&
      (q.smart === undefined || x.smart === (q.smart === "on")) &&
      (q.side === undefined || x.f.side === q.side),
  );
}

function rowOf(key: string, xs: readonly MmX[], total: number, d: MmData): MmRow {
  const acc = new CostAcc();
  for (const x of xs) acc.add(x.f);
  const res = acc.result(d.set, new Map([...d.bots.values()].map((b) => [b.id, b.market])), false);
  return {
    key,
    n: xs.length,
    sharePct: total === 0 ? null : r2((xs.length / total) * 100),
    spread: r2(mean(xs.map((x) => x.marks[0] ?? null))),
    markout10s: r2(mean(xs.map((x) => x.marks[1] ?? null))),
    markout1m: r2(mean(xs.map((x) => x.marks[3] ?? null))),
    markout5m: r2(mean(xs.map((x) => x.marks[5] ?? null))),
    againstPct: r2(negPct(xs.map((x) => x.marks[3] ?? null))),
    netAfterFees: r2(mean(xs.map((x) => x.netAfterFees))),
    netPerM: str(res.net),
    thin: isThin(xs.length),
  };
}

const SIZE_BANDS = [200, 500, 1000] as const;
const ORDER: Record<MmBreakdown, readonly string[] | null> = {
  level: ["0", "1", "2", "3", "unknown"],
  smart: ["on", "off", "unknown"],
  clamp: ["hit", "normal", "off", "unknown"],
  hour: ["0", "4", "8", "12", "16", "20"],
  market: null,
  size: ["0", "200", "500", "1000"],
  side: ["buy", "sell"],
};

function breakdownOf(xs: readonly MmX[], tz: string, d: MmData): SignalMmView["breakdown"] {
  const clock = localClock(tz);
  const keyOf: Record<MmBreakdown, (x: MmX) => string> = {
    level: (x) => (x.level === null ? "unknown" : String(x.level)),
    smart: (x) => (x.smart === null ? "unknown" : x.smart ? "on" : "off"),
    clamp: (x) => (x.ctx === null ? "unknown" : x.smart === false ? "off" : (x.clamp ?? "normal")),
    hour: (x) => String(Math.floor(clock(x.f.at).hour / 4) * 4),
    market: (x) => x.f.market,
    size: (x) => {
      const b = SIZE_BANDS.filter((s) => x.usd.gte(s)).at(-1);
      return b === undefined ? "0" : String(b);
    },
    side: (x) => x.f.side,
  };
  const out = {} as SignalMmView["breakdown"];
  for (const by of MM_BREAKDOWNS) {
    const groups = new Map<string, MmX[]>();
    for (const x of xs) {
      const k = keyOf[by](x);
      const g = groups.get(k) ?? [];
      g.push(x);
      groups.set(k, g);
    }
    const order = ORDER[by] ?? [...groups.keys()].sort();
    out[by] = {
      rows: order
        .filter((k) => groups.has(k))
        .map((k) => rowOf(k, groups.get(k) ?? [], xs.length, d)),
      total: rowOf("all", xs, xs.length, d),
    };
  }
  return out;
}

const orderSizeSchema = z.object({ orderSize: decimalStringSchema });

interface CutRow {
  fillId: string;
  orderId: string;
  at: number;
  createdAt: number;
  botId: string;
  market: string;
  botName: string;
  position: "long" | "short";
  entry: Decimal | null;
  price: Decimal;
  size: Decimal;
  heldSecs: number | null;
  result: Decimal | null;
}

/**
 * Đi lại fill của từng bot (bắt đầu từ vị thế đầu kỳ, sổ cái giá vốn bình quân): % thời gian phẳng, vị thế trung bình
 * (số lệnh = |vị thế| × giá ÷ order size, theo thời gian, lúc đang giữ) trong [fill đầu, fill cuối] của bot, và kết quả
 * mỗi lần cắt (giá cắt − giá vào bình quân) × size − phí của fill cắt.
 */
export function walkInventory(xs: readonly MmX[], posStart: Map<string, Decimal>) {
  const byBot = new Map<string, MmX[]>();
  for (const x of xs) {
    const g = byBot.get(x.bot.id) ?? [];
    g.push(x);
    byBot.set(x.bot.id, g);
  }
  let flatMs = 0;
  let spanMs = 0;
  let heldMs = 0;
  let heldOrdersMs = 0;
  let sized = true;
  const cuts: CutRow[] = [];
  for (const [botId, fs] of byBot) {
    const cfg = orderSizeSchema.safeParse(fs[0]?.bot.config);
    const orderSize = cfg.success ? Number(cfg.data.orderSize) : null;
    if (orderSize === null || !(orderSize > 0)) sized = false;
    let pos = posStart.get(botId) ?? D0;
    let entry: Decimal | null = null;
    let openedAt: number | null = pos.isZero() ? null : (fs[0]?.f.at ?? null);
    let lastAt = fs[0]?.f.at ?? 0;
    let lastPrice = Number(fs[0]?.f.price ?? "0");
    const flat = () => Math.abs(pos.toNumber() * lastPrice) < 1;
    for (const x of fs) {
      const dt = x.f.at - lastAt;
      spanMs += dt;
      if (flat()) flatMs += dt;
      else if (orderSize !== null && orderSize > 0) {
        heldMs += dt;
        heldOrdersMs += (Math.abs(pos.toNumber() * lastPrice) / orderSize) * dt;
      }
      const s = dec(x.f.size).mul(x.dir);
      const p = dec(x.f.price);
      const before = pos;
      if (x.kind === "cut" && !before.isZero()) {
        cuts.push({
          fillId: x.f.id,
          orderId: x.f.orderId,
          at: x.f.at,
          createdAt: x.f.createdAt,
          botId,
          market: x.f.market,
          botName: x.bot.name,
          position: before.gt(0) ? "long" : "short",
          entry,
          price: p,
          size: dec(x.f.size),
          heldSecs: openedAt === null ? null : Math.round((x.f.at - openedAt) / 1000),
          result:
            entry === null
              ? null
              : p
                  .sub(entry)
                  .mul(dec(x.f.size))
                  .mul(before.gt(0) ? 1 : -1)
                  .sub(dec(x.f.fee)),
        });
      }
      pos = before.add(s);
      // Sổ cái giá vốn bình quân: thêm cùng chiều thì bình quân lại; đảo chiều thì giá vào = giá khớp.
      if (before.isZero() || before.isNeg() === s.isNeg()) {
        entry =
          entry === null || before.isZero()
            ? p
            : entry.mul(before.abs()).add(p.mul(s.abs())).div(before.abs().add(s.abs()));
      } else if (pos.isZero()) entry = null;
      else if (pos.isNeg() !== before.isNeg()) entry = p;
      if (before.isZero() && !pos.isZero()) openedAt = x.f.at;
      if (pos.isZero()) openedAt = null;
      lastAt = x.f.at;
      lastPrice = Number(x.f.price);
    }
  }
  return {
    timeFlatPct: spanMs > 0 ? (flatMs / spanMs) * 100 : null,
    avgPositionOrders: sized && heldMs > 0 ? heldOrdersMs / heldMs : null,
    cuts,
  };
}

function mmSuggestions(
  xs: readonly MmX[],
  levels: SignalMmView["levels"],
  hours: SignalMmView["breakdown"]["hour"],
  cuts: number,
  overallNet: string | null,
  d: MmData,
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
    base.netAfterFees !== null
  ) {
    const rateOk = best.fillRatePct !== null && base.fillRatePct !== null;
    suggestions.push({
      key: rateOk ? "level" : "levelNoRate",
      n: base.n + best.n,
      values: {
        level: best.level,
        baseNet: base.netAfterFees,
        bestNet: best.netAfterFees ?? 0,
        baseAgainst:
          r2(negPct(xs.filter((x) => x.level === 0).map((x) => x.marks[3] ?? null))) ?? 0,
        bestAgainst:
          r2(negPct(xs.filter((x) => x.level === best.level).map((x) => x.marks[3] ?? null))) ?? 0,
        bestRate: best.fillRatePct ?? 0,
        baseRate: base.fillRatePct ?? 0,
      },
    });
  } else if (levels.some((l) => l.n > 0 && !ok(l.n))) {
    hidden.push({ key: "level", n: Math.min(...levels.filter((l) => l.n > 0).map((l) => l.n)) });
  }
  // 2. Smart quoting bật vs tắt.
  const on = xs.filter((x) => x.smart === true);
  const off = xs.filter((x) => x.smart === false);
  if (ok(on.length) && ok(off.length)) {
    const a = mean(on.map((x) => x.marks[3] ?? null));
    const b = mean(off.map((x) => x.marks[3] ?? null));
    if (a !== null && b !== null && a > b) {
      const inv = (g: readonly MmX[]) => {
        const acc = new CostAcc();
        for (const x of g) acc.add(x.f);
        return acc.result(
          d.set,
          new Map([...d.bots.values()].map((bt) => [bt.id, bt.market])),
          false,
        ).inventory;
      };
      const vol = xs.reduce((s, x) => s.add(x.usd), D0);
      const offVol = off.reduce((s, x) => s.add(x.usd), D0);
      suggestions.push({
        key: "smart",
        n: on.length + off.length,
        values: {
          on: r2(a) ?? 0,
          off: r2(b) ?? 0,
          invOn: str(inv(on), 0) ?? "",
          invOff: str(inv(off), 0) ?? "",
          offShare: vol.isZero() ? 0 : (r2(offVol.div(vol).mul(100).toNumber()) ?? 0),
        },
      });
    }
  } else if (on.length > 0 && off.length > 0)
    hidden.push({ key: "smart", n: Math.min(on.length, off.length) });
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
      key: "hours",
      n: worst.n,
      values: {
        from: Number(worst.key),
        net: str(dec(worst.netPerM ?? "0"), 0) ?? "",
        overall: str(dec(overallNet ?? "0"), 0) ?? "",
        against: worst.againstPct ?? 0,
      },
    });
  } else if (hours.rows.some((r) => r.n > 0 && !ok(r.n)) && worst === null) {
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
  const now = deps.now();
  const [d, prev] = await Promise.all([
    dataFor(deps, q.range, now),
    previousSet(deps, q.range, now),
  ]);
  const xs = filterX(d.xs, q);
  const botMarket = new Map([...d.bots.values()].map((b) => [b.id, b.market]));
  const acc = new CostAcc();
  for (const x of xs) acc.add(x.f);
  // Vị thế mang sang chỉ cộng khi bộ lọc theo bot (không theo level / Smart quoting / phía).
  const res = acc.result(d.set, botMarket, !fillLevel(q));
  let midVol = D0;
  let spreadUsd = D0;
  for (const x of xs) {
    if (x.mid0 === null) continue;
    midVol = midVol.add(x.usd);
    spreadUsd = spreadUsd.add(dec(x.mid0).sub(dec(x.f.price)).mul(dec(x.f.size)).mul(x.dir));
  }
  const spreadCost =
    acc.volume.gt(0) && midVol.div(acc.volume).gte(0.8) ? perM(spreadUsd.neg(), midVol) : null;
  const inv = walkInventory(
    d.xs.filter((x) => botLevel(q, x.bot)),
    d.set.posStart,
  );
  const cutRows = inv.cuts;
  const cutOrders = new Set(cutRows.map((c) => c.orderId));
  const cutsUsd = cutRows.some((c) => c.result === null)
    ? null
    : cutRows.reduce((s, c) => s.add(c.result ?? D0), D0);
  const moveOf = (c: CutRow) => {
    const evs = d.cutEvents.get(c.botId) ?? [];
    const hit = evs
      .filter((e) => e.at >= c.createdAt - 10_000 && e.at <= c.createdAt + 2_000)
      .sort((a, b) => Math.abs(a.at - c.createdAt) - Math.abs(b.at - c.createdAt))[0];
    return hit?.moveBp ?? null;
  };
  const levelRates = (level: number) => {
    if (d.orders === null) return null;
    const rows = d.orders.filter((o) => {
      const b = d.bots.get(o.bot);
      return (
        o.level === level &&
        b !== undefined &&
        botLevel(q, b) &&
        (q.smart === undefined || o.smart === (q.smart === "on")) &&
        (q.side === undefined || o.side === q.side)
      );
    });
    const placed = rows.reduce((s, o) => s + o.placed, 0);
    return placed === 0 ? null : (rows.reduce((s, o) => s + o.filled, 0) / placed) * 100;
  };
  const levels = [0, 1, 2, 3].map((level) => {
    const g = xs.filter((x) => x.level === level);
    return {
      level,
      n: g.length,
      spread: r2(mean(g.map((x) => x.marks[0] ?? null))),
      priceAgainst: r2(
        mean(
          g.map((x) =>
            x.marks[3] === null || x.marks[0] === null
              ? null
              : (x.marks[3] ?? 0) - (x.marks[0] ?? 0),
          ),
        ),
      ),
      netAfterFees: r2(mean(g.map((x) => x.netAfterFees))),
      fillRatePct: r2(levelRates(level)),
      thin: isThin(g.length),
    };
  });
  const breakdown = breakdownOf(xs, q.tz, d);
  const netStr = str(res.net);
  const { suggestions, hidden } = mmSuggestions(
    xs,
    levels,
    breakdown.hour,
    cutOrders.size,
    netStr,
    d,
  );
  const bots = [...new Set(xs.map((x) => x.bot.id))];
  const prevBots = [...prev.legs.keys()].filter((id) => {
    const b = d.bots.get(id);
    return b !== undefined && botLevel(q, b);
  });
  const moves = cutRows.map(moveOf);
  return {
    computedAt: now.toISOString(),
    range: q.range,
    tz: q.tz,
    from: d.set.window.from.toISOString(),
    to: d.set.window.to.toISOString(),
    bots: bots.length,
    accounts: new Set(bots.map((id) => d.bots.get(id)?.userId)).size,
    markets: [...new Set(d.set.fills.map((f) => f.market))].sort(),
    botList: botFacets(d.set.fills, d.bots),
    summary: {
      fills: xs.length,
      volume: str(acc.volume) ?? "0",
      spread: r2(mean(xs.map((x) => x.marks[0] ?? null))),
      markout1m: r2(mean(xs.map((x) => x.marks[3] ?? null))),
      feesBp: r2(mean(xs.map((x) => x.feeBp))),
      againstPct: r2(negPct(xs.map((x) => x.marks[3] ?? null))),
      cuts: cutOrders.size,
      cutsUsd: str(cutsUsd),
      netPerM: netStr,
      netUsd: str(res.netUsd),
      prevNetPerM: fillLevel(q) ? null : str(previousNet(prev, prevBots)),
      withContext: xs.filter((x) => x.ctx !== null).length,
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
      all: SIGNAL_MM_HORIZONS.map((_, i) => {
        const v = xs.map((x) => x.marks[i] ?? null);
        return {
          n: v.filter((x) => x !== null).length,
          mean: r2(mean(v)),
          p25: r2(quantileOf(v, 0.25)),
          p75: r2(quantileOf(v, 0.75)),
          againstPct: i === 0 ? null : r2(negPct(v)),
        };
      }),
      on: SIGNAL_MM_HORIZONS.map((_, i) =>
        r2(mean(xs.filter((x) => x.smart === true).map((x) => x.marks[i] ?? null))),
      ),
      off: SIGNAL_MM_HORIZONS.map((_, i) =>
        r2(mean(xs.filter((x) => x.smart === false).map((x) => x.marks[i] ?? null))),
      ),
      feesBp: r2(mean(xs.map((x) => x.feeBp))),
    },
    levels,
    inventory: {
      timeFlatPct: r2(inv.timeFlatPct),
      avgPositionOrders: r2(inv.avgPositionOrders),
      inventoryPerM: str(res.inventory),
      cuts: cutOrders.size,
      cutsUsd: str(cutsUsd),
      avgCutMoveBp: r2(mean(moves)),
      latestCuts: [...cutRows]
        .sort((a, b) => b.at - a.at)
        .slice(0, 5)
        .map((c) => ({
          fillId: c.fillId,
          at: new Date(c.at).toISOString(),
          market: c.market,
          botName: c.botName,
          position: c.position,
          moveBp: r2(moveOf(c)),
          entry: str(c.entry, 8),
          price: str(c.price, 8) ?? "0",
          heldSecs: c.heldSecs,
          resultUsd: str(c.result, 4),
        })),
    },
    breakdown,
  };
}

export function fillOf(x: MmX): MmFill {
  return {
    id: x.f.id,
    filledAt: new Date(x.f.at).toISOString(),
    market: x.f.market,
    botId: x.bot.id,
    botName: x.bot.name,
    side: x.f.side,
    level: x.level,
    smart: x.smart,
    clamp: x.clamp,
    kind: x.kind,
    usd: str(x.usd) ?? "0",
    spread: r2(x.marks[0]),
    markout10s: r2(x.marks[1]),
    markout1m: r2(x.marks[3]),
    markout5m: r2(x.marks[5]),
    netAfterFees: r2(x.netAfterFees),
  };
}

export async function signalMmFills(
  deps: SignalDeps,
  userId: string,
  query: unknown,
): Promise<SignalMmFillsPage> {
  await team(deps, userId);
  const q = parseOrThrow(signalMmFillsQuerySchema, query);
  const d = await dataFor(deps, q.range, deps.now());
  const xs = filterX(d.xs, q);
  const sorted =
    q.sort === "worst"
      ? [...xs].sort((a, b) => desc(-(a.marks[3] ?? Infinity), -(b.marks[3] ?? Infinity)))
      : q.sort === "cuts"
        ? xs.filter((x) => x.kind === "cut").reverse()
        : [...xs].reverse();
  const items = sorted.slice(q.offset, q.offset + SIGNAL_PAGE_SIZE).map(fillOf);
  const next = q.offset + SIGNAL_PAGE_SIZE;
  return { total: sorted.length, items, nextOffset: next < sorted.length ? next : null };
}

const idSchema = z.uuid();

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
  const d = await dataFor(deps, q.range, deps.now());
  const x = d.xs.find((y) => y.f.id === id);
  if (x === undefined) throw new AppError(ErrorCode.notFound, "Fill not found.");
  const xs = filterX(d.xs, q);
  const at = x.f.at;
  const extra = await readOnly(deps.db, async (t) => {
    const mids = await t.execute(sql`
      select ts, mid::text as p from mid_1s
        where market = ${x.f.market} and ts >= ${new Date(at - 60_000)} and ts <= ${new Date(at + 300_000)}
        order by ts limit 400`);
    const midRows = rowsOf<{ ts: string | Date; p: string }>(mids);
    const candles =
      midRows.length > 0
        ? []
        : rowsOf<{ ts: string | Date; p: string }>(
            await t.execute(sql`
              select ts, close::text as p from candles_1m
                where market = ${x.f.market} and ts >= ${new Date(at - 5 * 60_000)} and ts <= ${new Date(at + 10 * 60_000)}
                order by ts limit 20`),
          );
    const timeline = await timelineOf(t, x.bot.id, x.f.createdAt - 1_000, at + 300_000, "vm:%", {
      orderId: x.f.orderId,
      filledOnly: true,
    });
    return { midRows, candles, timeline };
  });
  const size = dec(x.f.size);
  const price = dec(x.f.price);
  const builder = x.f.builderFee === null ? D0 : dec(x.f.builderFee);
  const fee = dec(x.f.fee);
  const spreadUsd = x.mid0 === null ? null : dec(x.mid0).sub(price).mul(size).mul(x.dir);
  const markoutUsd = x.f.r60 === null ? null : dec(x.f.r60).sub(price).mul(size).mul(x.dir);
  const ctx = x.ctx;
  const cfg = orderSizeSchema.safeParse(x.bot.config);
  const pts = (extra.midRows.length > 0 ? extra.midRows : extra.candles).map((r) => ({
    t: new Date(r.ts).toISOString(),
    p: r.p,
  }));
  const limit = x.f.side === "buy" ? -VM_ORACLE.marginBp : VM_ORACLE.marginBp;
  return {
    fill: fillOf(x),
    price: x.f.price,
    size: x.f.size,
    mid: x.mid0,
    prices: pts,
    priceSource: extra.midRows.length > 0 ? "mid" : extra.candles.length > 0 ? "candles" : null,
    quote: {
      level: ctx?.level ?? null,
      smart: ctx?.smart ?? null,
      clamp: x.clamp,
      insideLimitBp:
        ctx === null || !ctx.smart || ctx.fairBp === null || x.f.reduceOnly
          ? null
          : r2(x.f.side === "buy" ? limit - ctx.fairBp : ctx.fairBp - limit),
      spreadBp: spreadOf(ctx),
      bookSecs: r2((x.f.at - x.f.createdAt) / 1000),
      positionBefore: ctx?.pos ?? null,
      positionOrders:
        ctx === null || !cfg.success || !(Number(cfg.data.orderSize) > 0)
          ? null
          : r2((Math.abs(Number(ctx.pos)) * Number(x.f.price)) / Number(cfg.data.orderSize)),
    },
    markouts: x.marks.map(r2),
    markoutsAll: SIGNAL_MM_HORIZONS.map((_, i) => r2(mean(xs.map((y) => y.marks[i] ?? null)))),
    split: {
      spread: str(spreadUsd, 4),
      priceAgainst: str(
        spreadUsd === null || markoutUsd === null ? null : markoutUsd.sub(spreadUsd),
        4,
      ),
      sodexFee: str(fee.sub(builder).neg(), 4) ?? "0",
      builderFee: str(builder.neg(), 4) ?? "0",
      net: str(markoutUsd === null ? null : markoutUsd.sub(fee), 4),
    },
    timeline: extra.timeline,
  };
}

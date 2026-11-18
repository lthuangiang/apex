import { MARKET_HOURS_MAX_MISSING_PRICE } from "@drift/shared";
import { sql, type SQL } from "drizzle-orm";

import {
  D0,
  dec,
  Decimal,
  inList,
  marksAt,
  perM,
  positionsAt,
  rowsOf,
  str,
  type BotInfo,
  type Exec,
  type Window,
} from "./common";

// Dữ liệu fill cho Signal Analysis (index fills_filled_at_idx), giá tham chiếu theo cách của Market hours (DEC-283):
//   - 1 / 2 / 5 phút: close của nến 1 phút chứa thời điểm fill + 60 / 120 / 300 s (candles_1m, khoá (market, ts)); nến
//     chưa đóng trước cuối kỳ thì không dùng.
//   - lúc fill / 10 s / 30 s: mid SoDEX theo giây (`mid_1s`, chỉ market có bot Market Making, giữ 48 giờ).
// Market Making và tab All cộng trong SQL (không kéo từng fill về Node: review #246 điểm 4); Volume Builder (ít fill)
// ghép lượt trong Node. Không có giá → null ("Not available"), không bao giờ 0.

export const dirOf = (side: "buy" | "sell"): 1 | -1 => (side === "buy" ? 1 : -1);

// ── Cách chia chi phí ────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Các tổng của một nhóm fill (SQL cộng sẵn, hoặc Node cộng cho Volume Builder). `p*` = chỉ fill có giá 1 phút.
 * `end` = Σ chiều × (giá cuối kỳ − giá khớp) × size; `noMark` = số fill thiếu giá cuối kỳ.
 */
export interface Sums {
  n: number;
  vol: Decimal;
  fees: Decimal;
  builder: Decimal;
  /** Số fill không có builder fee đã ghi (`fills.builder_fee` null). */
  bNull: number;
  end: Decimal;
  noMark: number;
  pVol: Decimal;
  pFees: Decimal;
  pBuilder: Decimal;
  pBNull: number;
  pEnd: Decimal;
  pNoMark: number;
  /** Σ chiều × (giá 1 phút − giá khớp) × size, fill có giá 1 phút. */
  mk: Decimal;
}

export const emptySums = (): Sums => ({
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
});

export function addSums(a: Sums, b: Sums): Sums {
  return {
    n: a.n + b.n,
    vol: a.vol.add(b.vol),
    fees: a.fees.add(b.fees),
    builder: a.builder.add(b.builder),
    bNull: a.bNull + b.bNull,
    end: a.end.add(b.end),
    noMark: a.noMark + b.noMark,
    pVol: a.pVol.add(b.pVol),
    pFees: a.pFees.add(b.pFees),
    pBuilder: a.pBuilder.add(b.pBuilder),
    pBNull: a.pBNull + b.pBNull,
    pEnd: a.pEnd.add(b.pEnd),
    pNoMark: a.pNoMark + b.pNoMark,
    mk: a.mk.add(b.mk),
  };
}

/** Cột SQL của `Sums` trên nguồn có các cột usd, fee, builder_fee, r60, mk_usd, end_usd (cùng tên field camel). */
export const SUMS_SQL = sql`count(*)::int as n,
  coalesce(sum(usd), 0)::text as vol, coalesce(sum(fee), 0)::text as fees,
  coalesce(sum(builder_fee), 0)::text as builder, (count(*) filter (where builder_fee is null))::int as "bNull",
  coalesce(sum(end_usd), 0)::text as "end", (count(*) filter (where end_usd is null))::int as "noMark",
  coalesce(sum(usd) filter (where r60 is not null), 0)::text as "pVol",
  coalesce(sum(fee) filter (where r60 is not null), 0)::text as "pFees",
  coalesce(sum(builder_fee) filter (where r60 is not null), 0)::text as "pBuilder",
  (count(*) filter (where r60 is not null and builder_fee is null))::int as "pBNull",
  coalesce(sum(end_usd) filter (where r60 is not null), 0)::text as "pEnd",
  (count(*) filter (where r60 is not null and end_usd is null))::int as "pNoMark",
  coalesce(sum(mk_usd), 0)::text as mk`;

export interface SumsRow {
  n: number;
  vol: string;
  fees: string;
  builder: string;
  bNull: number;
  end: string;
  noMark: number;
  pVol: string;
  pFees: string;
  pBuilder: string;
  pBNull: number;
  pEnd: string;
  pNoMark: number;
  mk: string;
}

export const sumsOf = (r: SumsRow): Sums => ({
  n: r.n,
  vol: dec(r.vol),
  fees: dec(r.fees),
  builder: dec(r.builder),
  bNull: r.bNull,
  end: dec(r.end),
  noMark: r.noMark,
  pVol: dec(r.pVol),
  pFees: dec(r.pFees),
  pBuilder: dec(r.pBuilder),
  pBNull: r.pBNull,
  pEnd: dec(r.pEnd),
  pNoMark: r.pNoMark,
  mk: dec(r.mk),
});

/**
 * Chi phí $ / 1M của một nhóm (cùng cách ở cả ba tab, dương = tốn):
 *   kết quả giá tới cuối kỳ của fill = q × (giá cuối kỳ − giá khớp) = markout 1 phút (q × (giá 1 phút − giá khớp)) +
 *   tồn kho (phần còn lại). Net = phí − kết quả giá − `carried` (vị thế mang sang × (giá cuối − giá đầu), chỉ nhóm theo
 *   bot; null = thiếu giá).
 * Cùng một mẫu số (review #246 điểm 9): khi fill có giá 1 phút chiếm ≥ 80% volume, phí, markout, tồn kho và net đều chia
 * cho volume của các fill đó (fill thiếu giá không vào cả bốn); dưới 80% thì markout và tồn kho "Not available", phí và
 * net chia cho toàn bộ volume. Builder fee chưa ghi ở fill nào của mẫu → phần SoDEX / builder "Not available" (không dồn
 * vào phí SoDEX). `netUsd` = tổng tuyệt đối trên mọi fill.
 */
export function costOf(s: Sums, carried: Decimal | null) {
  const share = s.vol.isZero() ? new Decimal(0) : s.pVol.div(s.vol);
  const priced = s.pVol.gt(0) && new Decimal(1).sub(share).lte(MARKET_HOURS_MAX_MISSING_PRICE);
  const vol = priced ? s.pVol : s.vol;
  const fees = priced ? s.pFees : s.fees;
  const builder = priced ? s.pBuilder : s.builder;
  const bNull = priced ? s.pBNull : s.bNull;
  const end = priced ? s.pEnd : s.end;
  const noMark = priced ? s.pNoMark : s.noMark;
  const netUsdBasis = noMark > 0 || carried === null ? null : fees.sub(end).sub(carried);
  const net = perM(netUsdBasis, vol);
  const feesPerM = perM(fees, vol);
  const markout = priced ? perM(s.mk.neg(), s.pVol) : null;
  return {
    fills: s.n,
    volume: s.vol,
    fees: feesPerM,
    sodexFees: bNull > 0 ? null : perM(fees.sub(builder), vol),
    builderFees: bNull > 0 ? null : perM(builder, vol),
    markout,
    inventory:
      net === null || markout === null || feesPerM === null ? null : net.sub(feesPerM).sub(markout),
    net,
    netUsd: s.noMark > 0 || carried === null ? null : s.fees.sub(s.end).sub(carried),
    /** Mẫu số của các số / 1M là volume có giá 1 phút. */
    priced,
  };
}

export type CostResult = ReturnType<typeof costOf>;

export const costStrings = (c: CostResult) => ({
  fills: c.fills,
  volume: str(c.volume) ?? "0",
  fees: str(c.fees),
  sodexFees: str(c.sodexFees),
  builderFees: str(c.builderFees),
  markout: str(c.markout),
  inventory: str(c.inventory),
  net: str(c.net),
  netUsd: str(c.netUsd),
});

export interface Marks {
  markEnd: Map<string, string>;
  markStart: Map<string, string>;
  posStart: Map<string, Decimal>;
}

/** Phần vị thế mang sang của một tập bot: Σ vị thế đầu kỳ × (giá cuối − giá đầu); thiếu giá cần dùng → null. */
export function carriedOf(
  m: Marks,
  botIds: Iterable<string>,
  botMarket: (id: string) => string | undefined,
): Decimal | null {
  let c = D0;
  for (const id of botIds) {
    const pos = m.posStart.get(id) ?? D0;
    if (pos.isZero()) continue;
    const market = botMarket(id) ?? "";
    const a = m.markStart.get(market);
    const b = m.markEnd.get(market);
    if (a === undefined || b === undefined) return null;
    c = c.add(pos.mul(dec(b).sub(dec(a))));
  }
  return c;
}

/** Giá đầu / cuối kỳ của các market và vị thế đầu kỳ của các bot. */
export async function marksFor(
  q: Exec,
  w: Window,
  markets: readonly string[],
  botIds: readonly string[],
): Promise<Marks> {
  // Tuần tự: cùng một transaction (một kết nối) không chạy song song.
  const markEnd = await marksAt(q, markets, w.to);
  const markStart = await marksAt(q, markets, w.from);
  const [posStart] = await positionsAt(q, botIds, [w.from]);
  return { markEnd, markStart, posStart: posStart ?? new Map<string, Decimal>() };
}

// ── Nền SQL: một dòng mỗi fill với các cột suy ra ─────────────────────────────────────────────────────────────────

const NUM = "'^-?[0-9]+(\\.[0-9]+)?([eE][-+]?[0-9]+)?$'";

/** `context->>key` thành số khi đúng là số JSON (một dòng hỏng không làm hỏng cả truy vấn, review #246 điểm 14). */
const ctxNum = (key: string, cast: "int" | "float8") =>
  sql.raw(
    `case when jsonb_typeof(o.context->'${key}') = 'number' then (o.context->>'${key}')::numeric::${cast} end`,
  );
const ctxDec = (key: string) =>
  sql.raw(
    `case when jsonb_typeof(o.context->'${key}') = 'string' and (o.context->>'${key}') ~ ${NUM} then (o.context->>'${key}')::numeric end`,
  );

export interface BaseOpts {
  w: Window;
  strategies: readonly BotInfo["strategy"][];
  /** Lọc theo bot (market / bot / account): áp ngay ở nền. */
  where?: SQL;
  /** Cột mid theo giây và bối cảnh lệnh (chỉ Market Making). */
  mm: boolean;
  tz: string;
  /** Nền được đọc nhiều lần trong truy vấn: tính một lần. */
  materialized?: boolean;
  /** Chỉ các fill này (truy vấn con trả `id`), cho danh sách phân trang. */
  ids?: SQL;
  /** Giới hạn Binance của Smart quoting (chỉ MM): tuổi tối đa (ms), lề và sai số làm tròn (bp). */
  clamp?: { maxAgeMs: number; marginBp: number; toleranceBp: number };
}

/**
 * CTE `marks` (giá cuối kỳ mỗi market) + `base` (mỗi fill một dòng; MATERIALIZED khi truy vấn đọc lại nhiều lần; mọi cột
 * suy ra tính ngay trong đó).
 * Cột: id, at (ms), filled_at, bot_id, market, side, d (±1), price, size, usd, fee, builder_fee, created_at, reduce_only,
 * tag, r60, mk_usd, end_usd, b60 / b120 / b300 (bp theo hướng fill), local_day, local_hour; MM thêm mid0, b0 / b10 / b30,
 * lvl, smart, fair_bp, fair_age, reason, has_ctx, spread_usd, kind, clamp, fee_bp, block, band.
 */
export function baseCte(o: BaseOpts): SQL {
  const from = o.w.from;
  const lastCandle = new Date(o.w.to.getTime() - 60_000);
  // Điều kiện ts có cận dưới / trên (dùng được khoá (market, ts), bảng băm nhỏ); nến phải đóng trước cuối kỳ.
  const candle = (alias: string, secs: number) =>
    sql`left join candles_1m ${sql.raw(alias)} on ${sql.raw(alias)}.market = o.market
          and ${sql.raw(alias)}.ts = date_trunc('minute', f.filled_at + ${sql.raw(`interval '${String(secs)} seconds'`)})
          and ${sql.raw(alias)}.ts >= ${from}::timestamptz and ${sql.raw(alias)}.ts <= ${lastCandle}::timestamptz`;
  const mid = (alias: string, secs: number) =>
    sql`left join mid_1s ${sql.raw(alias)} on ${sql.raw(alias)}.market = o.market
          and ${sql.raw(alias)}.ts = date_trunc('second', f.filled_at + ${sql.raw(`interval '${String(secs)} seconds'`)})
          and ${sql.raw(alias)}.ts >= ${from}::timestamptz and ${sql.raw(alias)}.ts <= ${new Date(o.w.to.getTime() + 31_000)}::timestamptz`;
  const bp = (ref: string) =>
    sql.raw(`(d * ((${ref}) - price) / nullif(price, 0) * 10000)::float8`);
  const mmInner = o.mm
    ? sql`, coalesce(m0.mid, ${ctxDec("mid")}) as mid0, m10.mid as m10, m30.mid as m30,
         least(${ctxNum("level", "int")}, 3) as lvl,
         case when jsonb_typeof(o.context->'smart') = 'boolean' then (o.context->>'smart')::boolean end as smart,
         ${ctxNum("fairBp", "float8")} as fair_bp, ${ctxNum("fairAgeMs", "float8")} as fair_age,
         o.context->>'reason' as reason, o.context is not null as has_ctx`
    : sql``;
  const mmOuter = o.mm
    ? sql`, ${bp("mid0")} as b0, ${bp("m10")} as b10, ${bp("m30")} as b30, d * (mid0 - price) * size as spread_usd,
         case when tag like '%:cut:%' then 'cut'
              when reduce_only or reason in ('stop', 'dust') then 'close' else 'quote' end as kind,
         case when not has_ctx or smart is not true or reduce_only then null
              when fair_bp is null or fair_age is null or fair_age > ${o.clamp?.maxAgeMs ?? 0} then 'normal'
              when abs(fair_bp - (case when side = 'buy' then ${-(o.clamp?.marginBp ?? 0)}::float8 else ${o.clamp?.marginBp ?? 0}::float8 end)) <= ${o.clamp?.toleranceBp ?? 0}
                then 'hit'
              else 'normal' end as clamp,
         (fee / nullif(usd, 0) * 10000)::float8 as fee_bp,
         ((local_hour / 4) * 4)::text as block,
         case when usd >= 1000 then '1000' when usd >= 500 then '500' when usd >= 200 then '200' else '0' end as band`
    : sql``;
  const mmJoins = o.mm ? sql`${mid("m0", 0)} ${mid("m10", 10)} ${mid("m30", 30)}` : sql``;
  return sql`marks as (
      select distinct on (market) market, close
        from candles_1m
        where market in (select market from bots where mode = 'live' and strategy in (${inList(o.strategies)}))
          and ts <= ${o.w.to} and ts > ${new Date(o.w.to.getTime() - 3_600_000)}
        order by market, ts desc),
    base as ${o.materialized === true ? sql`materialized` : sql``} (
      -- Chỉ giữ cột các phần sau dùng (dòng hẹp: materialize và đọc lại rẻ hơn).
      select id, at, filled_at, bot_id, market, side, price, size, usd, fee, builder_fee, created_at, reduce_only,
             tag, r60, mk_usd, end_usd, b60, b120, b300, local_day, local_hour
             ${o.mm ? sql`, mid0, b0, b10, b30, spread_usd, kind, clamp, fee_bp, block, band, lvl, smart, has_ctx` : sql``}
      from (
      select s.*, d * (r60 - price) * size as mk_usd, d * (m_end - price) * size as end_usd,
             ${bp("r60")} as b60, ${bp("r120")} as b120, ${bp("r300")} as b300 ${mmOuter}
        from (
          select f.id, (extract(epoch from f.filled_at) * 1000)::float8 as at, f.filled_at, o.bot_id, o.market,
                 o.side, case when o.side = 'buy' then 1 else -1 end as d, f.price, f.size, f.price * f.size as usd,
                 f.fee, f.builder_fee, o.created_at, o.reduce_only, o.tag, c1.close as r60, c2.close as r120,
                 c5.close as r300, me.close as m_end,
                 to_char(f.filled_at at time zone ${o.tz}, 'YYYY-MM-DD') as local_day,
                 extract(hour from f.filled_at at time zone ${o.tz})::int as local_hour
                 ${mmInner}
            from fills f
            join orders o on o.id = f.order_id
            join bots b on b.id = o.bot_id
            left join marks me on me.market = o.market
            ${mmJoins}
            ${candle("c1", 60)}
            ${candle("c2", 120)}
            ${candle("c5", 300)}
            where f.filled_at >= ${o.w.from} and f.filled_at < ${o.w.to}
              and b.mode = 'live' and b.strategy in (${inList(o.strategies)})
              -- Theo orders_bot_idx (bot_id, created_at): lệnh tạo quá 1 ngày trước kỳ không tính (như Market hours,
              -- DEC-283; lệnh MM / VB nằm vài giây).
              and o.bot_id in (select id from bots where mode = 'live' and strategy in (${inList(o.strategies)}))
              and o.created_at >= ${new Date(o.w.from.getTime() - 86_400_000)}
              ${o.ids === undefined ? sql`` : sql`and f.id in (${o.ids})`}
              ${o.where === undefined ? sql`` : sql`and ${o.where}`}) s) t)`;
}

// ── Volume Builder: fill trong Node (ít) ───────────────────────────────────────────────────────────────────────────

export interface VbFill {
  id: string;
  orderId: string;
  /** Epoch ms. */
  at: number;
  botId: string;
  side: "buy" | "sell";
  market: string;
  price: string;
  size: string;
  /** Đã gồm builder fee. */
  fee: string;
  builderFee: string | null;
  maker: boolean | null;
  tag: string;
  createdAt: number;
  clOrdId: string;
  /** Close nến 1 phút sau fill (giá tham chiếu markout 1 phút). */
  r60: string | null;
  /** bp theo hướng fill: 10 s, 30 s (mid_1s), 1, 2, 5 phút (nến). */
  m10: number | null;
  m30: number | null;
  m60: number | null;
  m120: number | null;
  m300: number | null;
  /** Giá thay đổi (bp, chưa nhân hướng) trong 1 / 3 / 5 phút trước lúc đặt, từ nến 1 phút đã đóng. */
  c1: number | null;
  c3: number | null;
  c5: number | null;
}

export interface FillSet extends Marks {
  window: Window;
  bots: BotInfo[];
  fills: VbFill[];
}

/** Mọi fill của bot Volume Builder tiền thật trong kỳ, kèm markout (bp) và giá đã chạy trước lúc đặt (từ nến). */
export async function loadVbFills(q: Exec, w: Window, bots: BotInfo[]): Promise<FillSet> {
  const chg = (k: number) =>
    sql.raw(
      `((cb.close - k${String(k)}.close) / nullif(k${String(k)}.close, 0) * 10000)::float8 as c${String(k)}`,
    );
  const back = (k: number) =>
    sql.raw(
      `left join candles_1m k${String(k)} on k${String(k)}.market = o.market and k${String(k)}.ts = date_trunc('minute', o.created_at) - interval '${String(k + 1)} minutes'`,
    );
  const r = await q.execute(sql`
    with ${baseCte({ w, strategies: ["volume_farm"], mm: false, tz: "UTC" })}
    select x.id::text as id, o.id::text as "orderId", x.at, x.bot_id::text as "botId", x.side, x.market,
           x.price::text as price, x.size::text as size, x.fee::text as fee, x.builder_fee::text as "builderFee",
           f.is_maker as maker, x.tag, (extract(epoch from x.created_at) * 1000)::float8 as "createdAt",
           o.cl_ord_id as "clOrdId", x.r60::text as r60,
           ((case when x.side = 'buy' then 1 else -1 end) * (m10.mid - x.price) / nullif(x.price, 0) * 10000)::float8 as m10,
           ((case when x.side = 'buy' then 1 else -1 end) * (m30.mid - x.price) / nullif(x.price, 0) * 10000)::float8 as m30,
           x.b60 as m60, x.b120 as m120, x.b300 as m300, ${chg(1)}, ${chg(3)}, ${chg(5)}
      from base x
      join fills f on f.id = x.id
      join orders o on o.id = f.order_id
      left join mid_1s m10 on m10.market = x.market and m10.ts = date_trunc('second', x.filled_at + interval '10 seconds')
      left join mid_1s m30 on m30.market = x.market and m30.ts = date_trunc('second', x.filled_at + interval '30 seconds')
      left join candles_1m cb on cb.market = o.market and cb.ts = date_trunc('minute', o.created_at) - interval '1 minute'
      ${back(1)}
      ${back(3)}
      ${back(5)}
      order by x.filled_at, x.id`);
  const fills = rowsOf<VbFill>(r);
  const marks = await marksFor(
    q,
    w,
    [...new Set(fills.map((f) => f.market))],
    [...new Set(fills.map((f) => f.botId))],
  );
  return { window: w, bots, fills, ...marks };
}

/** Một fill VB thành `Sums` (cộng trong Node, cùng công thức với SQL). */
export function sumsOfFill(f: VbFill, markEnd: Map<string, string>): Sums {
  const p = dec(f.price);
  const s = dec(f.size);
  const usd = p.mul(s);
  const d = dirOf(f.side);
  const fee = dec(f.fee);
  const builder = f.builderFee === null ? D0 : dec(f.builderFee);
  const m = markEnd.get(f.market);
  const end = m === undefined ? null : dec(m).sub(p).mul(s).mul(d);
  const priced = f.r60 !== null;
  const mk = f.r60 === null ? D0 : dec(f.r60).sub(p).mul(s).mul(d);
  return {
    n: 1,
    vol: usd,
    fees: fee,
    builder,
    bNull: f.builderFee === null ? 1 : 0,
    end: end ?? D0,
    noMark: end === null ? 1 : 0,
    pVol: priced ? usd : D0,
    pFees: priced ? fee : D0,
    pBuilder: priced ? builder : D0,
    pBNull: priced && f.builderFee === null ? 1 : 0,
    pEnd: priced ? (end ?? D0) : D0,
    pNoMark: priced && end === null ? 1 : 0,
    mk,
  };
}

// ── Kỳ trước ───────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Net cost / $1M của kỳ trước (cùng độ dài) theo bot: tổng trong SQL (không kéo từng fill), vị thế đầu kỳ trước và giá
 * đầu / cuối kỳ trước. Bot không có fill kỳ trước → không có khoá.
 */
export async function previousByBot(
  q: Exec,
  strategies: readonly BotInfo["strategy"][],
  w: Window,
): Promise<
  Marks & {
    legs: Map<
      string,
      { market: string; volume: Decimal; fees: Decimal; qty: Decimal; cash: Decimal }
    >;
  }
> {
  const r = await q.execute(sql`
    select o.bot_id::text as bot, o.market,
           sum(f.price * f.size)::text as volume, sum(f.fee)::text as fees,
           sum(case when o.side = 'buy' then f.size else -f.size end)::text as qty,
           sum(case when o.side = 'buy' then f.price * f.size else -(f.price * f.size) end)::text as cash
      from fills f
      join orders o on o.id = f.order_id
      join bots b on b.id = o.bot_id
      where f.filled_at >= ${w.from} and f.filled_at < ${w.to}
        and b.mode = 'live' and b.strategy in (${inList(strategies)})
      group by o.bot_id, o.market`);
  const rows = rowsOf<{
    bot: string;
    market: string;
    volume: string;
    fees: string;
    qty: string;
    cash: string;
  }>(r);
  const legs = new Map(
    rows.map((x) => [
      x.bot,
      {
        market: x.market,
        volume: dec(x.volume),
        fees: dec(x.fees),
        qty: dec(x.qty),
        cash: dec(x.cash),
      },
    ]),
  );
  const marks = await marksFor(q, w, [...new Set(rows.map((x) => x.market))], [...legs.keys()]);
  return { legs, ...marks };
}

/** Net cost / $1M kỳ trước của một tập bot; bot thiếu giá → null; không có volume → null. */
export function previousNet(
  prev: Awaited<ReturnType<typeof previousByBot>>,
  botIds: Iterable<string>,
): Decimal | null {
  let volume = D0;
  let net: Decimal | null = D0;
  for (const bot of botIds) {
    const l = prev.legs.get(bot);
    if (l === undefined) continue;
    volume = volume.add(l.volume);
    if (net === null) continue;
    const end = prev.markEnd.get(l.market);
    const pos = prev.posStart.get(bot) ?? D0;
    const start = prev.markStart.get(l.market);
    if (end === undefined || (!pos.isZero() && start === undefined)) {
      net = null;
      continue;
    }
    const price = dec(end)
      .mul(l.qty)
      .sub(l.cash)
      .add(pos.isZero() ? D0 : pos.mul(dec(end).sub(dec(start ?? "0"))));
    net = net.add(l.fees.sub(price));
  }
  return net === null ? null : perM(net, volume);
}

/** Hiệu "vs previous" (chuỗi thập phân, review #246 điểm 15): null khi thiếu một trong hai. */
export function deltaOf(cur: Decimal | null, prev: Decimal | null): string | null {
  return cur === null || prev === null ? null : str(cur.sub(prev));
}

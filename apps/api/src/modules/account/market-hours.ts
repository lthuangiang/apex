import { type Db } from "@drift/db";
import {
  dec,
  Decimal,
  fillCostPerMillion,
  MARKET_HOURS_HOT_RATIO,
  MARKET_HOURS_THIN_BOT_HOURS,
  marketHoursQuerySchema,
  medianSwingBps,
  medianTicks,
  minuteRangeBp,
  mmBuilderFeeBps,
  modelCostPerMillion,
  modelPnlBps,
  perpsMakerFeeBps,
  quantile,
  stepBpsOf,
  Strategy,
  type CostFill,
  type MarketHoursEstimate,
  type MarketHoursHour,
  type MarketHoursQuery,
  type MarketHoursView,
} from "@drift/shared";
import type { SodexRestClient } from "@drift/sodex";
import { sql } from "drizzle-orm";

import { parseOrThrow } from "../../lib/http";
import { latestMmModel } from "../bots/mm-cost";

import { requireTeam } from "./team";

// Market hours cho team Ops (docs/mockups/market-hours, DEC-283). Chỉ đọc. Giờ / ngày theo múi giờ của
// người xem: Postgres đổi mốc thời gian sang giờ địa phương (`AT TIME ZONE`), trung vị tính bằng decimal ở đây.
//   Khối 1: candles_1m của market (khoá chính (market, ts)).
//   Khối 2: mm_market_hourly (theo giờ UTC; múi giờ lệch 30 phút thì gán theo phút bắt đầu, xấp xỉ, DevOps chấp nhận).
//   Khối 3: fill của bot Market Making / Volume Builder tiền thật (mọi user ở bản team). Hàm tính nhận `userId?` để bản
//   public sau này chỉ lấy bot của người xem.
// Thiếu dữ liệu → null ("Not available"), không bao giờ 0.

const DAY_MS = 86_400_000;
const strategiesOf = (s: MarketHoursQuery["strategy"]): string[] =>
  s === "both" ? [Strategy.volumeMaker, Strategy.volumeFarm] : [s];

interface Deps {
  db: Db;
  now: () => Date;
  rest: Pick<SodexRestClient, "getPerpsSymbols">;
}

const rowsOf = <T>(r: { rows: unknown[] }): T[] => r.rows as T[];
const iso = (v: unknown): string | null =>
  v === null || v === undefined ? null : new Date(v as string | Date).toISOString();

export async function marketHours(
  deps: Deps,
  userId: string,
  query: unknown,
): Promise<MarketHoursView> {
  // Kiểm quyền trước, parse sau: người không thuộc team nhận 403, không phải 400.
  await requireTeam(deps.db, userId, "Market hours is for the DeskLabs team only.");
  const q = parseOrThrow(marketHoursQuerySchema, query);
  const now = deps.now().getTime();
  const from = new Date(now - q.days * DAY_MS);
  const strategies = strategiesOf(q.strategy);
  const markets = await marketList(deps.db, from);
  const market = q.market ?? (markets.includes("BTC-USD") ? "BTC-USD" : (markets[0] ?? null));
  const base = {
    market,
    markets,
    days: q.days,
    strategy: q.strategy,
    tz: q.tz,
  };
  if (market === null)
    return {
      ...base,
      hours: emptyHours(),
      heatmap: [],
      candlesSince: null,
      markoutSince: null,
      markoutDays: 0,
      fillsSince: null,
      estimate: {
        feesBp: str(estimateFeesBps(undefined)) ?? "0",
        stepBp: null,
        modelVersion: 0,
        unavailable: "no_candles",
      },
    };
  const [vol, cost, bots, model, info] = await Promise.all([
    volatility(deps.db, market, from, q.tz),
    makerCost(deps.db, market, from, q.tz),
    botHours(deps.db, { market, from, tz: q.tz, strategies }),
    latestMmModel(deps),
    marketInfo(deps, market),
  ]);
  // Dòng "Estimated cost per $1M (model)": cùng mô hình với thẻ chi phí Market Making (mm-cost.ts, DEC-228). Bước giá
  // = tick ÷ giá đóng của nến 1 phút mới nhất; phí = maker SoDEX của market + builder fee Market Making mặc định.
  const feesBps = estimateFeesBps(info?.makerFee);
  const step = info === null ? null : stepBpsOf(info.tickSize, vol.lastClose);
  const estimate: MarketHoursEstimate = {
    feesBp: str(feesBps) ?? "0",
    stepBp: str(step),
    modelVersion: model.version,
    unavailable: vol.lastClose === null ? "no_candles" : step === null ? "no_market_info" : null,
  };
  const estOf = (swing: Decimal | null): string | null =>
    step === null || swing === null
      ? null
      : str(modelCostPerMillion(feesBps, modelPnlBps(step, swing, model.a, model.k)));
  const hours: MarketHoursHour[] = Array.from({ length: 24 }, (_, h) => {
    const vh = vol.hours[h];
    return {
      hour: h,
      volatility:
        vh === undefined
          ? emptyHour().volatility
          : { ...vh.out, swingBp: str(vh.swing), estCostPerMillion: estOf(vh.swing) },
      cost: cost.hours[h] ?? emptyHour().cost,
      bots: bots.hours[h] ?? emptyHour().bots,
    };
  });
  return {
    ...base,
    hours,
    heatmap: vol.heatmap,
    candlesSince: vol.since,
    markoutSince: cost.since,
    markoutDays: cost.days,
    fillsSince: bots.since,
    estimate,
  };
}

/** Phí của mô hình (bps): maker SoDEX của market (thiếu thì phí cơ bản) + builder fee Market Making mặc định. */
const estimateFeesBps = (makerFee: string | undefined): Decimal =>
  perpsMakerFeeBps(makerFee).add(mmBuilderFeeBps());

/** Tick size và phí maker của perp từ SoDEX; không có market đó hoặc SoDEX lỗi → null (cả dòng ước tính là n/a). */
async function marketInfo(
  deps: Deps,
  market: string,
): Promise<{ tickSize: string; makerFee: string | undefined } | null> {
  const symbols = await deps.rest.getPerpsSymbols().catch(() => null);
  const s = symbols?.find((x) => x.name === market);
  return s === undefined ? null : { tickSize: s.tickSize, makerFee: s.makerFee };
}

function emptyHour(): Omit<MarketHoursHour, "hour"> {
  return {
    volatility: {
      medianBp: null,
      p90Bp: null,
      ratio: null,
      hotPct: null,
      fiveMin: Array.from({ length: 12 }, () => null),
      swingBp: null,
      estCostPerMillion: null,
    },
    cost: { markoutBp: null, spreadTicks: null },
    bots: { costPerMillion: null, volume: null, fees: null, botHours: 0, thin: false },
  };
}
const emptyHours = (): MarketHoursHour[] =>
  Array.from({ length: 24 }, (_, hour) => ({ hour, ...emptyHour() }));

/** Lấy mảng của khoá, chưa có thì tạo (push tại chỗ, không chép lại mảng mỗi dòng). */
function listOf<K, V>(m: Map<K, V[]>, k: K): V[] {
  let xs = m.get(k);
  if (xs === undefined) {
    xs = [];
    m.set(k, xs);
  }
  return xs;
}

const str = (v: Decimal | null, dp = 2): string | null =>
  v === null ? null : v.toDecimalPlaces(dp).toString();

/** Market để chọn: market có bot Market Making / Volume Builder thật, cộng market có dữ liệu khối 2 trong kỳ. */
async function marketList(db: Db, from: Date): Promise<string[]> {
  const r = await db.execute(sql`
    select market from bots
      where strategy in (${Strategy.volumeMaker}, ${Strategy.volumeFarm}) and mode = 'live'
    union
    select distinct market from mm_market_hourly where hour >= ${from}
    order by 1`);
  return rowsOf<{ market: string }>(r).map((x) => x.market);
}

/**
 * Khối 1: range 1 phút theo ngày / giờ / bước 5 phút địa phương. Kèm dao động 1 phút của mỗi giờ (trung vị qua các
 * ngày của `swingBps` trên giá đóng theo thứ tự thời gian) và giá đóng mới nhất, cho dòng ước tính của mô hình.
 */
async function volatility(db: Db, market: string, from: Date, tz: string) {
  const r = await db.execute(sql`
    select to_char(ts at time zone ${tz}, 'YYYY-MM-DD') as d,
           extract(hour from ts at time zone ${tz})::int as h,
           (extract(minute from ts at time zone ${tz})::int / 5) as m5,
           high::text as high, low::text as low, close::text as close
      from candles_1m
      where market = ${market} and ts >= ${from}
      order by ts`);
  const [first] = rowsOf<{ since: unknown }>(
    await db.execute(sql`select min(ts) as since from candles_1m where market = ${market}`),
  );
  const byDayHour = new Map<string, Decimal[]>();
  const byDay = new Map<string, Decimal[]>();
  const byHour = Array.from({ length: 24 }, () => [] as Decimal[]);
  const byFive = Array.from({ length: 24 }, () =>
    Array.from({ length: 12 }, () => [] as Decimal[]),
  );
  // Giá đóng theo (ngày, giờ), theo thứ tự thời gian (truy vấn đã order by ts).
  const closes = new Map<string, string[]>();
  let lastClose: string | null = null;
  for (const x of rowsOf<{
    d: string;
    h: number;
    m5: number;
    high: string;
    low: string;
    close: string;
  }>(r)) {
    listOf(closes, `${x.d}|${String(x.h)}`).push(x.close);
    lastClose = x.close;
    const v = minuteRangeBp(x.high, x.low);
    if (v === null) continue;
    const k = `${x.d}|${String(x.h)}`;
    listOf(byDayHour, k).push(v);
    listOf(byDay, x.d).push(v);
    byHour[x.h]?.push(v);
    byFive[x.h]?.[x.m5]?.push(v);
  }
  const dayMed = new Map([...byDay].map(([d, xs]) => [d, quantile(xs, 0.5)]));
  const ratioOf = (d: string, h: number): Decimal | null => {
    const hm = quantile(byDayHour.get(`${d}|${String(h)}`) ?? [], 0.5);
    const dm = dayMed.get(d) ?? null;
    return hm === null || !dm?.gt(0) ? null : hm.div(dm);
  };
  const dates = [...byDay.keys()].sort();
  const heatmap = dates.map((d) => ({
    date: d,
    cells: Array.from({ length: 24 }, (_, h) => ({
      ratio: str(ratioOf(d, h)),
      medianBp: str(quantile(byDayHour.get(`${d}|${String(h)}`) ?? [], 0.5)),
    })),
  }));
  const hours = Array.from({ length: 24 }, (_, h) => {
    const ratios = dates.map((d) => ratioOf(d, h)).filter((x): x is Decimal => x !== null);
    const hot = ratios.filter((x) => x.gt(MARKET_HOURS_HOT_RATIO)).length;
    return {
      out: {
        medianBp: str(quantile(byHour[h] ?? [], 0.5)),
        p90Bp: str(quantile(byHour[h] ?? [], 0.9)),
        ratio: str(quantile(ratios, 0.5)),
        hotPct: ratios.length === 0 ? null : Math.round((hot / ratios.length) * 100),
        fiveMin: (byFive[h] ?? []).map((xs) => str(quantile(xs, 0.5))),
      },
      swing: medianSwingBps(dates.map((d) => closes.get(`${d}|${String(h)}`) ?? [])),
    };
  });
  return { hours, heatmap, since: iso(first?.since), lastClose };
}

/** Khối 2: markout 30 s phía maker và spread theo giờ địa phương (dòng giờ UTC của mm_market_hourly). */
async function makerCost(db: Db, market: string, from: Date, tz: string) {
  const r = await db.execute(sql`
    select to_char(hour at time zone ${tz}, 'YYYY-MM-DD') as d,
           extract(hour from hour at time zone ${tz})::int as h,
           notional::text as notional, markout_notional::text as markout, spread_ticks as spread
      from mm_market_hourly
      where market = ${market} and hour >= ${from}`);
  const [first] = rowsOf<{ since: unknown }>(
    await db.execute(sql`select min(hour) as since from mm_market_hourly where market = ${market}`),
  );
  const markouts = Array.from({ length: 24 }, () => [] as Decimal[]);
  const spreads = Array.from({ length: 24 }, (): Record<string, number> => ({}));
  const days = new Set<string>();
  for (const x of rowsOf<{
    d: string;
    h: number;
    notional: string;
    markout: string;
    spread: Record<string, number>;
  }>(r)) {
    days.add(x.d);
    const n = dec(x.notional);
    if (n.gt(0)) markouts[x.h]?.push(dec(x.markout).div(n));
    const hist = spreads[x.h];
    if (hist !== undefined)
      for (const [k, c] of Object.entries(x.spread)) hist[k] = (hist[k] ?? 0) + c;
  }
  const hours = Array.from({ length: 24 }, (_, h) => ({
    markoutBp: str(quantile(markouts[h] ?? [], 0.5)),
    spreadTicks: medianTicks(spreads[h] ?? {}),
  }));
  return { hours, since: iso(first?.since), days: days.size };
}

/**
 * Khối 3: fill thật của bot Market Making / Volume Builder tiền thật theo giờ địa phương. `userId` có thì chỉ bot của
 * user đó (bản public sau này); không có thì mọi user (bản team). Bot-hour = cặp (bot, giờ) có ít nhất một lệnh được
 * tạo trong giờ đó (DevOps chốt).
 */
export async function botHours(
  db: Db,
  q: { market: string; from: Date; tz: string; strategies: string[]; userId?: string },
) {
  const own = q.userId === undefined ? sql`true` : sql`b.user_id = ${q.userId}`;
  const strategies = sql.join(
    q.strategies.map((s) => sql`${s}`),
    sql`, `,
  );
  // Chặn lệnh tạo trước kỳ quá 1 ngày để dùng orders_bot_idx: fill của lệnh nằm chờ hơn 1 ngày trước kỳ không được
  // tính (ghi trong DEC-283).
  const fills = await db.execute(sql`
    select extract(hour from f.filled_at at time zone ${q.tz})::int as h,
           o.side as side, f.price::text as price, f.size::text as size, f.fee::text as fee,
           c.close::text as ref
      from bots b
      join orders o on o.bot_id = b.id and o.created_at >= ${new Date(q.from.getTime() - DAY_MS)}
      join fills f on f.order_id = o.id and f.filled_at >= ${q.from}
      left join candles_1m c
        on c.market = b.market and c.ts = date_trunc('minute', f.filled_at + interval '60 seconds')
      where b.market = ${q.market} and b.mode = 'live' and b.strategy in (${strategies}) and ${own}`);
  const active = await db.execute(sql`
    select extract(hour from o.created_at at time zone ${q.tz})::int as h,
           count(distinct (o.bot_id, date_trunc('hour', o.created_at at time zone ${q.tz})))::int as n
      from bots b
      join orders o on o.bot_id = b.id and o.created_at >= ${q.from}
      where b.market = ${q.market} and b.mode = 'live' and b.strategy in (${strategies}) and ${own}
      group by 1`);
  // Fill sớm nhất, chính xác mà không quét hết lệnh: với mỗi bot, lấy lệnh tạo sớm nhất có fill (đi theo
  // orders_bot_idx (bot_id, created_at), LIMIT 1) → t1 và fill đầu của nó f1. Fill sớm hơn f1 (nếu có) thuộc lệnh tạo
  // trong [t1, f1], nên chỉ cần quét đoạn index đó. Planner ước lượng đoạn [t1, f1] quá rộng nên tổng cost vượt
  // jit_above_cost và JIT tốn ~300 ms cho truy vấn chỉ vài ms: tắt JIT trong transaction riêng của truy vấn này.
  const [first] = await db.transaction(async (tx) => {
    await tx.execute(sql`set local jit = off`);
    return rowsOf<{ since: unknown }>(
      await tx.execute(sql`
      with first as (
        select b.id as bot_id, o1.created_at as t1,
               (select min(f.filled_at) from fills f where f.order_id = o1.id) as f1
          from bots b
          cross join lateral (
            select o.id, o.created_at from orders o
              where o.bot_id = b.id and exists (select 1 from fills f where f.order_id = o.id)
              order by o.created_at
              limit 1) o1
          where b.market = ${q.market} and b.mode = 'live' and b.strategy in (${strategies}) and ${own})
      select min((select min(f.filled_at) from fills f where f.order_id = o.id)) as since
        from first x
        join orders o on o.bot_id = x.bot_id and o.created_at >= x.t1 and o.created_at <= x.f1`),
    );
  });
  const byHour = Array.from({ length: 24 }, () => [] as CostFill[]);
  for (const x of rowsOf<{
    h: number;
    side: "buy" | "sell";
    price: string;
    size: string;
    fee: string;
    ref: string | null;
  }>(fills))
    byHour[x.h]?.push({ side: x.side, price: x.price, size: x.size, fee: x.fee, ref: x.ref });
  const counts = new Map(rowsOf<{ h: number; n: number }>(active).map((x) => [x.h, x.n]));
  const hours = Array.from({ length: 24 }, (_, h) => {
    const fs = byHour[h] ?? [];
    const n = counts.get(h) ?? 0;
    if (fs.length === 0)
      return {
        costPerMillion: null,
        volume: null,
        fees: null,
        botHours: n,
        thin: n > 0 && n < MARKET_HOURS_THIN_BOT_HOURS,
      };
    const c = fillCostPerMillion(fs);
    return {
      costPerMillion: str(c.costPerMillion),
      volume: str(c.volume),
      fees: str(c.fees, 4),
      botHours: n,
      thin: n < MARKET_HOURS_THIN_BOT_HOURS,
    };
  });
  return { hours, since: iso(first?.since) };
}

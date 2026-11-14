import { bots, candles1m, fills, mid1s, mmMarketHourly, mmModelCoefs, orders } from "@drift/db";
import {
  AppError,
  avgMarkout,
  blendPnlBps,
  capacityPerDay,
  dec,
  Decimal,
  ErrorCode,
  medianMidMove,
  medianTicks,
  MM_MIN_ACTIVE_MINUTES,
  MM_MIN_CANDLE_MINUTES,
  MM_MIN_CAPACITY,
  MM_MODEL_SEED,
  modelPnlBps,
  rankMmMarkets,
  roundTrips,
  SODEX_BASE_FEE_PCT,
  Strategy,
  swingBps,
  windowPnl,
  type MarkoutFill,
  type MidPoint,
  type MmMarketCost,
  type MmMarketCosts,
  type MmMarkout,
} from "@drift/shared";
import { and, asc, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";

import { builderFeesOf } from "../account/builder-fees";

import { ownBot, type BotDeps } from "./service";

// Market Making: chi phí / $1M theo market (DEC-TBD-mm-cost-v1, thay phần xếp hạng của DEC-227) và Price PnL đến từ
// đâu (D2, DEC-227). Số quá khứ 24 giờ, không dự báo; thiếu dữ liệu → null ("not enough data"), không bao giờ 0.
// - Chi phí ước tính cho bot của mình: PnL giá = a × bước − k × dao động 1 phút (chặn ≤ 0), hệ số mới nhất trong
//   `mm_model_coefs` (scheduler fit hằng ngày) hoặc hệ số khởi đầu. Có bot của chính người xem ở market đó thì trộn với
//   số thật theo số vòng đóng. Markout công khai (`mm_market_hourly`) chỉ để đối chiếu.
// - Phần dữ liệu thị trường cache 5 phút (chung mọi người); phần của người xem (bot, builder fee) tính mỗi lần gọi.
// - D2 dùng fill thật của chính bot 24 giờ: markout 5 / 30 / 60 s, vòng mua bán đóng lỗ.

const DAY = 86_400_000;
const CACHE_MS = 5 * 60_000;
const PER_MILLION_FROM_BPS = 100; // $1M × bps / 10.000

interface MarketRow {
  market: string;
  stepBps: Decimal | null;
  spreadTicks: number | null;
  swingBps: Decimal | null;
  volume24h: Decimal | null;
  capacityPerDay: Decimal | null;
  candleMinutes24h: number;
  activeMinutes24h: number;
  hoursWithData: number;
  trades24h: number;
  notional24h: Decimal;
  publicPricePnlPerMillion: Decimal | null;
  /** PnL giá mô hình (bps); null khi thiếu dữ liệu đầu vào. */
  modelBps: Decimal | null;
  lastClose: string | null;
  makerPerMillion: Decimal;
}
interface MarketPart {
  at: number;
  updatedAt: number | null;
  model: { version: number; a: string; k: string };
  rows: MarketRow[];
}
let cache: MarketPart | null = null;

const fmt = (d: Decimal | null, dp = 2) => (d === null ? null : d.toDecimalPlaces(dp).toString());

/** Hệ số mô hình mới nhất, hoặc hệ số khởi đầu (version 0). */
async function latestModel(deps: BotDeps): Promise<MarketPart["model"]> {
  const [row] = await deps.db
    .select({ version: mmModelCoefs.version, a: mmModelCoefs.a, k: mmModelCoefs.k })
    .from(mmModelCoefs)
    .orderBy(desc(mmModelCoefs.version))
    .limit(1);
  return row ?? { ...MM_MODEL_SEED };
}

async function botFillsWithMids(
  deps: BotDeps,
  where: ReturnType<typeof and>,
  since: Date,
): Promise<{ byMarket: Map<string, MarkoutFill[]>; mids: Map<string, MidPoint[]> }> {
  const byMarket = await botFills(deps, where, since);
  const mids = new Map<string, MidPoint[]>();
  if (byMarket.size > 0) {
    const m = await deps.db
      .select({ market: mid1s.market, ts: mid1s.ts, mid: mid1s.mid })
      .from(mid1s)
      .where(and(inArray(mid1s.market, [...byMarket.keys()]), gte(mid1s.ts, since)))
      .orderBy(asc(mid1s.ts));
    for (const r of m) {
      const list = mids.get(r.market) ?? [];
      list.push({ at: r.ts.getTime(), mid: r.mid });
      mids.set(r.market, list);
    }
  }
  return { byMarket, mids };
}

async function botFills(
  deps: BotDeps,
  where: ReturnType<typeof and>,
  since: Date,
): Promise<Map<string, MarkoutFill[]>> {
  const rows = await deps.db
    .select({
      market: orders.market,
      side: orders.side,
      price: fills.price,
      size: fills.size,
      at: fills.filledAt,
    })
    .from(fills)
    .innerJoin(orders, eq(orders.id, fills.orderId))
    .innerJoin(bots, eq(bots.id, orders.botId))
    .where(and(where, gte(fills.filledAt, since)))
    .orderBy(asc(fills.filledAt))
    .limit(20_000);
  const byMarket = new Map<string, MarkoutFill[]>();
  for (const r of rows) {
    const list = byMarket.get(r.market) ?? [];
    list.push({ at: r.at.getTime(), side: r.side, price: r.price, size: r.size });
    byMarket.set(r.market, list);
  }
  return byMarket;
}

async function marketPart(deps: BotDeps): Promise<MarketPart> {
  const now = deps.now().getTime();
  if (cache !== null && now - cache.at < CACHE_MS) return cache;
  const since = new Date(now - DAY);
  const symbols = (await deps.rest.getPerpsSymbols()).filter((s) => s.status === "TRADING");
  const names = symbols.map((s) => s.name);
  const model = await latestModel(deps);
  const hourly = await deps.db
    .select()
    .from(mmMarketHourly)
    .where(gte(mmMarketHourly.hour, new Date(now - DAY)));
  const candles =
    names.length === 0
      ? []
      : await deps.db
          .select({
            market: candles1m.market,
            close: candles1m.close,
            volume: candles1m.volume,
          })
          .from(candles1m)
          .where(
            and(
              inArray(candles1m.market, names),
              gte(candles1m.ts, since),
              lte(candles1m.ts, new Date(now)),
            ),
          )
          .orderBy(asc(candles1m.market), asc(candles1m.ts));
  const byMarket = new Map<string, { close: string; volume: string }[]>();
  for (const c of candles) {
    const list = byMarket.get(c.market) ?? [];
    list.push(c);
    byMarket.set(c.market, list);
  }
  let updatedAt: number | null = null;
  const baseMaker = dec(SODEX_BASE_FEE_PCT.perps.maker).div(100);
  const rows = symbols.map((s): MarketRow => {
    const hs = hourly.filter((h) => h.market === s.name);
    for (const h of hs) updatedAt = Math.max(updatedAt ?? 0, h.updatedAt.getTime());
    const cs = byMarket.get(s.name) ?? [];
    const last = cs.at(-1);
    const mid = last === undefined ? null : dec(last.close);
    const notional = hs.reduce((a, h) => a.add(dec(h.notional)), new Decimal(0));
    const markout = hs.reduce((a, h) => a.add(dec(h.markoutNotional)), new Decimal(0));
    const hist: Record<string, number> = {};
    for (const h of hs)
      for (const [k, n] of Object.entries(h.spreadTicks as Record<string, number>))
        hist[k] = (hist[k] ?? 0) + n;
    const active = cs.filter((c) => dec(c.volume).gt(0)).length;
    // Dao động chỉ tin được khi đủ nến và ≥ 50% số phút có volume (nến phẳng làm dao động thấp giả).
    const enough = cs.length >= MM_MIN_CANDLE_MINUTES && active >= MM_MIN_ACTIVE_MINUTES;
    const swing = enough ? swingBps(cs.map((c) => c.close)) : null;
    const step = mid === null || mid.lte(0) ? null : dec(s.tickSize).div(mid).mul(10_000);
    const vol =
      cs.length === 0
        ? null
        : cs.reduce((a, c) => a.add(dec(c.close).mul(dec(c.volume))), new Decimal(0));
    return {
      market: s.name,
      stepBps: step,
      spreadTicks: medianTicks(hist),
      swingBps: swing,
      volume24h: vol,
      capacityPerDay: capacityPerDay(vol),
      candleMinutes24h: cs.length,
      activeMinutes24h: active,
      hoursWithData: hs.length,
      trades24h: hs.reduce((a, h) => a + h.trades, 0),
      notional24h: notional,
      publicPricePnlPerMillion: notional.gt(0)
        ? markout.div(notional).mul(PER_MILLION_FROM_BPS)
        : null,
      modelBps: step === null || swing === null ? null : modelPnlBps(step, swing, model.a, model.k),
      lastClose: last?.close ?? null,
      makerPerMillion: (s.makerFee === undefined ? baseMaker : dec(s.makerFee)).mul(1_000_000),
    };
  });
  cache = { at: now, updatedAt, model, rows };
  return cache;
}

/** Xếp hạng market cho bot Market Making của người xem, kèm tối đa 3 gợi ý (DEC-TBD-mm-cost-v1). */
export async function mmMarketCosts(deps: BotDeps, userId: string): Promise<MmMarketCosts> {
  const part = await marketPart(deps);
  const now = deps.now().getTime();
  const rate = (await builderFeesOf(deps.db, userId))[Strategy.volumeMaker] ?? 0;
  // Builder fee theo phần mười bp: 3 → 0,003% → 30 USD / $1M.
  const builder = new Decimal(rate).mul(10);
  const mine = await deps.db
    .selectDistinct({ market: bots.market })
    .from(bots)
    .where(
      and(
        eq(bots.userId, userId),
        sql`${bots.strategy} = ${Strategy.volumeMaker}`,
        inArray(bots.state, ["starting", "running", "resuming"]),
      ),
    );
  const running = new Set(mine.map((m) => m.market));
  // Chỉ bot của chính người xem (live) mới trộn vào số của người xem ("Your bots").
  const own = await botFills(
    deps,
    and(
      eq(bots.userId, userId),
      sql`${bots.strategy} = ${Strategy.volumeMaker}`,
      eq(bots.mode, "live"),
    ),
    new Date(now - DAY),
  );
  const base = dec(SODEX_BASE_FEE_PCT.perps.maker).div(100).mul(1_000_000);
  const rows = part.rows.map((r): MmMarketCost => {
    const ownFills = own.get(r.market) ?? [];
    const w = ownFills.length === 0 ? null : windowPnl(ownFills, r.lastClose);
    const rounds = w?.rounds ?? 0;
    const pnl = r.modelBps === null ? null : blendPnlBps(r.modelBps, w?.bps ?? null, rounds);
    const pnlPerMillion = pnl === null ? null : pnl.mul(PER_MILLION_FROM_BPS);
    return {
      market: r.market,
      stepBps: fmt(r.stepBps),
      spreadTicks: r.spreadTicks,
      swingBps: fmt(r.swingBps),
      volume24h: fmt(r.volume24h, 0),
      capacityPerDay: fmt(r.capacityPerDay, 0),
      tooLittleVolume: r.capacityPerDay?.lt(MM_MIN_CAPACITY) === true,
      candleMinutes24h: r.candleMinutes24h,
      activeMinutes24h: r.activeMinutes24h,
      hoursWithData: r.hoursWithData,
      trades24h: r.trades24h,
      notional24h: r.notional24h.toDecimalPlaces(0).toString(),
      publicPricePnlPerMillion: fmt(r.publicPricePnlPerMillion),
      pricePnlPerMillion: fmt(pnlPerMillion),
      source: pnl === null ? null : rounds > 0 && w?.bps != null ? "yours" : "model",
      yourRoundTrips: rounds,
      totalCostPerMillion:
        pnlPerMillion === null
          ? null
          : r.makerPerMillion.add(builder).sub(pnlPerMillion).toDecimalPlaces(2).toString(),
      yourBot: running.has(r.market),
    };
  });
  const { ranked, suggested } = rankMmMarkets(rows);
  return {
    asOf: new Date(now).toISOString(),
    updatedAt: part.updatedAt === null ? null : new Date(part.updatedAt).toISOString(),
    makerFeePerMillion: base.toDecimalPlaces(2).toString(),
    builderFeePerMillion: builder.toString(),
    modelVersion: part.model.version,
    model: { a: dec(part.model.a).toString(), k: dec(part.model.k).toString() },
    markets: ranked,
    suggested,
  };
}

/** Price PnL đến từ đâu (D2): fill thật của bot MM này trong 24 giờ. */
export async function mmMarkout(deps: BotDeps, userId: string, botId: string): Promise<MmMarkout> {
  const b = await ownBot(deps.db, userId, botId);
  if (b.strategy !== Strategy.volumeMaker)
    throw new AppError(ErrorCode.notFound, "Only for Market Making bots.");
  const now = deps.now().getTime();
  const { byMarket, mids } = await botFillsWithMids(
    deps,
    and(eq(bots.id, b.id)),
    new Date(now - DAY),
  );
  const list = byMarket.get(b.market) ?? [];
  const series = mids.get(b.market) ?? [];
  const symbol = (await deps.rest.getPerpsSymbols()).find((s) => s.name === b.market);
  const lastMid = series.at(-1);
  const step =
    symbol === undefined || lastMid === undefined || dec(lastMid.mid).lte(0)
      ? null
      : dec(symbol.tickSize).div(dec(lastMid.mid)).mul(10_000);
  const move30 = medianMidMove(list, series, 30_000);
  return {
    asOf: new Date(now).toISOString(),
    market: b.market,
    fills: list.length,
    markout: {
      s5: fmt(avgMarkout(list, series, 5_000)),
      s30: fmt(avgMarkout(list, series, 30_000)),
      s60: fmt(avgMarkout(list, series, 60_000)),
    },
    stepBps: fmt(step),
    roundTrips: roundTrips(list),
    inShort: step !== null && move30 !== null && step.lt(move30),
  };
}

/** Chỉ cho test: xoá cache phần dữ liệu thị trường. */
export function resetMmCostCache(): void {
  cache = null;
}

import { bots, candles1m, fills, mid1s, mmMarketHourly, orders } from "@drift/db";
import {
  AppError,
  avgMarkout,
  dec,
  Decimal,
  ErrorCode,
  medianMidMove,
  medianTicks,
  roundTrips,
  SODEX_BASE_FEE_PCT,
  Strategy,
  swingBps,
  type MarkoutFill,
  type MidPoint,
  type MmMarketCost,
  type MmMarketCosts,
  type MmMarkout,
} from "@drift/shared";
import { and, asc, eq, gte, inArray, lte, sql } from "drizzle-orm";

import { builderFeesOf } from "../account/builder-fees";

import { ownBot, type BotDeps } from "./service";

// Market Making: chi phí / $1M theo market (D1) và Price PnL đến từ đâu (D2), DEC-TBD-mm-cost. Số quá khứ 24 giờ, không
// dự báo; thiếu dữ liệu → null ("Not available"), không bao giờ 0.
// - D1 cộng `mm_market_hourly` của 24 giờ gần nhất (marketdata ghi từ WS SoDEX); market có bot MM DeskLabs chạy trong 24
//   giờ thì Price PnL lấy từ fill thật của các bot đó (markout 30 s với `mid_1s`). Phần dữ liệu thị trường cache 5 phút.
// - D2 dùng fill thật của chính bot 24 giờ: markout 5 / 30 / 60 s, vòng mua bán đóng lỗ.

const DAY = 86_400_000;
const CACHE_MS = 5 * 60_000;
const PER_MILLION_FROM_BPS = 100; // $1M × bps / 10.000

interface MarketPart {
  at: number;
  updatedAt: number | null;
  rows: Omit<MmMarketCost, "totalCostPerMillion" | "yourBot">[];
  makerFeePerMillion: Record<string, string>;
}
let cache: MarketPart | null = null;

const fmt = (d: Decimal | null, dp = 2) => (d === null ? null : d.toDecimalPlaces(dp).toString());

async function botFillsWithMids(
  deps: BotDeps,
  where: ReturnType<typeof and>,
  since: Date,
): Promise<{ byMarket: Map<string, MarkoutFill[]>; mids: Map<string, MidPoint[]> }> {
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

async function marketPart(deps: BotDeps): Promise<MarketPart> {
  const now = deps.now().getTime();
  if (cache !== null && now - cache.at < CACHE_MS) return cache;
  const since = new Date(now - DAY);
  const symbols = (await deps.rest.getPerpsSymbols()).filter((s) => s.status === "TRADING");
  const names = symbols.map((s) => s.name);
  const hourly = await deps.db
    .select()
    .from(mmMarketHourly)
    .where(gte(mmMarketHourly.hour, new Date(now - DAY - 3_600_000)));
  const candles =
    names.length === 0
      ? []
      : await deps.db
          .select({
            market: candles1m.market,
            ts: candles1m.ts,
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
          .orderBy(asc(candles1m.ts));
  // Bot MM của DeskLabs đã chạy trong 24 giờ: Price PnL từ fill thật (ưu tiên hơn giao dịch công khai).
  const botData = await botFillsWithMids(
    deps,
    and(
      sql`${bots.strategy} = ${Strategy.volumeMaker}`,
      eq(bots.mode, "live"),
      eq(fills.isMaker, true),
    ),
    since,
  );
  let updatedAt: number | null = null;
  const rows = symbols.map((s) => {
    const hs = hourly.filter((h) => h.market === s.name && h.hour.getTime() >= now - DAY);
    for (const h of hs) updatedAt = Math.max(updatedAt ?? 0, h.updatedAt.getTime());
    const cs = candles.filter((c) => c.market === s.name);
    const last = cs.at(-1);
    const mid = last === undefined ? null : dec(last.close);
    const notional = hs.reduce((a, h) => a.add(dec(h.notional)), new Decimal(0));
    const markout = hs.reduce((a, h) => a.add(dec(h.markoutNotional)), new Decimal(0));
    const hist: Record<string, number> = {};
    for (const h of hs)
      for (const [k, n] of Object.entries(h.spreadTicks as Record<string, number>))
        hist[k] = (hist[k] ?? 0) + n;
    const botFills = botData.byMarket.get(s.name);
    const botMarkout =
      botFills === undefined ? null : avgMarkout(botFills, botData.mids.get(s.name) ?? [], 30_000);
    const publicMarkout = notional.gt(0) ? markout.div(notional) : null;
    const bps = botMarkout ?? publicMarkout;
    const vol = cs.reduce((a, c) => a.add(dec(c.close).mul(dec(c.volume))), new Decimal(0));
    return {
      market: s.name,
      stepBps: mid === null || mid.lte(0) ? null : fmt(dec(s.tickSize).div(mid).mul(10_000)),
      spreadTicks: medianTicks(hist),
      swingBps: fmt(swingBps(cs.map((c) => c.close))),
      volume24h: cs.length === 0 ? null : fmt(vol, 0),
      pricePnlPerMillion: fmt(bps === null ? null : bps.mul(PER_MILLION_FROM_BPS)),
      pricePnlSource:
        botMarkout !== null
          ? ("bots" as const)
          : publicMarkout !== null
            ? ("public" as const)
            : null,
    };
  });
  const makerFeePerMillion = Object.fromEntries(
    symbols.map((s) => [
      s.name,
      (s.makerFee === undefined ? dec(SODEX_BASE_FEE_PCT.perps.maker).div(100) : dec(s.makerFee))
        .mul(1_000_000)
        .toDecimalPlaces(2)
        .toString(),
    ]),
  );
  cache = { at: now, updatedAt, rows, makerFeePerMillion };
  return cache;
}

/** Bảng xếp hạng market cho bước chọn market của bot Market Making (D1). */
export async function mmMarketCosts(deps: BotDeps, userId: string): Promise<MmMarketCosts> {
  const part = await marketPart(deps);
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
  const yours = new Set(mine.map((m) => m.market));
  const base = dec(SODEX_BASE_FEE_PCT.perps.maker).div(100).mul(1_000_000);
  return {
    asOf: deps.now().toISOString(),
    updatedAt: part.updatedAt === null ? null : new Date(part.updatedAt).toISOString(),
    makerFeePerMillion: base.toDecimalPlaces(2).toString(),
    builderFeePerMillion: builder.toString(),
    markets: part.rows.map((r) => {
      const maker = dec(part.makerFeePerMillion[r.market] ?? base);
      return {
        ...r,
        totalCostPerMillion:
          r.pricePnlPerMillion === null
            ? null
            : maker.add(builder).sub(dec(r.pricePnlPerMillion)).toDecimalPlaces(2).toString(),
        yourBot: yours.has(r.market),
      };
    }),
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

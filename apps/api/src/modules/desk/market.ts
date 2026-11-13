import { bots, type Db } from "@drift/db";
import {
  BotState,
  DESK_MARKET_CONFIG,
  marketFacts,
  marketsForFacts,
  marketToday,
  type DeskMarketView,
  type DeskAiFact,
  type MarketCandle,
} from "@drift/shared";
import type { SodexRestClient } from "@drift/sodex";
import { and, eq, ne } from "drizzle-orm";

// Nguồn dữ liệu "Market today" cho Desk AI (DEC-211): 24 nến 1h SoDEX + giá hiện tại (mark với perps,
// giá gần nhất của marketdata với spot), giống Watchlist. Cache 60 s theo market; SoDEX lỗi thì không có fact.

type Engine = "spot" | "perps";

export interface DeskMarketSource {
  /** Nến 1h 24 giờ qua, giá hiện tại và quote coin; lỗi đọc thì phần đó rỗng / null. */
  read(
    engine: Engine,
    market: string,
  ): Promise<{
    candles: MarketCandle[];
    price: string | null;
    quote: string | null;
  }>;
}

export function sodexMarketSource(deps: {
  rest: Pick<SodexRestClient, "getKlines" | "getMarkPrices" | "getPerpsSymbols" | "getSpotSymbols">;
  prices: (markets: readonly string[]) => Promise<Record<string, string>>;
  now: () => Date;
}): DeskMarketSource {
  const cache = new Map<
    string,
    { at: number; value: Awaited<ReturnType<DeskMarketSource["read"]>> }
  >();
  const safe = async <T>(p: Promise<T>, fallback: T): Promise<T> => {
    try {
      return await p;
    } catch {
      return fallback;
    }
  };
  return {
    async read(engine, market) {
      const now = deps.now().getTime();
      const key = `${engine}:${market}`;
      const hit = cache.get(key);
      if (hit !== undefined && now - hit.at < DESK_MARKET_CONFIG.cacheMs) return hit.value;
      const [klines, price, symbols] = await Promise.all([
        safe(
          deps.rest.getKlines(engine, market, {
            interval: "1h",
            startTime: now - DESK_MARKET_CONFIG.hours * 3_600_000,
            endTime: now,
            limit: DESK_MARKET_CONFIG.hours,
          }),
          [],
        ),
        engine === "perps"
          ? safe(
              deps.rest
                .getMarkPrices()
                .then((ms) => ms.find((m) => m.symbol === market)?.markPrice ?? null),
              null,
            )
          : safe(
              deps.prices([market]).then((p) => p[market] ?? null),
              null,
            ),
        safe<{ name: string; quoteCoin?: string | undefined }[]>(
          engine === "perps" ? deps.rest.getPerpsSymbols() : deps.rest.getSpotSymbols(),
          [],
        ),
      ]);
      const value = {
        candles: klines.map((k) => ({ t: k.t, o: k.o, h: k.h, l: k.l })),
        price,
        quote: symbols.find((s) => s.name === market)?.quoteCoin ?? null,
      };
      cache.set(key, { at: now, value });
      return value;
    },
  };
}

/** Fact thị trường cho các market mà bot chưa archive của user đang dùng (tối đa 5, bot đang chạy trước). */
export async function deskMarketFacts(
  db: Db,
  source: DeskMarketSource | null | undefined,
  userId: string,
): Promise<DeskAiFact[]> {
  if (source == null) return [];
  const rows = await db
    .select({ market: bots.market, engine: bots.engine, state: bots.state })
    .from(bots)
    .where(and(eq(bots.userId, userId), ne(bots.state, BotState.archived)));
  const engineOf = new Map(
    rows.map((r) => [r.market, r.engine === "spot" ? "spot" : "perps"] as const),
  );
  const markets = marketsForFacts(rows);
  const out = await Promise.all(
    markets.map(async (market) => {
      const d = await source.read(engineOf.get(market) ?? "perps", market);
      return marketFacts({ market, ...d });
    }),
  );
  return out.flat();
}

/** Thẻ "Market today": cùng fact thị trường, thêm chiến lược bot của user trên từng market để ghép vế liên hệ. */
export async function deskMarketCard(
  db: Db,
  source: DeskMarketSource | null | undefined,
  userId: string,
): Promise<DeskMarketView> {
  const [facts, rows] = await Promise.all([
    deskMarketFacts(db, source, userId).catch((): DeskAiFact[] => []),
    db
      .select({ market: bots.market, strategy: bots.strategy })
      .from(bots)
      .where(and(eq(bots.userId, userId), ne(bots.state, BotState.archived))),
  ]);
  const byMarket = new Map<string, string[]>();
  for (const r of rows) byMarket.set(r.market, [...(byMarket.get(r.market) ?? []), r.strategy]);
  return { items: marketToday(facts, byMarket) };
}

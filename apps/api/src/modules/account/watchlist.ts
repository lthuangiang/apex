import { goals, users, watchlistItems, type Db } from "@drift/db";
import { AppError, ErrorCode, type WatchlistEntry } from "@drift/shared";
import type { SodexRestClient } from "@drift/sodex";
import { and, asc, eq, isNull } from "drizzle-orm";

// Watchlist của Overview (UI_REVIEW M2, DEC-74). Lần đọc đầu seed từ `goals.markets` (4 cái đầu, perps
// `<X>-USD`, như trước); sau đó độc lập với goals, kể cả khi người dùng bỏ hết market.

export interface WatchlistDeps {
  db: Db;
  rest: Pick<SodexRestClient, "getSpotSymbols" | "getPerpsSymbols">;
}

const DEFAULT_SEED = ["BTC", "ETH"];

/** Mọi market SoDEX đang liệt kê (như `GET /api/v1/markets`), theo tên → engine. */
async function knownMarkets(deps: WatchlistDeps): Promise<Map<string, "spot" | "perps">> {
  const [spot, perps] = await Promise.all([
    deps.rest.getSpotSymbols(),
    deps.rest.getPerpsSymbols(),
  ]);
  return new Map<string, "spot" | "perps">([
    ...spot.map((m) => [m.name, "spot"] as const),
    ...perps.map((m) => [m.name, "perps"] as const),
  ]);
}

async function rows(db: Pick<Db, "select">, userId: string): Promise<WatchlistEntry[]> {
  return db
    .select({ market: watchlistItems.market, engine: watchlistItems.engine })
    .from(watchlistItems)
    .where(eq(watchlistItems.userId, userId))
    .orderBy(asc(watchlistItems.position));
}

export async function getWatchlist(deps: WatchlistDeps, userId: string): Promise<WatchlistEntry[]> {
  const current = await rows(deps.db, userId);
  if (current.length > 0) return current;
  const [g] = await deps.db
    .select({ markets: goals.markets })
    .from(goals)
    .where(eq(goals.userId, userId))
    .limit(1);
  let seed = (g?.markets ?? DEFAULT_SEED).slice(0, 4).map((x) => `${x}-USD`);
  // Bỏ market SoDEX không có; không đọc được danh sách thì seed nguyên như trước.
  const known = await knownMarkets(deps).catch(() => null);
  if (known !== null) seed = seed.filter((m) => known.get(m) === "perps");
  return deps.db.transaction(async (tx) => {
    // Chỉ một request thắng việc seed; đã seed rồi (kể cả đã bỏ hết) thì không seed lại.
    const won = await tx
      .update(users)
      .set({ watchlistSeededAt: new Date() })
      .where(and(eq(users.id, userId), isNull(users.watchlistSeededAt)))
      .returning({ id: users.id });
    if (won.length === 0) return rows(tx, userId);
    if (seed.length > 0) {
      await tx
        .insert(watchlistItems)
        .values(
          seed.map((market, i) => ({ userId, market, engine: "perps" as const, position: i })),
        )
        .onConflictDoNothing();
    }
    return rows(tx, userId);
  });
}

/** Thay toàn bộ danh sách theo thứ tự gửi lên. Body đã qua `watchlistBodySchema` (≤ 8, không trùng). */
export async function setWatchlist(
  deps: WatchlistDeps,
  userId: string,
  items: readonly WatchlistEntry[],
): Promise<WatchlistEntry[]> {
  let known: Map<string, "spot" | "perps">;
  try {
    known = await knownMarkets(deps);
  } catch {
    throw new AppError(ErrorCode.sodexUnavailable, "Can't check markets on SoDEX right now.");
  }
  const bad = items.filter((x) => known.get(x.market) !== x.engine).map((x) => x.market);
  if (bad.length > 0) {
    throw new AppError(ErrorCode.validationFailed, "Unknown market.", {
      fieldErrors: { items: bad.map((m) => `Unknown market: ${m}`) },
    });
  }
  return deps.db.transaction(async (tx) => {
    await tx.delete(watchlistItems).where(eq(watchlistItems.userId, userId));
    if (items.length > 0) {
      await tx
        .insert(watchlistItems)
        .values(items.map((x, i) => ({ userId, market: x.market, engine: x.engine, position: i })));
    }
    await tx.update(users).set({ watchlistSeededAt: new Date() }).where(eq(users.id, userId));
    return rows(tx, userId);
  });
}

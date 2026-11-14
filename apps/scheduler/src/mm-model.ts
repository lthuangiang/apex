import {
  bots,
  botVersions,
  candles1m,
  fills,
  mmModelCoefs,
  orders,
  users,
  type Db,
} from "@drift/db";
import {
  dec,
  fitModel,
  MM_FIT_MIN_ROUNDS,
  MM_MIN_ACTIVE_MINUTES,
  MM_MODEL_SEED,
  Strategy,
  swingBps,
  UserRole,
  windowPnl,
  type FitPoint,
  type MarkoutFill,
} from "@drift/shared";
import { and, asc, eq, gte, inArray, lt, sql } from "drizzle-orm";

// Fit hệ số mô hình chi phí Market Making mỗi ngày (DEC-228). Mỗi (bot, market, ngày UTC) có ≥ 50 vòng đóng
// là một điểm: y = PnL giá (gồm phần chưa chốt) bps trên volume, x = (bước, dao động 1 phút) của market trong ngày.
// Chỉ bot live quoteLevel 0. Bot của team luôn được dùng; bot của user khác chỉ dùng khi có ≥ 3 tài khoản như vậy
// (gộp, không hiện riêng ở đâu). Không có điểm nào → không ghi gì (API giữ hệ số cũ / hệ số khởi đầu).

const DAY = 86_400_000;
/** Bot của user (không phải team) chỉ vào fit khi có ít nhất ngần này tài khoản. */
export const MM_FIT_MIN_USER_ACCOUNTS = 3;

export interface MmFitResult {
  status: "done" | "skipped" | "no-points";
  day: string;
  points: number;
  a?: string;
  k?: string;
}

const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Fit cho ngày UTC hôm qua (đã trọn ngày), một lần mỗi ngày. */
export async function fitMmModelDaily(
  db: Db,
  tickSizes: ReadonlyMap<string, string>,
  now: number,
): Promise<MmFitResult> {
  const end = now - (now % DAY);
  const start = end - DAY;
  const day = isoDay(start);
  const [done] = await db
    .select({ v: mmModelCoefs.version })
    .from(mmModelCoefs)
    .where(eq(mmModelCoefs.day, day))
    .limit(1);
  if (done !== undefined) return { status: "skipped", day, points: 0 };

  const rows = await db
    .select({
      botId: bots.id,
      userId: bots.userId,
      role: users.role,
      config: botVersions.config,
      market: orders.market,
      side: orders.side,
      price: fills.price,
      size: fills.size,
      at: fills.filledAt,
    })
    .from(fills)
    .innerJoin(orders, eq(orders.id, fills.orderId))
    .innerJoin(bots, eq(bots.id, orders.botId))
    .innerJoin(users, eq(users.id, bots.userId))
    .innerJoin(botVersions, eq(botVersions.id, bots.activeVersionId))
    .where(
      and(
        sql`${bots.strategy} = ${Strategy.volumeMaker}`,
        eq(bots.mode, "live"),
        gte(fills.filledAt, new Date(start)),
        lt(fills.filledAt, new Date(end)),
      ),
    )
    .orderBy(asc(fills.filledAt));

  interface Group {
    userId: string;
    team: boolean;
    market: string;
    fills: MarkoutFill[];
  }
  const groups = new Map<string, Group>();
  for (const r of rows) {
    if ((r.config as { quoteLevel?: unknown }).quoteLevel !== 0) continue;
    const key = `${r.botId}|${r.market}`;
    const g = groups.get(key) ?? {
      userId: r.userId,
      team: r.role === UserRole.team,
      market: r.market,
      fills: [],
    };
    g.fills.push({ at: r.at.getTime(), side: r.side, price: r.price, size: r.size });
    groups.set(key, g);
  }
  const userAccounts = new Set([...groups.values()].filter((g) => !g.team).map((g) => g.userId));
  const useUsers = userAccounts.size >= MM_FIT_MIN_USER_ACCOUNTS;

  const markets = [...new Set([...groups.values()].map((g) => g.market))];
  const candles =
    markets.length === 0
      ? []
      : await db
          .select({
            market: candles1m.market,
            close: candles1m.close,
            volume: candles1m.volume,
          })
          .from(candles1m)
          .where(
            and(
              inArray(candles1m.market, markets),
              gte(candles1m.ts, new Date(start)),
              lt(candles1m.ts, new Date(end)),
            ),
          )
          .orderBy(asc(candles1m.market), asc(candles1m.ts));
  const byMarket = new Map<string, { close: string; volume: string }[]>();
  for (const c of candles) byMarket.set(c.market, [...(byMarket.get(c.market) ?? []), c]);

  const points: FitPoint[] = [];
  for (const g of groups.values()) {
    if (!g.team && !useUsers) continue;
    const cs = byMarket.get(g.market) ?? [];
    const tick = tickSizes.get(g.market);
    const last = cs.at(-1);
    const active = cs.filter((c) => dec(c.volume).gt(0)).length;
    if (tick === undefined || last === undefined || active < MM_MIN_ACTIVE_MINUTES) continue;
    const w = windowPnl(g.fills, last.close);
    if (w.rounds < MM_FIT_MIN_ROUNDS || w.bps === null) continue;
    const swing = swingBps(cs.map((c) => c.close));
    const avg = cs.reduce((s, c) => s.add(c.close), dec("0")).div(cs.length);
    if (swing === null || avg.lte(0)) continue;
    points.push({
      stepBps: dec(tick).div(avg).mul(10_000),
      swingBps: swing,
      pnlBps: w.bps,
      weight: w.volume,
    });
  }
  const fit = fitModel(points, MM_MODEL_SEED.a);
  if (fit === null) return { status: "no-points", day, points: 0 };
  const a = fit.a.toDecimalPlaces(10).toString();
  const k = fit.k.toDecimalPlaces(10).toString();
  await db.insert(mmModelCoefs).values({ a, k, points: fit.points, day });
  return { status: "done", day, points: fit.points, a, k };
}

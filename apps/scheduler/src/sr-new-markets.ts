import { outbox, type Db } from "@drift/db";
import {
  NEWS_ASSET_MAP_VERSION,
  SR_NEW_MARKET_ALERT_MAX,
  STOCK_MARKET_SET,
  type TeamOpsEvent,
} from "@drift/shared";

// Signal research (#311): SoDEX không cho biết market là cổ phiếu hay crypto (DEC-330), nên `STOCK_MARKET_SET` là danh
// sách tay. Mỗi lần scheduler đọc danh sách perps (`loadPerps`, đã ghi `sr:markets`), so với tập market đã từng thấy
// (Redis set, AOF). Market mới không nằm trong `STOCK_MARKET_SET` → báo team qua `jobs.team_ops` (nhóm teamOps) để
// phân loại và tăng `NEWS_ASSET_MAP_VERSION`. Mỗi market báo đúng một lần (SADD là lời "nhận"); lần đầu chưa có tập (hoặc
// Redis mất dữ liệu) thì ghi toàn bộ danh sách hiện tại làm mốc, không báo. Không gọi SoDEX, không đụng giao dịch.

/** Tập mọi market SoDEX đã từng thấy (đã phân loại hoặc đã báo). */
export const SR_MARKETS_SEEN_KEY = "sr:markets:seen";

export interface SeenStore {
  /** Tập đã có chưa (false = lần đầu hoặc Redis mất dữ liệu). */
  exists(): Promise<boolean>;
  /** Thêm market; trả các market vừa được thêm (chưa có trước đó). */
  add(markets: readonly string[]): Promise<string[]>;
  /** Bỏ market (ghi outbox lỗi: lần sau báo lại). */
  remove(markets: readonly string[]): Promise<void>;
}

interface RedisLike {
  exists(key: string): Promise<number>;
  srem(key: string, ...members: string[]): Promise<number>;
  multi(): {
    sadd(key: string, member: string): unknown;
    exec(): Promise<[Error | null, unknown][] | null>;
  };
}

export function redisSeenStore(redis: RedisLike, key = SR_MARKETS_SEEN_KEY): SeenStore {
  return {
    async exists() {
      return (await redis.exists(key)) > 0;
    },
    async add(markets) {
      if (markets.length === 0) return [];
      // Mỗi market một SADD trong cùng MULTI: kết quả 1 = vừa thêm, nên hai lượt chạy chồng không báo trùng.
      const m = redis.multi();
      for (const name of markets) m.sadd(key, name);
      const res = (await m.exec()) ?? [];
      return markets.filter((_, i) => {
        const r = res[i];
        if (r === undefined) return false;
        if (r[0] !== null) throw r[0];
        return r[1] === 1;
      });
    },
    async remove(markets) {
      if (markets.length > 0) await redis.srem(key, ...markets);
    },
  };
}

/** Market mới (chưa thấy) cần phân loại: không thuộc `STOCK_MARKET_SET`. Hàm thuần; kết quả không trùng, đã sắp xếp. */
export function unclassifiedMarkets(
  added: readonly string[],
  stocks: ReadonlySet<string> = STOCK_MARKET_SET,
): string[] {
  return [...new Set(added)].filter((m) => !stocks.has(m)).sort();
}

/** ≤ `SR_NEW_MARKET_ALERT_MAX` market: mỗi market một tin; nhiều hơn: một tin tổng hợp (10 tên đầu + tổng). */
export function newMarketEvents(
  markets: readonly string[],
  version: string = NEWS_ASSET_MAP_VERSION,
): TeamOpsEvent[] {
  if (markets.length === 0) return [];
  if (markets.length > SR_NEW_MARKET_ALERT_MAX)
    return [
      {
        type: "team_sr_new_market",
        markets: markets.slice(0, SR_NEW_MARKET_ALERT_MAX),
        total: markets.length,
        assetMapVersion: version,
      },
    ];
  return markets.map((m) => ({
    type: "team_sr_new_market",
    markets: [m],
    total: 1,
    assetMapVersion: version,
  }));
}

export type NewMarketResult =
  | { status: "skipped" }
  | { status: "seeded"; count: number }
  | { status: "checked"; alerted: string[] };

export interface NewMarketDeps {
  store: SeenStore;
  /** Ghi sự kiện vào outbox `jobs.team_ops` (một transaction cho mọi sự kiện của lượt). */
  emit: (events: readonly TeamOpsEvent[]) => Promise<void>;
  stocks?: ReadonlySet<string>;
  version?: string;
}

/** Một lượt so sánh với danh sách market SoDEX vừa đọc. Danh sách rỗng thì bỏ qua (không coi là "không có market"). */
export async function checkNewMarkets(
  deps: NewMarketDeps,
  live: readonly string[],
): Promise<NewMarketResult> {
  const names = [...new Set(live.filter((n) => n !== ""))];
  if (names.length === 0) return { status: "skipped" };
  if (!(await deps.store.exists())) {
    await deps.store.add(names);
    return { status: "seeded", count: names.length };
  }
  const added = await deps.store.add(names);
  const markets = unclassifiedMarkets(added, deps.stocks);
  if (markets.length === 0) return { status: "checked", alerted: [] };
  try {
    await deps.emit(newMarketEvents(markets, deps.version));
  } catch (error) {
    // Chưa ghi được tin: bỏ "đã thấy" để lượt sau báo lại (báo thừa hơn báo thiếu).
    await deps.store.remove(markets).catch(() => undefined);
    throw error;
  }
  return { status: "checked", alerted: markets };
}

/** Ghi outbox `jobs.team_ops` (jobs gửi Telegram cho team, DEC-184). */
export function outboxEmitter(db: Db): NewMarketDeps["emit"] {
  return async (events) => {
    if (events.length === 0) return;
    await db.insert(outbox).values(events.map((payload) => ({ topic: "jobs.team_ops", payload })));
  };
}

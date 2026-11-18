import { SIGNAL_RANGE_MS, type SignalRange } from "@drift/shared";

import {
  DATA_CACHE_MS,
  liveBots,
  readOnly,
  TtlCache,
  windowOf,
  type BotInfo,
  type SignalDeps,
} from "./common";
import { loadFills, previousByBot, type FillSet } from "./data";

// Tập dữ liệu nặng của một kỳ, cache 60 s theo (chiến lược, kỳ). Mọi bộ lọc và danh sách / chi tiết lọc trong bộ nhớ trên
// cùng tập, nên số giữa các tab và giữa trang / chi tiết khớp nhau. Mỗi Db một cache (test chạy nhiều app).

const fills = new WeakMap<object, TtlCache<FillSet>>();
const prevs = new WeakMap<object, TtlCache<Awaited<ReturnType<typeof previousByBot>>>>();
const extras = new WeakMap<object, TtlCache<unknown>>();

function cacheOf<T>(m: WeakMap<object, TtlCache<T>>, db: object): TtlCache<T> {
  let c = m.get(db);
  if (c === undefined) {
    c = new TtlCache<T>(DATA_CACHE_MS);
    m.set(db, c);
  }
  return c;
}

export function fillSet(
  deps: SignalDeps,
  strategy: BotInfo["strategy"],
  range: SignalRange,
  now: Date,
): Promise<FillSet> {
  return cacheOf(fills, deps.db).get(`${strategy}|${range}`, now.getTime(), () =>
    readOnly(deps.db, async (q) => {
      const bots = await liveBots(q, [strategy]);
      return loadFills(q, strategy, windowOf(range, now), bots);
    }),
  );
}

/** Tổng theo bot của kỳ trước cùng độ dài (Market Making + Volume Builder). */
export function previousSet(deps: SignalDeps, range: SignalRange, now: Date) {
  return cacheOf(prevs, deps.db).get(range, now.getTime(), () =>
    readOnly(deps.db, (q) => {
      const len = SIGNAL_RANGE_MS[range];
      return previousByBot(q, ["volume_maker", "volume_farm"], {
        from: new Date(now.getTime() - 2 * len),
        to: new Date(now.getTime() - len),
      });
    }),
  );
}

/** Dữ liệu phụ (sự kiện VB, số lệnh MM...) của một kỳ, cache cùng thời hạn. */
export function extraSet<T>(
  deps: SignalDeps,
  key: string,
  now: Date,
  load: () => Promise<T>,
): Promise<T> {
  return cacheOf(extras, deps.db).get(key, now.getTime(), load) as Promise<T>;
}

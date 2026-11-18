import { SIGNAL_RANGE_MS, type SignalRange } from "@drift/shared";

import {
  DATA_CACHE_MS,
  liveBots,
  readOnly,
  windowOf,
  type BotInfo,
  type SignalDeps,
  type Window,
} from "./common";
import { loadVbFills, previousByBot, type FillSet } from "./data";

// Ảnh chụp dữ liệu của một kỳ (review #246 điểm 4, 10): mỗi kỳ một ảnh chụp với MỘT cửa sổ thời gian; tập fill của từng
// chiến lược, tổng kỳ trước và mọi dữ liệu phụ (sự kiện VB, lượt VB, số lệnh MM…) gắn vào ảnh chụp đó, nên tab All ghép
// MM + VB cùng một lần chụp và dữ liệu phụ tự bỏ khi tập fill đổi. Giữ 60 s; mỗi Db giữ tối đa 2 ảnh chụp (LRU), ảnh cũ
// hơn bị bỏ để bộ nhớ có giới hạn.

export type Prev = Awaited<ReturnType<typeof previousByBot>>;

export interface Snapshot {
  range: SignalRange;
  at: number;
  window: Window;
  sets: Partial<Record<BotInfo["strategy"], Promise<FillSet>>>;
  prev: Promise<Prev> | null;
  extras: Map<string, Promise<unknown>>;
}

/** Số ảnh chụp giữ cùng lúc cho một Db. */
export const SNAPSHOT_LRU = 2;

const snapshots = new WeakMap<object, Map<SignalRange, Snapshot>>();

export function snapshotOf(deps: SignalDeps, range: SignalRange, now: Date): Snapshot {
  let m = snapshots.get(deps.db);
  if (m === undefined) {
    m = new Map();
    snapshots.set(deps.db, m);
  }
  const t = now.getTime();
  const hit = m.get(range);
  if (hit !== undefined && t - hit.at < DATA_CACHE_MS && t >= hit.at) {
    // Đưa lên cuối (dùng gần nhất).
    m.delete(range);
    m.set(range, hit);
    return hit;
  }
  m.delete(range);
  const snap: Snapshot = {
    range,
    at: t,
    window: windowOf(range, now),
    sets: {},
    prev: null,
    extras: new Map(),
  };
  m.set(range, snap);
  while (m.size > SNAPSHOT_LRU) {
    const oldest = m.keys().next().value;
    if (oldest === undefined) break;
    m.delete(oldest);
  }
  return snap;
}

/** Bỏ mọi ảnh chụp (test). */
export function clearSnapshots(db: object): void {
  snapshots.delete(db);
}

/** Lỗi thì bỏ khỏi ảnh chụp để lần sau tải lại. */
function keep<T>(p: Promise<T>, drop: () => void): Promise<T> {
  p.catch(drop);
  return p;
}

/** Fill Volume Builder của ảnh chụp (Market Making và tab All cộng trong SQL, không giữ fill trong Node). */
export function fillSet(
  deps: SignalDeps,
  snap: Snapshot,
  strategy: "volume_farm",
): Promise<FillSet> {
  const hit = snap.sets.volume_farm;
  if (hit !== undefined) return hit;
  const p = keep(
    readOnly(deps.db, async (q) => {
      const bots = await liveBots(q, [strategy]);
      return loadVbFills(q, snap.window, bots);
    }),
    () => {
      if (snap.sets.volume_farm === p) delete snap.sets.volume_farm;
    },
  );
  snap.sets.volume_farm = p;
  return p;
}

/** Tổng theo bot của kỳ trước cùng độ dài (Market Making + Volume Builder), cùng ảnh chụp. */
export function previousSet(deps: SignalDeps, snap: Snapshot): Promise<Prev> {
  if (snap.prev !== null) return snap.prev;
  const len = SIGNAL_RANGE_MS[snap.range];
  const to = snap.window.from;
  const p = keep(
    readOnly(deps.db, (q) =>
      previousByBot(q, ["volume_maker", "volume_farm"], {
        from: new Date(to.getTime() - len),
        to,
      }),
    ),
    () => {
      if (snap.prev === p) snap.prev = null;
    },
  );
  snap.prev = p;
  return p;
}

/** Dữ liệu phụ gắn với ảnh chụp: bỏ cùng lúc với tập fill. */
export function extraSet<T>(snap: Snapshot, key: string, load: () => Promise<T>): Promise<T> {
  const hit = snap.extras.get(key);
  if (hit !== undefined) return hit as Promise<T>;
  const p = keep(load(), () => {
    if (snap.extras.get(key) === p) snap.extras.delete(key);
  });
  snap.extras.set(key, p);
  return p;
}

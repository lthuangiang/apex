import { WATCHLIST_MAX, type WatchlistEntry } from "@drift/shared";

// Thao tác thuần trên danh sách Watchlist (UI_REVIEW M2, DEC-74). Thứ tự trong mảng là thứ tự hiển thị.

export const has = (list: readonly WatchlistEntry[], market: string) =>
  list.some((x) => x.market === market);

export const isFull = (list: readonly WatchlistEntry[]) => list.length >= WATCHLIST_MAX;

/** Thêm vào cuối; đã có hoặc đã đủ 8 thì giữ nguyên. */
export function add(list: readonly WatchlistEntry[], entry: WatchlistEntry): WatchlistEntry[] {
  return has(list, entry.market) || isFull(list) ? [...list] : [...list, entry];
}

export const remove = (list: readonly WatchlistEntry[], market: string): WatchlistEntry[] =>
  list.filter((x) => x.market !== market);

/** Đổi chỗ với dòng trên (-1) / dưới (+1); ở đầu / cuối thì giữ nguyên. */
export function move(
  list: readonly WatchlistEntry[],
  index: number,
  dir: -1 | 1,
): WatchlistEntry[] {
  const to = index + dir;
  const out = [...list];
  const a = out[index];
  const b = out[to];
  if (a === undefined || b === undefined) return out;
  out[index] = b;
  out[to] = a;
  return out;
}

/** Kéo thả: đưa dòng `from` tới vị trí `to`. */
export function reorder(
  list: readonly WatchlistEntry[],
  from: number,
  to: number,
): WatchlistEntry[] {
  const out = [...list];
  const [it] = out.splice(from, 1);
  if (it === undefined) return [...list];
  out.splice(Math.max(0, Math.min(to, out.length)), 0, it);
  return out;
}

export const toggle = (list: readonly WatchlistEntry[], entry: WatchlistEntry): WatchlistEntry[] =>
  has(list, entry.market) ? remove(list, entry.market) : add(list, entry);

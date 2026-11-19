import { dec } from "@drift/shared";
import type { VbSignalSnapshot } from "@drift/shared/vb-signal";

import type { BookTop, MinuteCandle, OrderIntent } from "../core/types";

import { validCandles, type FarmSignal } from "./signal";

// Snapshot tín hiệu của một lượt vào (#221): dữ liệu để trang team "VB Signal Analysis" phân tích chất lượng tín hiệu
// (đuổi giá bao nhiêu bp trước khi vào, theo regime / điểm / từng thành phần, lượt do tín hiệu hay do cân long-short).
// Hàm thuần, chỉ đọc; không tham gia quyết định nên không đổi lệnh hay state.

const r4 = (v: number) => Math.round(v * 10_000) / 10_000;
const r1 = (v: number) => Math.round(v * 10) / 10;
/** Chuỗi thập phân không ký hiệu mũ (Decimal.toString dùng mũ với số rất nhỏ). */
const fixed = (v: string) => dec(v).toFixed();

/** Giá lúc quyết định so với giá đóng nến đã đóng gần nhất có giờ đóng ≤ at − k phút (bp); quá k + 2 phút thì null. */
function changeBps(
  candles: ReturnType<typeof validCandles>,
  at: number,
  ref: number | null,
  mins: number,
): number | null {
  if (ref === null || !(ref > 0)) return null;
  const cutoff = at - mins * 60_000;
  for (let i = candles.length - 1; i >= 0; i -= 1) {
    const k = candles[i];
    if (k === undefined) continue;
    const closeAt = k.t + 60_000;
    if (closeAt > cutoff) continue;
    if (closeAt < cutoff - 2 * 60_000 || !(k.c > 0)) return null;
    return r1(((ref - k.c) / k.c) * 10_000);
  }
  return null;
}

/**
 * Giá `ref` so với giá đóng của nến 1 phút đã đóng ≤ `at` − `mins` phút (bp, có dấu: dương = giá đã lên), cùng công thức
 * với `chg{1,3,5}mBps` của snapshot. Dùng cho biến thể `fade` của công cụ nghiên cứu #282.
 */
export function moveBeforeBps(
  raw: readonly MinuteCandle[],
  at: number,
  ref: number | null,
  mins: number,
): number | null {
  return changeBps(validCandles(raw, at), at, ref, mins);
}

export interface EntrySnapshotInput {
  sig: FarmSignal & { direction: "long" | "short" };
  side: "long" | "short";
  reversed: boolean;
  balanced: boolean;
  at: number;
  candles: readonly MinuteCandle[];
  book: BookTop | null;
  bookAt: number | null;
  last: string | null;
  order: OrderIntent;
  usd: string;
  holdSecs: number;
  entryTry: number;
  taker: boolean;
}

/**
 * Snapshot an toàn: lỗi bất ngờ khi dựng (dữ liệu lạ) thì trả undefined, lượt vào vẫn ghi quyết định và đặt lệnh như
 * thường. Không bao giờ ném lỗi ra bước chiến lược.
 */
export function safeEntrySnapshot(i: EntrySnapshotInput): VbSignalSnapshot | undefined {
  try {
    return entrySnapshot(i);
  } catch {
    return undefined;
  }
}

export function entrySnapshot(i: EntrySnapshotInput): VbSignalSnapshot {
  const usable = i.book !== null && dec(i.book.bid).gt(0) && dec(i.book.ask).gt(i.book.bid);
  const mid = usable && i.book !== null ? dec(i.book.bid).add(i.book.ask).div(2).toFixed() : null;
  const refStr = mid ?? i.last;
  const ref = refStr === null ? null : Number(refStr);
  const candles = validCandles(i.candles, i.at);
  const c = i.sig.components;
  return {
    v: 1,
    direction: i.sig.direction,
    side: i.side,
    score: r4(i.sig.score),
    confidence: r4(i.sig.confidence),
    regime: i.sig.regime,
    components: {
      candleMomentum: r4(c.candleMomentum),
      wickRejection: r4(c.wickRejection),
      volumeAcceleration: r4(c.volumeAcceleration),
      tradePressure: r4(c.tradePressure),
      orderbookImbalance: r4(c.orderbookImbalance),
    },
    // Sổ chéo / bằng giá (spread ≤ 0) hoặc không hữu hạn: null, không làm hỏng cả snapshot.
    spreadBps:
      i.sig.spreadBps === null || !Number.isFinite(i.sig.spreadBps) || i.sig.spreadBps <= 0
        ? null
        : Math.round(i.sig.spreadBps * 100) / 100,
    reason: i.sig.reason.slice(0, 200),
    reversed: i.reversed,
    balanced: i.balanced,
    price: {
      bid: i.book === null ? null : fixed(i.book.bid),
      ask: i.book === null ? null : fixed(i.book.ask),
      mid,
      last: i.last === null ? null : fixed(i.last),
      mark: null,
      bookAgeMs: i.book === null || i.bookAt === null ? null : Math.max(0, i.at - i.bookAt),
      chg1mBps: changeBps(candles, i.at, ref, 1),
      chg3mBps: changeBps(candles, i.at, ref, 3),
      chg5mBps: changeBps(candles, i.at, ref, 5),
    },
    order: {
      clOrdID: i.order.clOrdID,
      price: i.order.price === undefined ? null : fixed(i.order.price),
      size: fixed(i.order.quantity),
      usd: i.usd,
      holdSecs: i.holdSecs,
      entryTry: i.entryTry,
      taker: i.taker,
    },
  };
}

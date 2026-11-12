import { Decimal, dec } from "../money";

import type { LeaderFill } from "./episodes";
import { sodexMarketOf, type CoinIndex } from "./markets";

// Thay đổi vị thế của ví leader cho Trader profile và Following (DEC-163 mục 11): fill cùng (ví, coin) trong 60 giây
// tính từ fill đầu gộp thành một sự kiện. Hàm thuần.

export const EVENT_GROUP_MS = 60_000;

export const LEADER_EVENT_KINDS = ["open", "add", "reduce", "close", "flip", "liquidated"] as const;
export type LeaderEventKind = (typeof LEADER_EVENT_KINDS)[number];

export interface LeaderEvent {
  coin: string;
  /** Market SoDEX; null = SoDEX không có ("Not listed"). */
  market: string | null;
  kind: LeaderEventKind;
  positionBefore: string;
  positionAfter: string;
  /** Notional thay đổi (USD, dương). */
  notional: string;
  /** Giá trung bình theo khối lượng. */
  price: string;
  /** PnL đã chốt của sự kiện trừ phí (USD); null khi sự kiện không đóng phần nào (mở / tăng). */
  realized: string | null;
  /** Fill đầu và fill cuối của sự kiện (ms UTC). */
  at: number;
  lastAt: number;
  lastTid: string;
}

export type TidFill = LeaderFill & { tid: string };

function kindOf(before: Decimal, after: Decimal, liquidated: boolean): LeaderEventKind {
  if (liquidated && after.abs().lt(before.abs())) return "liquidated";
  if (before.isZero()) return "open";
  if (after.isZero()) return "close";
  if (before.isNegative() !== after.isNegative()) return "flip";
  return after.abs().gt(before.abs()) ? "add" : "reduce";
}

function eventOf(group: readonly TidFill[], index: CoinIndex): LeaderEvent | null {
  const first = group[0];
  const last = group.at(-1);
  if (first === undefined || last === undefined) return null;
  const before = dec(first.startPosition);
  const after = dec(last.startPosition).add(last.side === "B" ? dec(last.sz) : dec(last.sz).neg());
  let qty = new Decimal(0);
  let notional = new Decimal(0);
  let pnl = new Decimal(0);
  let fees = new Decimal(0);
  for (const f of group) {
    qty = qty.add(dec(f.sz));
    notional = notional.add(dec(f.px).mul(dec(f.sz)));
    pnl = pnl.add(dec(f.closedPnl));
    fees = fees.add(dec(f.fee));
  }
  const kind = kindOf(
    before,
    after,
    group.some((f) => f.liquidatedSelf),
  );
  const closes = kind === "reduce" || kind === "close" || kind === "flip" || kind === "liquidated";
  if (qty.isZero()) return null;
  return {
    coin: first.coin,
    market: sodexMarketOf(first.coin, index),
    kind: kindOf(
      before,
      after,
      group.some((f) => f.liquidatedSelf),
    ),
    positionBefore: before.toString(),
    positionAfter: after.toString(),
    notional: notional.toDecimalPlaces(2).toString(),
    price: notional.div(qty).toSignificantDigits(10).toString(),
    realized: closes ? pnl.sub(fees).toDecimalPlaces(2).toString() : null,
    at: first.time,
    lastAt: last.time,
    lastTid: last.tid,
  };
}

/**
 * Gộp fill thành sự kiện. `now` cho biết nhóm nào đã khép (fill đầu cũ hơn 60 giây); nhóm chưa khép trả trong
 * `open` để người gọi giữ lại tới lần sau. Không có `now` thì khép hết (dữ liệu lịch sử).
 */
export function groupLeaderEvents(
  fills: readonly TidFill[],
  index: CoinIndex,
  now?: number,
): { events: LeaderEvent[]; open: TidFill[] } {
  const byCoin = new Map<string, TidFill[]>();
  for (const f of [...fills].sort((a, b) => a.time - b.time || a.tid.localeCompare(b.tid))) {
    const list = byCoin.get(f.coin) ?? [];
    list.push(f);
    byCoin.set(f.coin, list);
  }
  const events: LeaderEvent[] = [];
  const open: TidFill[] = [];
  for (const list of byCoin.values()) {
    let group: TidFill[] = [];
    const close = (): void => {
      const e = eventOf(group, index);
      if (e !== null) events.push(e);
      group = [];
    };
    for (const f of list) {
      const start = group[0];
      if (start !== undefined && f.time - start.time > EVENT_GROUP_MS) close();
      group.push(f);
    }
    const start = group[0];
    if (start !== undefined) {
      if (now !== undefined && now - start.time <= EVENT_GROUP_MS) open.push(...group);
      else close();
    }
  }
  events.sort((a, b) => a.at - b.at);
  return { events, open };
}

/** Cảnh báo "big move" (DEC-163 mục 11). Ngưỡng USD tối thiểu chưa chốt (OPEN_QUESTIONS 21a): không có thì tắt. */
export const BIG_MOVE = {
  /** Gấp chừng này lần cỡ vào lệnh trung vị 30 ngày của trader. */
  multiple: 3,
  windowMs: 15 * 60_000,
  /** Mỗi (ví, coin) cách nhau ít nhất chừng này. */
  cooldownMs: 10 * 60_000,
} as const;

/** Notional mở mới trong sự kiện: open / add = phần thay đổi; flip = cả vị thế mới. */
export function openingNotional(e: LeaderEvent): Decimal {
  if (e.kind === "open" || e.kind === "add") return dec(e.notional);
  if (e.kind === "flip") return dec(e.positionAfter).abs().mul(dec(e.price));
  return new Decimal(0);
}

export interface BigMoveInput {
  /** Sự kiện của cùng (ví, coin), gồm sự kiện mới. */
  events: readonly LeaderEvent[];
  /** Trung vị notional vào lệnh 30 ngày; null = chưa biết → không cảnh báo. */
  medianEntryNotional: string | null;
  /** Ngưỡng USD; null = cảnh báo tắt. */
  minUsd: string | null;
  lastAlertAt: number | null;
  now: number;
}

/** Notional cộng dồn 15 phút nếu đủ điều kiện big move, ngược lại null. */
export function bigMove(input: BigMoveInput): Decimal | null {
  if (input.minUsd === null || input.medianEntryNotional === null) return null;
  if (input.lastAlertAt !== null && input.now - input.lastAlertAt < BIG_MOVE.cooldownMs)
    return null;
  const total = input.events
    .filter((e) => e.at >= input.now - BIG_MOVE.windowMs)
    .reduce((s, e) => s.add(openingNotional(e)), new Decimal(0));
  if (total.isZero()) return null;
  if (total.lt(dec(input.minUsd))) return null;
  if (total.lt(dec(input.medianEntryNotional).mul(BIG_MOVE.multiple))) return null;
  return total;
}

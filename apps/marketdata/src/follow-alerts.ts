import {
  dec,
  FOLLOW_ALERT_GAP_MS,
  POSITION_ALERT_KINDS,
  type FollowAlertLevel,
  type LeaderEvent,
} from "@drift/shared";

// Quyết định cảnh báo follow (DEC-209), hàm thuần không I/O. `leader-store.ts` đọc / ghi DB quanh đây.

/** Chỉ market SoDEX có (`market` null = "Not listed"): áp cho mọi cảnh báo follow, kể cả big move. */
export function listedOnly(events: readonly LeaderEvent[]): LeaderEvent[] {
  return events.filter((e) => e.market !== null);
}

/** Người follow nhận big move: mọi mức trừ `off`. Mức `positions` nhận cả big move. */
export function bigMoveFollowers<T extends { level: FollowAlertLevel }>(
  followers: readonly T[],
): T[] {
  return followers.filter((f) => f.level !== "off");
}

/**
 * Đang có bot copy tiền thật chạy (starting / running / resuming) theo trader này thì tạm không báo theo trader: tin
 * của bot copy (DEC-TBD-copy-bot-alerts) đã nói về cùng lệnh. Bot pause, dừng hay bot paper không tính; mức đã chọn
 * giữ nguyên trong DB nên tự quay lại khi bot không chạy nữa.
 */
export function notCopying<T extends { userId: string }>(
  followers: readonly T[],
  copying: ReadonlySet<string>,
): T[] {
  return followers.filter((f) => !copying.has(f.userId));
}

/** Người follow nhận cảnh báo vị thế: chỉ mức `positions`. */
export function positionFollowers<T extends { level: FollowAlertLevel }>(
  followers: readonly T[],
): T[] {
  return followers.filter((f) => f.level === "positions");
}

/** Chiều của vị thế sau sự kiện; đóng hết thì là chiều của vị thế vừa đóng. */
export function positionSide(
  e: Pick<LeaderEvent, "positionBefore" | "positionAfter">,
): "long" | "short" | null {
  const after = dec(e.positionAfter);
  const ref = after.isZero() ? dec(e.positionBefore) : after;
  return ref.isZero() ? null : ref.isPositive() ? "long" : "short";
}

export interface PositionAlert {
  coin: string;
  event: LeaderEvent;
  side: "long" | "short" | null;
}

/**
 * Sự kiện được báo ở mức `positions`: mở mới, đóng hẳn, đảo chiều, bị thanh lý (bỏ add / reduce); mỗi coin lấy sự
 * kiện cuối trong lượt; bỏ coin vừa có big move (`skipCoins`) và coin đã báo trong 10 phút qua (`lastAlertAt`).
 */
export function planPositionAlerts(
  events: readonly LeaderEvent[],
  lastAlertAt: ReadonlyMap<string, number>,
  skipCoins: ReadonlySet<string>,
  now: number,
): PositionAlert[] {
  const kinds: readonly string[] = POSITION_ALERT_KINDS;
  const latest = new Map<string, LeaderEvent>();
  for (const e of listedOnly(events))
    if (kinds.includes(e.kind) && !skipCoins.has(e.coin)) latest.set(e.coin, e);
  const out: PositionAlert[] = [];
  for (const [coin, event] of latest) {
    const last = lastAlertAt.get(coin);
    if (last !== undefined && now - last < FOLLOW_ALERT_GAP_MS) continue;
    out.push({ coin, event, side: positionSide(event) });
  }
  return out;
}

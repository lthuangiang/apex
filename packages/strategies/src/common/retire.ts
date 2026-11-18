import { dec, Decimal } from "@drift/shared";

import type { Side, StrategyAction, StrategyEvent } from "../core/types";

// Lệnh của version cũ mà engine đã huỷ lúc áp version mới (#223, DEC-TBD-version-apply-position), theo khuôn chờ xác
// nhận huỷ của DEC-317: lệnh coi là còn sống tới khi SoDEX báo kết thúc (`orderDone` / `orderReject`) hoặc đã khớp đủ;
// trong lúc chờ, chiến lược gửi huỷ lại mỗi `RETIRE_RETRY_MS` và KHÔNG dựng lệnh của version mới (một lệnh cũ khớp
// muộn sẽ làm sai giới hạn của bố cục mới). Fill tới muộn được ghi vào sổ cái theo chiều của chính lệnh (chiều trong event
// do engine lấy từ dòng `orders`, rồi chiều đã nhớ), không bao giờ theo cấu hình mới. Không bao giờ bị đẩy khỏi bộ nhớ.

/** Gửi lại huỷ cho lệnh cũ chưa kết thúc sau ngần này (như `FARM_TIMING.cancelRetryMs`, DEC-317). */
export const RETIRE_RETRY_MS = 10_000;

export interface RetiringOrder {
  side: Side;
  /** Khối lượng đặt; thiếu (state cũ) thì không giới hạn phần khớp. */
  qty?: string;
  filled: string;
  /** Lần cuối gửi huỷ (ms); null = engine vừa huỷ lúc áp version, chưa tính mốc. */
  cancelAt: number | null;
}

export type Retiring = Record<string, RetiringOrder>;

export const retiringOf = (r: Retiring | undefined): Retiring => r ?? {};
export const isRetiring = (r: Retiring | undefined): boolean =>
  r !== undefined && Object.keys(r).length > 0;

/** Nhịp thời gian (tick / timer): gửi huỷ lại cho lệnh đã chờ quá `RETIRE_RETRY_MS`. */
export function retireTick(
  r: Retiring | undefined,
  at: number,
): { actions: StrategyAction[]; retiring: Retiring | undefined } {
  if (r === undefined || Object.keys(r).length === 0) return { actions: [], retiring: r };
  const actions: StrategyAction[] = [];
  let changed = false;
  const next: Retiring = {};
  for (const [id, o] of Object.entries(r)) {
    if (o.cancelAt === null) {
      next[id] = { ...o, cancelAt: at };
      changed = true;
    } else if (at - o.cancelAt >= RETIRE_RETRY_MS) {
      actions.push({ type: "cancel", clOrdID: id });
      next[id] = { ...o, cancelAt: at };
      changed = true;
    } else next[id] = o;
  }
  return { actions, retiring: changed ? next : r };
}

/** Lệnh cũ đã kết thúc trên SoDEX: thôi chờ. */
export function retireEnd(r: Retiring | undefined, id: string): Retiring | undefined {
  if (r?.[id] === undefined) return r;
  const left = Object.fromEntries(Object.entries(r).filter(([k]) => k !== id));
  return Object.keys(left).length === 0 ? undefined : left;
}

/**
 * Fill của một lệnh cũ đang chờ kết thúc: chiều và phần được ghi (không vượt khối lượng đặt, fill phát lại không cộng
 * trùng). Khớp đủ thì lệnh đã kết thúc, thôi chờ. null = không phải lệnh đang chờ.
 */
export function retireFill(
  r: Retiring | undefined,
  e: Extract<StrategyEvent, { type: "fill" }>,
): { side: Side; quantity: Decimal; fee: string; retiring: Retiring | undefined } | null {
  const o = r?.[e.clOrdID];
  if (r === undefined || o === undefined) return null;
  const room = o.qty === undefined ? dec(e.quantity) : dec(o.qty).sub(o.filled);
  const quantity = Decimal.max(0, Decimal.min(room, e.quantity));
  const fee =
    quantity.lt(e.quantity) && dec(e.quantity).gt(0)
      ? dec(e.fee).mul(quantity).div(e.quantity).toString()
      : e.fee;
  const filled = dec(o.filled).add(quantity);
  const full = o.qty !== undefined && filled.gte(o.qty);
  return {
    side: e.side ?? o.side,
    quantity,
    fee,
    retiring: full
      ? retireEnd(r, e.clOrdID)
      : { ...r, [e.clOrdID]: { ...o, filled: filled.toString() } },
  };
}

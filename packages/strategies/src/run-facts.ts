import { dec, Decimal, Strategy } from "@drift/shared";

import { copyLedgerTotals, isMultiMarketCopyState } from "./copy-trade";
import type { Ledger } from "./core/ledger";
import { farmNet, type VolumeFarmState } from "./volume-farm";
import { costPerMillion, type VolumeMakerState } from "./volume-maker";

// Số liệu phiên chạy của bot từ state runtime, dùng chung cho trang Trading Agent (api) và tin Telegram khi bot dừng
// (jobs, #566), để hai nơi luôn cùng công thức và cùng số (quy tắc 1.8). Hàm thuần, không I/O.

/**
 * Net cost / $1M của trang bot: max(0, −net) ÷ volume × 1M, 2 chữ số; lãi (net ≥ 0) → "0"; chưa có khối lượng → null.
 * Trang bot Volume Farm và Platform Stats (theo strategy) dùng chung.
 */
export function netCostPerMillion(net: Decimal, volume: Decimal): string | null {
  return volume.isZero()
    ? null
    : Decimal.max(0, net.neg()).div(volume).mul(1_000_000).toDecimalPlaces(2).toString();
}

/** Chi phí / $1M của phiên Volume Farm: `netCostPerMillion(farmNet, volume)` (trang bot dùng chung). */
export function farmCostPerMillion(st: VolumeFarmState): string | null {
  return netCostPerMillion(farmNet(st), dec(st.volume));
}

/** Chi phí mỗi $1M của một bot Market Making / Volume Farm từ state runtime (cùng công thức trang bot, #129). */
export function botCostPerMillion(strategy: string, state: unknown): string | null {
  if (state === null || state === undefined) return null;
  if (strategy === Strategy.volumeMaker) return costPerMillion(state as VolumeMakerState);
  if (strategy === Strategy.volumeFarm) return farmCostPerMillion(state as VolumeFarmState);
  return null;
}

/**
 * Lãi / lỗ của bot ĐÃ DỪNG (hoặc vị thế bằng 0): đã chốt − phí − funding theo sổ cái của bot; Copy Trade nhiều market
 * cộng mọi market. Bot đã dừng không còn quản lý vị thế nên không tính phần chưa chốt theo giá mới (`netOf` của api).
 * Không có sổ cái → null.
 */
export function settledNet(state: unknown): string | null {
  if (isMultiMarketCopyState(state)) {
    const t = copyLedgerTotals(state);
    return dec(t.realized).sub(t.fees).sub(t.funding).toString();
  }
  const l = (state as { ledger?: Ledger } | null)?.ledger;
  if (l === undefined) return null;
  return dec(l.realized).sub(l.fees).sub(l.funding).toString();
}

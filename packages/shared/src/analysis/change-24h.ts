import { dec } from "../money";

// % đổi giá 24 giờ từ nến 1h SoDEX (Watchlist ở Overview, "Market today" của Desk AI). SoDEX trả nến mới nhất trước,
// nên phải lấy giá mở của nến CŨ NHẤT theo thời gian, không phải phần tử đầu mảng. Hàm thuần.

export interface OpenCandle {
  t: number;
  o: string;
}

/** Nến theo thời gian tăng dần (không đổi mảng gốc). */
export function byTime<T extends { t: number }>(candles: readonly T[]): T[] {
  return [...candles].sort((a, b) => a.t - b.t);
}

/** (giá hiện tại − giá mở nến cũ nhất) / giá mở × 100, 2 chữ số; thiếu dữ liệu hay giá mở 0 → null. */
export function change24hPct(price: string | null, candles: readonly OpenCandle[]): string | null {
  const first = byTime(candles)[0];
  if (price === null || first === undefined || dec(first.o).isZero()) return null;
  return dec(price).sub(first.o).div(first.o).mul(100).toDecimalPlaces(2).toString();
}

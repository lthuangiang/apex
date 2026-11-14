import { Decimal } from "@drift/shared";

/** Phần của một vị thế đóng cần để cộng Realized PnL. */
export interface ClosedPosition {
  id: bigint | string | number;
  realizedPnL: string;
  updatedAt: number;
}

export const REALIZED_PAGE = 1000;
/** Tối đa ngần này trang (10.000 vị thế); nhiều hơn thì trả null thay vì một tổng thiếu (quy tắc 1.8). */
export const REALIZED_MAX_PAGES = 10;

/**
 * Tổng Realized PnL từ `since`, đọc lùi từng trang `positions/history` của SoDEX. SoDEX trả theo `updatedAt` giảm dần
 * nhưng lọc `endTime` theo `createdAt`, nên trang sau đặt `endTime` = `updatedAt` nhỏ nhất của trang trước: mọi vị thế
 * chưa đọc có `createdAt ≤ updatedAt ≤` mốc đó nên đều nằm trong trang sau; vị thế đã đọc có thể lặp lại và được bỏ
 * theo id. Một trang không có gì mới, hoặc quá `REALIZED_MAX_PAGES` trang, thì trả null.
 */
export async function sumRealized(
  page: (endTime: number | undefined) => Promise<readonly ClosedPosition[]>,
  since: number,
): Promise<string | null> {
  const seen = new Set<string>();
  let total = new Decimal(0);
  let endTime: number | undefined;
  for (let i = 0; i < REALIZED_MAX_PAGES; i += 1) {
    const rows = await page(endTime);
    let fresh = 0;
    let oldest = Infinity;
    for (const p of rows) {
      oldest = Math.min(oldest, p.updatedAt);
      const key = String(p.id);
      if (seen.has(key)) continue;
      seen.add(key);
      fresh += 1;
      if (p.updatedAt >= since) total = total.add(p.realizedPnL);
    }
    if (rows.length < REALIZED_PAGE || oldest < since) return total.toString();
    if (fresh === 0) return null;
    endTime = oldest;
  }
  return null;
}

import type { WsCandle, WsMarkPrice } from "@drift/sodex";

// Logic thuần của marketdata (không I/O, test riêng).

/** Nến 1m đã đóng: khi SoDEX gửi `x: true`, hoặc khi nến của phút kế tiếp xuất hiện. */
export class CandleTracker {
  readonly #last = new Map<string, WsCandle>();

  push(candle: WsCandle): WsCandle[] {
    const closed: WsCandle[] = [];
    const last = this.#last.get(candle.s);
    if (last !== undefined && candle.t > last.t && !last.x) closed.push({ ...last, x: true });
    if (candle.x) {
      if (last?.t !== candle.t || !last.x) closed.push(candle);
    }
    this.#last.set(candle.s, candle);
    return closed;
  }
}

export interface FundingRecord {
  market: string;
  fundingTime: number;
  rate: string;
}

/**
 * SoDEX không có lịch sử funding toàn thị trường (SODEX.md mục 5.6). Khi `nextFundingTime` của một
 * market tăng lên, kỳ cũ vừa chốt với rate cuối cùng thấy được trước thời điểm đó.
 */
export class FundingTracker {
  readonly #last = new Map<string, { rate: string; next: number; seenAt: number }>();

  push(marks: readonly WsMarkPrice[]): FundingRecord[] {
    const settled: FundingRecord[] = [];
    for (const m of marks) {
      const last = this.#last.get(m.s);
      // Chỉ ghi khi đã thấy rate trước kỳ chốt (không đoán rate của kỳ mình không quan sát).
      if (last !== undefined && m.T > last.next && last.seenAt < last.next) {
        settled.push({ market: m.s, fundingTime: last.next, rate: last.rate });
      }
      if (last?.next !== m.T || m.E >= last.seenAt) {
        this.#last.set(m.s, { rate: m.r, next: m.T, seenAt: m.E });
      }
    }
    return settled;
  }
}

/** Subject NATS dạng chấm, chữ thường (C3): `md.btc-usd.kline.1m`. */
export function marketSubject(market: string, kind: string): string {
  return `md.${market.toLowerCase().replace(/[^a-z0-9-]/g, "-")}.${kind}`;
}

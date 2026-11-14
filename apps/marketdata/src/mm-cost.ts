import { dec, Decimal } from "@drift/shared";

// Dữ liệu chi phí làm market (D1 / D2, DEC-227). Hàm / lớp thuần, không I/O: marketdata đẩy WS `bookTicker` và
// `trade` vào, mỗi giây gọi `tick`, mỗi phút lấy `flush()` để ghi DB.
// - Markout của một giao dịch công khai, phía maker (taker BUY → maker bán): bán `(giá − mid sau 30 s) ÷ giá`, mua ngược
//   dấu; bps, dương = có lợi cho maker. Không có mid trong ±2 s quanh mốc 30 s thì bỏ giao dịch đó (không đoán).
// - Spread lấy mẫu mỗi giây theo số tick, từ book ticker còn mới (≤ 5 s).
// - Gom theo giờ của giờ khớp; giờ chưa có dữ liệu thì không có dòng (không bao giờ ghi 0).

export const MARKOUT_MS = 30_000;
const BOOK_FRESH_MS = 5_000;
const MID_KEEP_S = 180;
const MID_MATCH_S = 2;
const HOUR = 3_600_000;

export interface HourBucket {
  market: string;
  hour: number;
  notional: Decimal;
  markoutNotional: Decimal;
  trades: number;
  spreadTicks: Record<string, number>;
}

interface Book {
  bid: Decimal;
  ask: Decimal;
  at: number;
}
interface Pending {
  market: string;
  at: number;
  takerBuy: boolean;
  price: Decimal;
  notional: Decimal;
}

export class MmCostCollector {
  readonly #ticks = new Map<string, Decimal>();
  readonly #books = new Map<string, Book>();
  /** Mid theo giây (epoch s) của từng market, giữ ~3 phút để chấm markout. */
  readonly #mids = new Map<string, Map<number, Decimal>>();
  #pending: Pending[] = [];
  readonly #buckets = new Map<string, HourBucket>();
  readonly #touched = new Set<string>();
  /** Market đang có bot MM: ghi thêm mid mỗi giây vào `mid_1s` (D2). */
  #midMarkets = new Set<string>();
  #midRows: { market: string; ts: number; mid: Decimal }[] = [];

  setTickSizes(ticks: Readonly<Record<string, string>>): void {
    for (const [m, t] of Object.entries(ticks)) if (dec(t).gt(0)) this.#ticks.set(m, dec(t));
  }

  setMidMarkets(markets: Iterable<string>): void {
    this.#midMarkets = new Set(markets);
  }

  /** Nạp lại tổng của giờ đang chạy sau khi khởi động lại (cộng tiếp, không ghi đè mất phần đã có). */
  seed(bucket: HourBucket): void {
    this.#buckets.set(key(bucket.market, bucket.hour), {
      ...bucket,
      spreadTicks: { ...bucket.spreadTicks },
    });
  }

  onBook(market: string, bid: string, ask: string, at: number): void {
    const b = dec(bid);
    const a = dec(ask);
    if (b.lte(0) || a.lte(0) || a.lt(b)) return;
    this.#books.set(market, { bid: b, ask: a, at });
  }

  onTrade(market: string, at: number, side: "BUY" | "SELL", price: string, qty: string): void {
    const p = dec(price);
    const q = dec(qty);
    if (p.lte(0) || q.lte(0)) return;
    this.#pending.push({ market, at, takerBuy: side === "BUY", price: p, notional: p.mul(q) });
  }

  /** Mỗi giây: lấy mẫu mid + spread, chấm markout cho giao dịch đã đủ 30 s. */
  tick(now: number): void {
    const sec = Math.floor(now / 1000);
    for (const [market, b] of this.#books) {
      if (now - b.at > BOOK_FRESH_MS) continue;
      const mid = b.bid.add(b.ask).div(2);
      const series = this.#mids.get(market) ?? new Map<number, Decimal>();
      series.set(sec, mid);
      for (const s of series.keys()) if (s < sec - MID_KEEP_S) series.delete(s);
      this.#mids.set(market, series);
      if (this.#midMarkets.has(market)) this.#midRows.push({ market, ts: sec * 1000, mid });
      const tick = this.#ticks.get(market);
      if (tick !== undefined) {
        const n = b.ask.sub(b.bid).div(tick).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toNumber();
        const bucket = this.#bucket(market, now);
        bucket.spreadTicks[String(n)] = (bucket.spreadTicks[String(n)] ?? 0) + 1;
      }
    }
    const due: Pending[] = [];
    const later: Pending[] = [];
    for (const p of this.#pending) (p.at + MARKOUT_MS <= now - 1000 ? due : later).push(p);
    this.#pending = later;
    for (const p of due) {
      const mid = this.#midNear(p.market, Math.floor((p.at + MARKOUT_MS) / 1000));
      if (mid === null) continue;
      const raw = p.takerBuy ? p.price.sub(mid) : mid.sub(p.price);
      const bps = raw.div(p.price).mul(10_000);
      const bucket = this.#bucket(p.market, p.at);
      bucket.notional = bucket.notional.add(p.notional);
      bucket.markoutNotional = bucket.markoutNotional.add(p.notional.mul(bps));
      bucket.trades += 1;
    }
  }

  /** Các giờ đã đổi từ lần flush trước (tổng đầy đủ của giờ đó) + mid mỗi giây chờ ghi. */
  flush(now: number): {
    buckets: HourBucket[];
    mids: { market: string; ts: number; mid: Decimal }[];
  } {
    const buckets = [...this.#touched].flatMap((k) => {
      const b = this.#buckets.get(k);
      return b === undefined ? [] : [{ ...b, spreadTicks: { ...b.spreadTicks } }];
    });
    this.#touched.clear();
    // Giờ đã qua hơn 2 giờ: không còn thay đổi, bỏ khỏi bộ nhớ.
    const cutoff = now - 2 * HOUR;
    for (const [k, b] of this.#buckets) if (b.hour < cutoff) this.#buckets.delete(k);
    const mids = this.#midRows;
    this.#midRows = [];
    return { buckets, mids };
  }

  #bucket(market: string, at: number): HourBucket {
    const hour = Math.floor(at / HOUR) * HOUR;
    const k = key(market, hour);
    let b = this.#buckets.get(k);
    if (b === undefined) {
      b = {
        market,
        hour,
        notional: new Decimal(0),
        markoutNotional: new Decimal(0),
        trades: 0,
        spreadTicks: {},
      };
      this.#buckets.set(k, b);
    }
    this.#touched.add(k);
    return b;
  }

  #midNear(market: string, sec: number): Decimal | null {
    const series = this.#mids.get(market);
    if (series === undefined) return null;
    for (let d = 0; d <= MID_MATCH_S; d += 1) {
      const a = series.get(sec + d);
      if (a !== undefined) return a;
      const b = series.get(sec - d);
      if (b !== undefined) return b;
    }
    return null;
  }
}

const key = (market: string, hour: number) => `${market}|${String(hour)}`;

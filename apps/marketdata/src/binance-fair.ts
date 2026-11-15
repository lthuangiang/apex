import type { MmFairMessage } from "@drift/shared";

// Giá Binance quy đổi (Market Making, Smart quoting): giá giữa Binance USDT-M futures của cùng coin chia cho chênh lệch
// nền với giá giữa SoDEX (trung vị 60 s). Binance đi trước SoDEX khoảng 0,25 s (đo 2026-11-14), nên đây là giá hợp lý
// để bot không đặt báo giá sắp bị MM lớn gom. Gửi khi giá đổi đủ nhiều, không dày hơn `minGapMs`, và nhắc lại sau
// `heartbeatMs` để bot biết giá còn mới.

const BASIS_WINDOW_MS = 60_000;
const BASIS_SAMPLE_MS = 1_000;
/** Cần ngần này mẫu chênh lệch nền trước khi gửi giá. */
const BASIS_MIN_SAMPLES = 30;

/**
 * Gửi khi giá đổi ≥ `moveBp`, không dày hơn `minGapMs`, nhắc lại sau `heartbeatMs`. Không gửi (và không lấy mẫu chênh
 * lệch nền) khi lần cập nhật Binance cuối đã nhận quá `maxBinanceAgeMs`: luồng Binance khựng thì bot không dùng giá cũ.
 */
export const FAIR_PUBLISH = {
  moveBp: 0.25,
  minGapMs: 250,
  heartbeatMs: 2_000,
  maxBinanceAgeMs: 1_000,
} as const;

interface MarketState {
  sodex: number | null;
  binance: number | null;
  binanceT: number;
  /** Lúc nhận lần cập nhật Binance cuối (giờ máy marketdata). */
  binanceAt: number;
  samples: { at: number; bp: number }[];
  lastSample: number;
  sent: { fair: number; at: number } | null;
}

/** Coin của market SoDEX → symbol Binance USDT perpetual (BTC-USD → BTCUSDT); null khi Binance không có. */
export function binanceSymbolOf(market: string, binance: ReadonlySet<string>): string | null {
  const m = /^([A-Z0-9]+)-USD$/.exec(market);
  if (m === null) return null;
  const sym = `${m[1] ?? ""}USDT`;
  return binance.has(sym) ? sym : null;
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 === 1 ? (s[mid] ?? 0) : ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2;
};

export class BinanceFair {
  readonly #publish: (msg: MmFairMessage) => void;
  readonly #markets = new Map<string, MarketState>();

  constructor(publish: (msg: MmFairMessage) => void) {
    this.#publish = publish;
  }

  /** Đặt danh sách market theo dõi; market mới bắt đầu lại từ đầu, market bỏ đi thì quên. */
  setMarkets(markets: readonly string[]): void {
    for (const m of [...this.#markets.keys()]) if (!markets.includes(m)) this.#markets.delete(m);
    for (const m of markets)
      if (!this.#markets.has(m))
        this.#markets.set(m, {
          sodex: null,
          binance: null,
          binanceT: 0,
          binanceAt: Number.NEGATIVE_INFINITY,
          samples: [],
          lastSample: Number.NEGATIVE_INFINITY,
          sent: null,
        });
  }

  onSodex(market: string, bid: string, ask: string, at: number): void {
    const s = this.#markets.get(market);
    if (s === undefined) return;
    s.sodex = (Number(bid) + Number(ask)) / 2;
    this.#check(market, s, at);
  }

  onBinance(market: string, bid: string, ask: string, T: number, at: number): void {
    const s = this.#markets.get(market);
    if (s === undefined) return;
    s.binance = (Number(bid) + Number(ask)) / 2;
    s.binanceT = T;
    s.binanceAt = at;
    this.#check(market, s, at);
  }

  #check(market: string, s: MarketState, at: number): void {
    if (s.sodex === null || s.binance === null || s.sodex <= 0) return;
    if (at - s.binanceAt > FAIR_PUBLISH.maxBinanceAgeMs) return;
    if (at - s.lastSample >= BASIS_SAMPLE_MS) {
      s.samples.push({ at, bp: ((s.binance - s.sodex) / s.sodex) * 10_000 });
      s.lastSample = at;
      while (s.samples.length > 0 && at - (s.samples[0]?.at ?? at) > BASIS_WINDOW_MS)
        s.samples.shift();
    }
    if (s.samples.length < BASIS_MIN_SAMPLES) return;
    const fair = s.binance / (1 + median(s.samples.map((x) => x.bp)) / 10_000);
    const last = s.sent;
    if (last !== null) {
      const since = at - last.at;
      const moved = (Math.abs(fair - last.fair) / last.fair) * 10_000;
      if (since < FAIR_PUBLISH.minGapMs) return;
      if (moved < FAIR_PUBLISH.moveBp && since < FAIR_PUBLISH.heartbeatMs) return;
    }
    s.sent = { fair, at };
    this.#publish({ s: market, fair: fair.toPrecision(10), T: s.binanceT, at });
  }
}

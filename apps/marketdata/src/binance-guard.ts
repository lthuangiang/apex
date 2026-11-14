import type { MmGuardMessage } from "@drift/shared";

// Binance guard (Market Making): so giá giữa Binance futures với giá giữa SoDEX của cùng coin. Khi Binance lệch khỏi
// SoDEX quá ngưỡng (sau khi trừ chênh lệch nền, trung vị 60 s), báo giá của maker nhỏ trên SoDEX đang cũ và dễ bị MM
// lớn khớp ngay trước khi giá SoDEX nhảy theo. Gửi tín hiệu khi trạng thái của một phía đổi.

const BASIS_WINDOW_MS = 60_000;
const BASIS_SAMPLE_MS = 1_000;
/** Cần ngần này mẫu chênh lệch nền trước khi gửi tín hiệu. */
const BASIS_MIN_SAMPLES = 30;

interface MarketState {
  sodex: number | null;
  binance: number | null;
  binanceT: number;
  samples: { at: number; bp: number }[];
  lastSample: number;
  until: { ask: number; bid: number };
  sent: { ask: boolean; bid: boolean };
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

export class BinanceGuard {
  readonly #thresholdBp: number;
  readonly #holdMs: number;
  readonly #publish: (msg: MmGuardMessage) => void;
  readonly #markets = new Map<string, MarketState>();

  constructor(opts: {
    thresholdBp: number;
    holdMs: number;
    publish: (msg: MmGuardMessage) => void;
  }) {
    this.#thresholdBp = opts.thresholdBp;
    this.#holdMs = opts.holdMs;
    this.#publish = opts.publish;
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
          samples: [],
          lastSample: 0,
          until: { ask: 0, bid: 0 },
          sent: { ask: false, bid: false },
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
    this.#check(market, s, at);
  }

  #check(market: string, s: MarketState, at: number): void {
    if (s.sodex === null || s.binance === null || s.sodex <= 0) return;
    const raw = ((s.binance - s.sodex) / s.sodex) * 10_000;
    if (at - s.lastSample >= BASIS_SAMPLE_MS) {
      s.samples.push({ at, bp: raw });
      s.lastSample = at;
      while (s.samples.length > 0 && at - (s.samples[0]?.at ?? at) > BASIS_WINDOW_MS)
        s.samples.shift();
    }
    if (s.samples.length < BASIS_MIN_SAMPLES) return;
    const gap = raw - median(s.samples.map((x) => x.bp));
    if (gap >= this.#thresholdBp) s.until.ask = at + this.#holdMs;
    if (gap <= -this.#thresholdBp) s.until.bid = at + this.#holdMs;
    const ask = at < s.until.ask;
    const bid = at < s.until.bid;
    if (ask === s.sent.ask && bid === s.sent.bid) return;
    s.sent = { ask, bid };
    this.#publish({ s: market, ask, bid, gapBp: Math.round(gap * 100) / 100, T: s.binanceT, at });
  }
}

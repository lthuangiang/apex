import {
  dec,
  Decimal,
  mmBookMessageSchema,
  NEWS_RULES,
  SignalReason,
  type Quote,
} from "@drift/shared";

// Giá cho lane tin tức (#271): CHỈ đọc thứ marketdata đã có, không bao giờ gọi REST SoDEX.
// 1. `md.<market>.book` (NATS, giá tốt nhất SoDEX từ WS bookTicker; marketdata chỉ gửi cho market có bot MM / Volume Farm).
// 2. Không có (1): giá gần nhất `md:last:<market>` (Redis, mọi market, ~2 s) ± nửa spread trung vị 2 giờ gần nhất của
//    `mm_market_hourly.spread_ticks` (market top volume ∪ MM ∪ VF) × tick size (đọc lại từ danh sách market scheduler đã có).
// Không có giá mới → NO_SODEX_PRICE; có giá mà không có dữ liệu sổ lệnh → NO_BOOK_DATA (không đoán spread).

export interface BookTick {
  bid: Decimal;
  ask: Decimal;
  at: number;
}

/** Giá tốt nhất mới nhất mỗi market, nhận từ NATS `md.*.book`. */
export class LiveBooks {
  readonly #books = new Map<string, BookTick>();

  /** Tin NATS thô (JSON); sai schema thì bỏ. */
  onMessage(raw: string, at: number): void {
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return;
    }
    const p = mmBookMessageSchema.safeParse(json);
    if (!p.success) return;
    const bid = new Decimal(p.data.b);
    const ask = new Decimal(p.data.a);
    if (bid.lte(0) || ask.lt(bid)) return;
    this.#books.set(p.data.s, { bid, ask, at });
  }

  get(market: string): BookTick | undefined {
    return this.#books.get(market);
  }
}

/** Trung vị số tick từ các histogram `{ "1": 3400, "2": 120 }`; trả cả tổng số mẫu. */
export function medianTicks(
  hists: readonly Readonly<Record<string, number>>[],
): { ticks: number; samples: number } | null {
  const counts = new Map<number, number>();
  for (const h of hists)
    for (const [k, n] of Object.entries(h)) {
      const t = Number(k);
      if (!Number.isFinite(t) || t < 0 || !Number.isFinite(n) || n <= 0) continue;
      counts.set(t, (counts.get(t) ?? 0) + n);
    }
  const samples = [...counts.values()].reduce((s, n) => s + n, 0);
  if (samples === 0) return null;
  let seen = 0;
  for (const t of [...counts.keys()].sort((a, b) => a - b)) {
    seen += counts.get(t) ?? 0;
    if (seen * 2 >= samples) return { ticks: t, samples };
  }
  return null;
}

/** Ghép giá từ các nguồn đã có (hàm thuần). */
export function combineQuote(input: {
  now: number;
  book: BookTick | undefined;
  last: { price: string; at: number } | undefined;
  spread: { ticks: number; samples: number } | null;
  tickSize: string | null;
}): Quote | SignalReason {
  const { now, book, last } = input;
  if (book !== undefined && now - book.at <= NEWS_RULES.bookFreshMs)
    return { bid: book.bid, ask: book.ask, source: "book" };
  if (last === undefined || now - last.at > NEWS_RULES.lastPriceFreshMs)
    return SignalReason.noPrice;
  const price = dec(last.price);
  if (
    price.lte(0) ||
    input.spread === null ||
    input.spread.samples < NEWS_RULES.hourlySpreadMinSamples ||
    input.tickSize === null
  )
    return SignalReason.noBookData;
  const half = dec(input.tickSize).mul(input.spread.ticks).div(2);
  return { bid: price.sub(half), ask: price.add(half), source: "last_spread" };
}

export interface QuoteDeps {
  now: () => number;
  books: Pick<LiveBooks, "get">;
  /** Redis `md:last:<market>` → `{ price, at }`; thiếu / hỏng thì không có key trong Map. */
  lastPrices: (markets: readonly string[]) => Promise<Map<string, { price: string; at: number }>>;
  /** Histogram spread (tick) theo giờ của các market từ mốc `since`. */
  spreadHists: (
    markets: readonly string[],
    since: number,
  ) => Promise<Map<string, Readonly<Record<string, number>>[]>>;
  tickSize: (market: string) => string | null;
}

const SPREAD_CACHE_MS = 60_000;
const SPREAD_WINDOW_MS = 2 * 3_600_000;

export class QuoteSource {
  readonly #deps: QuoteDeps;
  readonly #spreads = new Map<
    string,
    { at: number; v: { ticks: number; samples: number } | null }
  >();

  constructor(deps: QuoteDeps) {
    this.#deps = deps;
  }

  async quotes(markets: readonly string[]): Promise<Map<string, Quote | SignalReason>> {
    const now = this.#deps.now();
    const uniq = [...new Set(markets)];
    const out = new Map<string, Quote | SignalReason>();
    if (uniq.length === 0) return out;
    const need = uniq.filter((m) => {
      const b = this.#deps.books.get(m);
      return b === undefined || now - b.at > NEWS_RULES.bookFreshMs;
    });
    const last =
      need.length > 0
        ? await this.#deps.lastPrices(need)
        : new Map<string, { price: string; at: number }>();
    const stale = need.filter((m) => {
      const c = this.#spreads.get(m);
      return c === undefined || now - c.at > SPREAD_CACHE_MS;
    });
    if (stale.length > 0) {
      const hists = await this.#deps.spreadHists(stale, now - SPREAD_WINDOW_MS);
      for (const m of stale) this.#spreads.set(m, { at: now, v: medianTicks(hists.get(m) ?? []) });
    }
    for (const m of uniq)
      out.set(
        m,
        combineQuote({
          now,
          book: this.#deps.books.get(m),
          last: last.get(m),
          spread: this.#spreads.get(m)?.v ?? null,
          tickSize: this.#deps.tickSize(m),
        }),
      );
    return out;
  }
}

export function isQuote(q: Quote | SignalReason | undefined): q is Quote {
  return typeof q === "object";
}

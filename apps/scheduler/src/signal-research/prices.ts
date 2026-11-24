import {
  dec,
  Decimal,
  mmBookMessageSchema,
  NEWS_RULES,
  SignalReason,
  srBookReplySchema,
  type Quote,
} from "@drift/shared";

// Giá cho lane tin tức (#271): CHỈ đọc thứ marketdata đã có, không bao giờ gọi REST SoDEX.
// 1. `md.<market>.book` (NATS, giá tốt nhất SoDEX từ WS bookTicker; marketdata chỉ gửi cho market có bot MM / Volume Farm).
// 2. Không có (1): giá gần nhất `md:last:<market>` (Redis, mọi market, ~2 s) ± nửa spread trung vị 2 giờ gần nhất của
//    `mm_market_hourly.spread_ticks` (market top volume ∪ MM ∪ VF) × tick size (đọc lại từ danh sách market scheduler đã có).
// Không có giá mới → NO_SODEX_PRICE; có giá mà không có dữ liệu sổ lệnh → NO_BOOK_DATA (không đoán spread).
// 3. #507 (DEC-TBD-sr-noprice): chỉ ở bước quyết định (`decisionQuote`), khi (1)–(2) cho NO_BOOK_DATA / NO_SODEX_PRICE:
//    hỏi marketdata đọc sổ lệnh REST SoDEX một lần qua NATS (lane vẫn không gọi SoDEX, DEC-322). Sổ thật (bid > 0,
//    ask > bid) thì dùng đúng giá mua / bán tốt nhất (`rest_book`), không tính spread theo giờ; không có thì giữ lý do cũ.

export interface BookTick {
  bid: Decimal;
  ask: Decimal;
  at: number;
}

/** Khoá subject của marketdata (`md.<khoá>.book`), như `marketSubject` của apps/marketdata. */
export const bookKeyOf = (market: string) => market.toLowerCase().replace(/[^a-z0-9-]/g, "-");

/**
 * Giá tốt nhất mới nhất mỗi market, nhận từ NATS `md.*.book`. Chỉ giữ chuỗi thô theo subject; parse (zod + Decimal) khi
 * `get()` — tức chỉ cho market đang cần giá, không cho mọi tin của mọi market.
 */
export class LiveBooks {
  readonly #raw = new Map<string, { raw: string; at: number }>();

  /** Tin NATS thô; subject dạng `md.<khoá>.book`. */
  onMessage(subject: string, raw: string, at: number): void {
    const key = subject.split(".")[1];
    if (key !== undefined) this.#raw.set(key, { raw, at });
  }

  get(market: string): BookTick | undefined {
    const m = this.#raw.get(bookKeyOf(market));
    if (m === undefined) return undefined;
    let json: unknown;
    try {
      json = JSON.parse(m.raw);
    } catch {
      return undefined;
    }
    const p = mmBookMessageSchema.safeParse(json);
    if (!p.success || p.data.s !== market) return undefined;
    const bid = dec(p.data.b);
    const ask = dec(p.data.a);
    if (bid.lte(0) || ask.lt(bid)) return undefined;
    return { bid, ask, at: m.at };
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
    return { bid: book.bid, ask: book.ask, source: "book", at: book.at };
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
  return { bid: price.sub(half), ask: price.add(half), source: "last_spread", at: last.at };
}

/** Kết quả đọc sổ REST qua marketdata; `timeout` / `unavailable` (NATS chưa nối) do phía lane đặt. */
export type RestBookResult =
  | { ok: true; bid: string; ask: string; at: number }
  | { ok: false; reason: "empty" | "unknown_market" | "error" | "timeout" | "unavailable" };

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
  /** #507: sổ lệnh REST một lần qua marketdata (NATS request); thiếu = không có bước này. */
  restBook?: (market: string) => Promise<RestBookResult>;
}

/**
 * Tuổi dữ liệu giá của một market ở lần `quotes()` gần nhất (#507 phần D, chỉ để chẩn đoán `NO_SODEX_PRICE`): sổ lệnh
 * live và giá gần nhất `md:last` cũ bao nhiêu ms; null = không có dữ liệu đó (chưa từng nhận / hết hạn / không đọc).
 */
export interface QuoteAges {
  bookAgeMs: number | null;
  lastAgeMs: number | null;
}

/**
 * Chẩn đoán khi bước quyết định không có giá (#507 phần D, ghi vào `detail` của NO_SODEX_PRICE / NO_BOOK_DATA): tuổi sổ
 * live và giá gần nhất, số mẫu spread theo giờ (null = không có), có tick size không, và kết quả đọc sổ REST.
 */
export interface QuoteDiag extends QuoteAges {
  spreadSamples: number | null;
  tickSize: boolean;
  /** `not_tried`: đã có giá, lý do khác, hoặc không có bước REST; `ok`: dùng sổ REST; còn lại: vì sao không dùng được. */
  rest: "not_tried" | "ok" | "crossed" | Extract<RestBookResult, { ok: false }>["reason"];
}

const SPREAD_CACHE_MS = 60_000;
const SPREAD_WINDOW_MS = 2 * 3_600_000;

export class QuoteSource {
  readonly #deps: QuoteDeps;
  readonly #spreads = new Map<
    string,
    { at: number; v: { ticks: number; samples: number } | null }
  >();
  readonly #ages = new Map<string, QuoteAges>();
  readonly #diag = new Map<string, QuoteDiag>();

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
    for (const m of uniq) {
      const book = this.#deps.books.get(m);
      const lastPrice = last.get(m);
      // Sổ lệnh tươi thì không đọc `md:last` (lastAgeMs null); chỉ cần cho chẩn đoán khi không có giá.
      this.#ages.set(m, {
        bookAgeMs: book === undefined ? null : now - book.at,
        lastAgeMs: lastPrice === undefined ? null : now - lastPrice.at,
      });
      out.set(
        m,
        combineQuote({
          now,
          book,
          last: lastPrice,
          spread: this.#spreads.get(m)?.v ?? null,
          tickSize: this.#deps.tickSize(m),
        }),
      );
    }
    return out;
  }

  /** Tuổi dữ liệu giá của `market` ở lần `quotes()` gần nhất; chưa hỏi market đó thì undefined. */
  ages(market: string): QuoteAges | undefined {
    return this.#ages.get(market);
  }

  /**
   * Giá cho bước quyết định (Filter / Decide, context): như `quotes()`, rồi nếu không có giá vì thiếu sổ live / mẫu spread
   * / giá gần nhất thì đọc sổ REST một lần (nếu có `restBook`). Watcher lệnh mở không dùng hàm này (không đọc REST mỗi nhịp).
   */
  async decisionQuote(market: string): Promise<Quote | SignalReason> {
    const q = (await this.quotes([market])).get(market) ?? SignalReason.noPrice;
    const ages = this.#ages.get(market) ?? { bookAgeMs: null, lastAgeMs: null };
    const diag = (rest: QuoteDiag["rest"]): QuoteDiag => ({
      ...ages,
      spreadSamples: this.#spreads.get(market)?.v?.samples ?? null,
      tickSize: this.#deps.tickSize(market) !== null,
      rest,
    });
    const restBook = this.#deps.restBook;
    if (
      isQuote(q) ||
      (q !== SignalReason.noBookData && q !== SignalReason.noPrice) ||
      restBook === undefined
    ) {
      this.#diag.set(market, diag("not_tried"));
      return q;
    }
    let r: RestBookResult;
    try {
      r = await restBook(market);
    } catch {
      r = { ok: false, reason: "error" };
    }
    if (!r.ok) {
      this.#diag.set(market, diag(r.reason));
      return q;
    }
    let bid: Decimal;
    let ask: Decimal;
    try {
      bid = dec(r.bid);
      ask = dec(r.ask);
    } catch {
      this.#diag.set(market, diag("error"));
      return q;
    }
    // Sổ chéo / rỗng một phía / giá 0: không phải giá giao dịch được, giữ lý do cũ (không bịa giá).
    if (!bid.gt(0) || !ask.gt(bid)) {
      this.#diag.set(market, diag("crossed"));
      return q;
    }
    this.#diag.set(market, diag("ok"));
    return { bid, ask, source: "rest_book", at: r.at };
  }

  /** Chẩn đoán của lần `decisionQuote(market)` gần nhất; undefined khi chưa hỏi. */
  diag(market: string): QuoteDiag | undefined {
    return this.#diag.get(market);
  }
}

export function isQuote(q: Quote | SignalReason | undefined): q is Quote {
  return typeof q === "object";
}

/**
 * Gửi request sổ REST cho marketdata (#507) và đọc câu trả lời. `send` trả `{ reply }` (chuỗi JSON), hoặc `timeout` /
 * `unavailable` (NATS chưa nối, không có marketdata trả lời). Reply không đọc được hay sai market → `error`.
 */
export async function requestRestBook(
  market: string,
  send: (payload: string) => Promise<{ reply: string } | "timeout" | "unavailable">,
): Promise<RestBookResult> {
  let raw: string;
  try {
    const r = await send(JSON.stringify({ market }));
    if (r === "timeout" || r === "unavailable") return { ok: false, reason: r };
    raw = r.reply;
  } catch {
    return { ok: false, reason: "error" };
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "error" };
  }
  const r = srBookReplySchema.safeParse(json);
  if (!r.success) return { ok: false, reason: "error" };
  if (!r.data.ok) return { ok: false, reason: r.data.reason };
  if (r.data.s !== market) return { ok: false, reason: "error" };
  return { ok: true, bid: r.data.b, ask: r.data.a, at: r.data.at };
}

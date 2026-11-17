import type { MmBookMessage } from "@drift/shared";

/**
 * WS vẫn có tin mà giá tốt nhất không đổi: gửi lại giá đó tối đa mỗi ngần này ms (`refresh: true`), để Volume Farm biết
 * sổ lệnh còn mới (DEC-TBD-vb-live-book). Chỉ gửi khi có tin WS thật, nên stream chết thì không có tin nào.
 */
export const BOOK_REFRESH_MS = 1_000;

/**
 * Chuyển giá mua / bán tốt nhất SoDEX (WS `bookTicker`) sang engine cho bot Market Making (DEC-248) và Volume Farm
 * (DEC-TBD-vb-live-book): chỉ market có bot. Giá đổi thì gửi ngay; giá không đổi (chỉ đổi khối lượng) thì gửi lại tối
 * đa mỗi `BOOK_REFRESH_MS` với `refresh: true` (Market Making bỏ qua tin này).
 */
export class SodexBookRelay {
  readonly #publish: (msg: MmBookMessage) => void;
  #markets = new Set<string>();
  readonly #last = new Map<string, { key: string; at: number }>();

  constructor(publish: (msg: MmBookMessage) => void) {
    this.#publish = publish;
  }

  setMarkets(markets: readonly string[]): void {
    this.#markets = new Set(markets);
    for (const m of [...this.#last.keys()]) if (!this.#markets.has(m)) this.#last.delete(m);
  }

  onSodex(s: string, b: string, a: string, E: number, at: number): void {
    if (!this.#markets.has(s)) return;
    const key = `${b}|${a}`;
    const last = this.#last.get(s);
    if (last?.key === key) {
      if (at - last.at < BOOK_REFRESH_MS) return;
      this.#last.set(s, { key, at });
      this.#publish({ s, b, a, E, at, refresh: true });
      return;
    }
    this.#last.set(s, { key, at });
    this.#publish({ s, b, a, E, at });
  }
}

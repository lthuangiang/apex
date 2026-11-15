import type { MmBookMessage } from "@drift/shared";

/**
 * Chuyển giá mua / bán tốt nhất SoDEX (WS `bookTicker`) sang engine cho bot Market Making (DEC-248): chỉ market có bot,
 * chỉ khi giá đổi (đổi khối lượng thì không gửi).
 */
export class SodexBookRelay {
  readonly #publish: (msg: MmBookMessage) => void;
  #markets = new Set<string>();
  readonly #last = new Map<string, string>();

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
    if (this.#last.get(s) === key) return;
    this.#last.set(s, key);
    this.#publish({ s, b, a, E, at });
  }
}

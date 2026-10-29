// Cache có hạn cho dữ liệu đọc như market info (mục 12: không hard-code giới hạn SoDEX,
// lấy từ market info và cache có hạn). Gộp các lần gọi trùng khi đang tải (single flight).

interface Entry<V> {
  value: V;
  expiresAt: number;
}

export class TtlCache<V> {
  readonly #entries = new Map<string, Entry<V>>();
  readonly #inflight = new Map<string, Promise<V>>();
  readonly #ttlMs: number;
  readonly #now: () => number;

  constructor(ttlMs: number, now: () => number = Date.now) {
    if (ttlMs <= 0) throw new RangeError("ttlMs must be greater than 0");
    this.#ttlMs = ttlMs;
    this.#now = now;
  }

  async get(key: string, load: () => Promise<V>): Promise<V> {
    const entry = this.#entries.get(key);
    if (entry && entry.expiresAt > this.#now()) return entry.value;

    const pending = this.#inflight.get(key);
    if (pending) return pending;

    const promise = load()
      .then((value) => {
        this.#entries.set(key, { value, expiresAt: this.#now() + this.#ttlMs });
        return value;
      })
      .finally(() => {
        this.#inflight.delete(key);
      });
    this.#inflight.set(key, promise);
    return promise;
  }

  invalidate(key: string): void {
    this.#entries.delete(key);
  }
}

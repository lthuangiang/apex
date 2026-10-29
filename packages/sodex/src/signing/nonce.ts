import type { Address } from "viem";

// Nonce theo từng địa chỉ ký, đơn vị ms; SoDEX chỉ nhận nonce trong (T − 2 ngày, T + 1 ngày) và
// giữ 100 nonce cao nhất (docs/SODEX.md mục 5.6). Mỗi account chỉ có một writer (shard lease),
// nên bộ đếm trong process là đủ: nonce = max(now, nonce trước + 1).
// Nonce mới không làm retry thành idempotent; sau timeout phải đối soát theo clOrdID.

const ONE_DAY_MS = 24n * 60n * 60n * 1000n;

export interface NonceSource {
  next(address: Address): bigint;
}

export class MonotonicNonceSource implements NonceSource {
  readonly #last = new Map<Address, bigint>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  next(address: Address): bigint {
    const now = BigInt(this.#now());
    const previous = this.#last.get(address);
    const nonce = previous !== undefined && previous >= now ? previous + 1n : now;
    // Chỉ xảy ra khi gửi > 86,4 triệu request trong một ngày hoặc đồng hồ lùi mạnh.
    // Không cắt về trần: cắt sẽ trả lại nonce đã dùng.
    if (nonce >= now + ONE_DAY_MS) {
      throw new RangeError("Nonce would exceed the accepted window (T + 1 day)");
    }
    this.#last.set(address, nonce);
    return nonce;
  }
}

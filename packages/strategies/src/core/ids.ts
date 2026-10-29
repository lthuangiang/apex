// clOrdID tất định = hash(botId, version, tag, attempt) (ARCHITECTURE.md mục 3.3.3), dạng
// `^[0-9a-zA-Z_-]{1,36}$` của SoDEX. FNV-1a 64-bit thuần JS để chạy giống nhau ở engine và backtest.

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK = (1n << 64n) - 1n;

export function fnv1a64(input: string): bigint {
  let hash = FNV_OFFSET;
  // Theo đơn vị UTF-16: tất định trên mọi runtime, không cần TextEncoder.
  for (let i = 0; i < input.length; i += 1) {
    hash ^= BigInt(input.charCodeAt(i));
    hash = (hash * FNV_PRIME) & MASK;
  }
  return hash;
}

/** Ví dụ `d1-3-9f2k3j1x0a8b-0`: tiền tố ngắn, version, hash của tag, lần thử. */
export function clOrdId(botId: string, version: number, tag: string, attempt = 0): string {
  const bot = fnv1a64(botId).toString(36).slice(0, 6);
  const h = fnv1a64(`${botId}|${String(version)}|${tag}`).toString(36);
  return `d${bot}-${String(version)}-${h}-${String(attempt)}`.slice(0, 36);
}

/** Bản sao object không có `key` (thay cho `delete` khoá động). */
export function without<V>(record: Readonly<Record<string, V>>, key: string): Record<string, V> {
  return Object.fromEntries(Object.entries(record).filter(([k]) => k !== key));
}

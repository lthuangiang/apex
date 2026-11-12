// Map coin Hyperliquid → market SoDEX Perps (DEC-163). Chỉ map perp gốc của Hyperliquid:
// - spot (`@107`) và perp HIP-3 do builder tạo (`xyz:TSLA`, `para:TER`) không map (sàn khác, giá khác).
// - Hyperliquid ghi `kPEPE` cho 1000 PEPE; SoDEX ghi `1000PEPE-USD`. Cùng đơn vị 1000 token nên map thẳng.

export type CoinIndex = ReadonlyMap<string, string>;

/** `markets`: tên market SoDEX Perps đang giao dịch (`BTC-USD`, `1000PEPE-USD`). */
export function coinIndex(markets: readonly string[]): CoinIndex {
  const out = new Map<string, string>();
  for (const m of markets) {
    const base = m.split(/[-_/]/)[0];
    if (base === undefined || base === "") continue;
    const coin = base.startsWith("1000") && base.length > 4 ? `k${base.slice(4)}` : base;
    out.set(coin, m);
  }
  return out;
}

/** Perp (gốc hoặc HIP-3), không phải spot `@N`. Thống kê tính trên mọi perp; chỉ perp gốc map được sang SoDEX. */
export const isPerp = (coin: string): boolean => !coin.startsWith("@");

/** Perp gốc của Hyperliquid (không phải spot `@N`, không phải HIP-3 `dex:COIN`). */
export const isCorePerp = (coin: string): boolean => !coin.startsWith("@") && !coin.includes(":");

/** Market SoDEX của coin Hyperliquid; null khi SoDEX không có hoặc không phải perp gốc. */
export function sodexMarketOf(coin: string, index: CoinIndex): string | null {
  if (!isCorePerp(coin)) return null;
  return index.get(coin) ?? null;
}

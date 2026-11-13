// Map coin Hyperliquid → market SoDEX Perps (DEC-163, DEC-207):
// - perp gốc: `BTC` → `BTC-USD`. Hyperliquid ghi `kPEPE` cho 1000 PEPE; SoDEX ghi `1000PEPE-USD` (cùng 1000 token).
// - perp HIP-3 của dex `xyz` (cổ phiếu / hàng hoá, `xyz:TSLA`) → `TSLA-USD` khi SoDEX có. Dex HIP-3 khác (`para:TER`) và
//   spot (`@107`) không map.
// - Nếu cả perp gốc `SYM` lẫn `xyz:SYM` cùng tồn tại thì cả hai cùng map về một market SoDEX (chấp nhận, có test).

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

/** Dex HIP-3 được map sang SoDEX (DEC-207). Vị thế của các dex này đọc bằng `clearinghouseState` có `dex`. */
export const HIP3_MAPPED_DEXES = ["xyz"] as const;

/** Market SoDEX của coin Hyperliquid; null khi SoDEX không có, là spot, hay là HIP-3 của dex không map. */
export function sodexMarketOf(coin: string, index: CoinIndex): string | null {
  if (isCorePerp(coin)) return index.get(coin) ?? null;
  if (coin.startsWith("@")) return null;
  const [dex, sym] = coin.split(":", 2);
  if (
    sym === undefined ||
    sym === "" ||
    !(HIP3_MAPPED_DEXES as readonly string[]).includes(dex ?? "")
  )
    return null;
  return index.get(sym) ?? null;
}

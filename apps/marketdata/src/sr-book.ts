import { srBookRequestSchema, type SrBookReply } from "@drift/shared";

// #507 (DEC-TBD-sr-noprice): trả lời NATS request `sr.book.request` của lane research. Lane không gọi SoDEX (DEC-322):
// marketdata đọc sổ lệnh REST một lần cho market perps đang giao dịch và trả giá mua / bán tốt nhất. Kết quả giữ ngắn
// (`cacheMs`) và các request cùng market lúc đang đọc dùng chung một lần đọc, để không tốn hạn mức SoDEX.

export interface SrBookDeps {
  /** Sổ lệnh REST (giá giảm dần ở bids, tăng dần ở asks, như SoDEX trả). */
  orderbook: (market: string) => Promise<{
    bids: readonly (readonly [string, string])[];
    asks: readonly (readonly [string, string])[];
  }>;
  /** Market perps đang giao dịch (danh sách marketdata đọc lúc khởi động). */
  tradable: (market: string) => boolean;
  now: () => number;
  /** Giữ kết quả bao lâu (mặc định 2 s). */
  cacheMs?: number;
}

export function srBookResponder(deps: SrBookDeps): (raw: string) => Promise<SrBookReply> {
  const cacheMs = deps.cacheMs ?? 2_000;
  const cache = new Map<string, { at: number; reply: Promise<SrBookReply> }>();
  const read = async (market: string): Promise<SrBookReply> => {
    try {
      const b = await deps.orderbook(market);
      const bid = b.bids[0]?.[0];
      const ask = b.asks[0]?.[0];
      if (bid === undefined || ask === undefined) return { ok: false, reason: "empty" };
      return { ok: true, s: market, b: bid, a: ask, at: deps.now() };
    } catch {
      return { ok: false, reason: "error" };
    }
  };
  return (raw) => {
    let market: string;
    try {
      const p = srBookRequestSchema.safeParse(JSON.parse(raw));
      if (!p.success) return Promise.resolve({ ok: false, reason: "unknown_market" });
      market = p.data.market;
    } catch {
      return Promise.resolve({ ok: false, reason: "unknown_market" });
    }
    if (!deps.tradable(market)) return Promise.resolve({ ok: false, reason: "unknown_market" });
    const now = deps.now();
    const hit = cache.get(market);
    if (hit !== undefined && now - hit.at < cacheMs) return hit.reply;
    const reply = read(market);
    cache.set(market, { at: now, reply });
    // Lỗi không được giữ lại: lần sau đọc lại ngay.
    void reply.then((r) => {
      if (!r.ok && cache.get(market)?.reply === reply) cache.delete(market);
    });
    return reply;
  };
}

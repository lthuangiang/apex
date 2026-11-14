import { Decimal } from "@drift/shared";
import { describe, expect, it } from "vitest";

import { MmCostCollector } from "../mm-cost";

// Chi phí làm market (DEC-TBD-mm-cost): markout 30 s phía maker của giao dịch công khai, spread theo tick mỗi giây,
// gom theo giờ; không có mid quanh mốc 30 s thì bỏ giao dịch (không đoán); giờ không có dữ liệu thì không có dòng.

const H = Date.parse("2026-11-14T10:00:00Z");
const c0 = () => {
  const c = new MmCostCollector();
  c.setTickSizes({ "ETH-USD": "0.5" });
  return c;
};
const flat = () => ({ bid: "3000", ask: "3000.5" });
/** Đặt book rồi chạy tick mỗi giây trong [from, to] (ms). */
function run(
  c: MmCostCollector,
  from: number,
  to: number,
  book: (t: number) => { bid: string; ask: string } = flat,
) {
  for (let t = from; t <= to; t += 1000) {
    const b = book(t);
    c.onBook("ETH-USD", b.bid, b.ask, t);
    c.tick(t);
  }
}

describe("MmCostCollector", () => {
  it("scores the maker side 30 s later: taker buy means the maker sold", () => {
    const c = c0();
    // Taker MUA ở 3000.5: maker bán; 30 s sau mid 3001 → maker lỗ (−).
    c.onTrade("ETH-USD", H + 1000, "BUY", "3000.5", "2");
    // Taker BÁN ở 3000: maker mua; 30 s sau mid 3001 → maker lời (+).
    c.onTrade("ETH-USD", H + 1000, "SELL", "3000", "1");
    run(c, H, H + 40_000, (t) =>
      t < H + 30_000 ? { bid: "3000", ask: "3000.5" } : { bid: "3000.5", ask: "3001.5" },
    );
    const b = c.flush(H + 40_000).buckets.find((x) => x.market === "ETH-USD");
    expect(b?.trades).toBe(2);
    expect(b?.notional.toString()).toBe("9001");
    const want = new Decimal(6001)
      .mul(new Decimal(3000.5).sub(3001).div(3000.5).mul(10_000))
      .add(new Decimal(3000).mul(new Decimal(3001).sub(3000).div(3000).mul(10_000)));
    expect(b?.markoutNotional.toFixed(6)).toBe(want.toFixed(6));
    // Spread: 1 tick (0.5) lúc đầu, 2 tick (1.0) sau.
    expect(b?.spreadTicks["1"]).toBeGreaterThan(0);
    expect(b?.spreadTicks["2"]).toBeGreaterThan(0);
  });

  it("drops a trade when there is no mid within 2 s of the 30 s mark", () => {
    const c = c0();
    c.onTrade("ETH-USD", H, "BUY", "3000.5", "1");
    // Book chỉ có tới H + 20 s, rồi dừng (WS rớt).
    run(c, H, H + 20_000);
    for (let t = H + 21_000; t <= H + 40_000; t += 1000) c.tick(t);
    const b = c.flush(H + 40_000).buckets.find((x) => x.market === "ETH-USD");
    expect(b?.trades ?? 0).toBe(0);
  });

  it("writes per-second mids only for markets with a market making bot", () => {
    const c = c0();
    run(c, H, H + 2000);
    expect(c.flush(H + 2000).mids).toEqual([]);
    c.setMidMarkets(["ETH-USD"]);
    run(c, H + 3000, H + 4000);
    expect(c.flush(H + 4000).mids.map((m) => [m.ts, m.mid.toString()])).toEqual([
      [H + 3000, "3000.25"],
      [H + 4000, "3000.25"],
    ]);
  });

  it("keeps adding to the current hour after a restart", () => {
    const c = c0();
    c.seed({
      market: "ETH-USD",
      hour: H,
      notional: new Decimal(100),
      markoutNotional: new Decimal(-50),
      trades: 3,
      spreadTicks: { "1": 10 },
    });
    c.onTrade("ETH-USD", H + 5000, "SELL", "3000", "1");
    run(c, H + 5000, H + 40_000);
    const b = c.flush(H + 40_000).buckets.find((x) => x.market === "ETH-USD" && x.hour === H);
    expect(b?.trades).toBe(4);
    expect(b?.notional.toString()).toBe("3100");
  });
});

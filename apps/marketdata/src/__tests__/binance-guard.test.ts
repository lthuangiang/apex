import type { MmGuardMessage } from "@drift/shared";
import { describe, expect, it } from "vitest";

import { BinanceGuard, binanceSymbolOf } from "../binance-guard";

describe("binanceSymbolOf", () => {
  it("maps a SoDEX perp to the Binance USDT perpetual only when Binance lists it", () => {
    const listed = new Set(["BTCUSDT", "ETHUSDT"]);
    expect(binanceSymbolOf("BTC-USD", listed)).toBe("BTCUSDT");
    expect(binanceSymbolOf("XAUT-USD", listed)).toBeNull();
    expect(binanceSymbolOf("vBTC_vUSDC", listed)).toBeNull();
  });
});

describe("BinanceGuard", () => {
  const setup = () => {
    const sent: MmGuardMessage[] = [];
    const g = new BinanceGuard({ thresholdBp: 1, holdMs: 500, publish: (m) => sent.push(m) });
    g.setMarkets(["BTC-USD"]);
    // 40 s phẳng: Binance cao hơn SoDEX đều 2 bp (chênh lệch nền), không gửi gì.
    for (let t = 0; t <= 40_000; t += 1_000) {
      g.onSodex("BTC-USD", "99999", "100001", t);
      g.onBinance("BTC-USD", "100019", "100021", t + 1, t);
    }
    return { g, sent };
  };

  it("sends nothing while the gap stays at its usual level", () => {
    expect(setup().sent).toEqual([]);
  });

  it("flags the ask when Binance jumps above SoDEX, holds it, then clears", () => {
    const { g, sent } = setup();
    // Binance +1.5 bp so với nền: ask của maker trên SoDEX đang cũ.
    g.onBinance("BTC-USD", "100034", "100036", 41_001, 41_000);
    expect(sent).toEqual([
      { s: "BTC-USD", ask: true, bid: false, gapBp: 1.5, T: 41_001, at: 41_000 },
    ]);
    // SoDEX theo kịp: hết lệch, nhưng còn giữ 500 ms.
    g.onSodex("BTC-USD", "100014", "100016", 41_200);
    expect(sent).toHaveLength(1);
    g.onSodex("BTC-USD", "100014", "100016", 41_600);
    expect(sent.at(-1)).toMatchObject({ ask: false, bid: false, at: 41_600 });
  });

  it("flags the bid when Binance drops below SoDEX", () => {
    const { g, sent } = setup();
    g.onBinance("BTC-USD", "100004", "100006", 41_001, 41_000);
    expect(sent.at(-1)).toMatchObject({ ask: false, bid: true });
  });

  it("waits for enough samples of the usual gap before sending anything", () => {
    const sent: MmGuardMessage[] = [];
    const g = new BinanceGuard({ thresholdBp: 1, holdMs: 500, publish: (m) => sent.push(m) });
    g.setMarkets(["BTC-USD"]);
    g.onSodex("BTC-USD", "99999", "100001", 0);
    g.onBinance("BTC-USD", "100099", "100101", 1, 0);
    expect(sent).toEqual([]);
  });
});

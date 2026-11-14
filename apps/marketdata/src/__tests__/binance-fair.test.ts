import type { MmFairMessage } from "@drift/shared";
import { describe, expect, it } from "vitest";

import { BinanceFair, binanceSymbolOf } from "../binance-fair";

describe("binanceSymbolOf", () => {
  it("maps a SoDEX perp to the Binance USDT perpetual only when Binance lists it", () => {
    const listed = new Set(["BTCUSDT", "ETHUSDT"]);
    expect(binanceSymbolOf("BTC-USD", listed)).toBe("BTCUSDT");
    expect(binanceSymbolOf("XAUT-USD", listed)).toBeNull();
    expect(binanceSymbolOf("vBTC_vUSDC", listed)).toBeNull();
  });
});

describe("BinanceFair", () => {
  // 40 s phẳng: Binance cao hơn SoDEX đều 2 bp (chênh lệch nền).
  const setup = () => {
    const sent: MmFairMessage[] = [];
    const f = new BinanceFair((m) => sent.push(m));
    f.setMarkets(["BTC-USD"]);
    for (let t = 0; t <= 40_000; t += 1_000) {
      f.onSodex("BTC-USD", "99999", "100001", t);
      f.onBinance("BTC-USD", "100019", "100021", t + 1, t);
    }
    return { f, sent };
  };

  it("waits for 30 samples of the usual gap, then sends the Binance price in SoDEX terms", () => {
    const { sent } = setup();
    expect(sent[0]?.at).toBe(29_000);
    // Binance 100020 chia cho nền 2 bp → 100000.
    expect(Number(sent[0]?.fair)).toBeCloseTo(100_000, 3);
  });

  it("sends again only on a move of 0.25 bp or more, or after 2 s as a heartbeat", () => {
    const { f, sent } = setup();
    const n = sent.length;
    f.onBinance("BTC-USD", "100020", "100022", 40_301, 40_300);
    expect(sent).toHaveLength(n);
    f.onBinance("BTC-USD", "100022", "100024", 40_601, 40_600);
    expect(sent).toHaveLength(n + 1);
    expect(Number(sent.at(-1)?.fair)).toBeCloseTo(100_003, 0);
    expect(sent.at(-1)?.T).toBe(40_601);
  });

  it("forgets a market that is no longer watched", () => {
    const { f, sent } = setup();
    f.setMarkets([]);
    const n = sent.length;
    f.onBinance("BTC-USD", "100100", "100102", 50_001, 50_000);
    expect(sent).toHaveLength(n);
  });
});

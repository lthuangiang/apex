import { describe, expect, it } from "vitest";

import { arbPairs, marketItems, matchRank, searchKey } from "../pickers";

const m = (
  name: string,
  engine: "spot" | "perps",
  displayName: string,
  extra: { last?: string | null; trading?: boolean } = {},
) => ({
  name,
  engine,
  displayName,
  base: null,
  quote: null,
  tickSize: "0.01",
  stepSize: "0.001",
  trading: extra.trading ?? true,
  minNotional: "5",
  maxLeverage: engine === "perps" ? 20 : null,
  last: extra.last ?? null,
});

const labels = { popular: "Popular", quote: (q: string) => `${q} markets` };

describe("picker search (UI_REVIEW G6)", () => {
  it("ignores case, separators and the SoDEX v prefix", () => {
    expect(searchKey("vBTC_vUSDC")).toBe("btcusdc");
    expect(searchKey("BTC/USDC")).toBe("btcusdc");
    const item = { value: "vBTC_vUSDC", label: "BTC/USDC" };
    expect(matchRank(item, "btcusd")).toBe(0);
    expect(matchRank(item, "btc/usdc")).toBe(0);
    expect(matchRank(item, "usdc")).toBe(1);
    expect(matchRank(item, "eth")).toBeNull();
  });
});

describe("marketItems", () => {
  const markets = [
    m("1000BONK-USD", "perps", "1000BONK-USD"),
    m("AAPL-USD", "perps", "AAPL-USD"),
    m("ETH-USD", "perps", "ETH-USD", { last: "3412.5" }),
    m("BTC-USD", "perps", "BTC-USD"),
    m("HALT-USD", "perps", "HALT-USD", { trading: false }),
    m("vBTC_vUSDC", "spot", "BTC/USDC"),
  ];

  it("puts BTC, ETH, SOL first, then A→Z, trading only, with the last price on the right", () => {
    const items = marketItems(markets, "perps", labels);
    expect(items.map((i) => i.value)).toEqual(["BTC-USD", "ETH-USD", "1000BONK-USD", "AAPL-USD"]);
    expect(items.map((i) => i.group)).toEqual(["Popular", "Popular", "USD markets", "USD markets"]);
    expect(items[1]?.secondary).toBe("3,412.50");
    expect(items[0]?.secondary).toBeUndefined();
  });
});

describe("arbPairs (UI_REVIEW G4)", () => {
  it("lists only assets with both a trading spot and perps market, spot USDC first", () => {
    const pairs = arbPairs([
      m("vBTC_vUSDT", "spot", "BTC/USDT"),
      m("vBTC_vUSDC", "spot", "BTC/USDC"),
      m("BTC-USD", "perps", "BTC-USD"),
      m("vXYZ_vUSDC", "spot", "XYZ/USDC"),
      m("ETH-USD", "perps", "ETH-USD"),
    ]);
    expect([...pairs.keys()]).toEqual(["BTC"]);
    expect(pairs.get("BTC")?.spot.name).toBe("vBTC_vUSDC");
    expect(pairs.get("BTC")?.perp.name).toBe("BTC-USD");
  });
});

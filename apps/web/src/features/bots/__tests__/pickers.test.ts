import { describe, expect, it } from "vitest";

import { arbPairs, marketItems, matchRank, rankArbChoices, searchKey } from "../pickers";

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

describe("rankArbChoices (DEC-160)", () => {
  const pairs = arbPairs([
    m("vBTC_vUSDC", "spot", "BTC/USDC"),
    m("BTC-USD", "perps", "BTC-USD"),
    m("vGOOGL_vUSDC", "spot", "GOOGL/USDC"),
    m("GOOGL-USD", "perps", "GOOGL-USD"),
    m("vXLM_vUSDC", "spot", "XLM/USDC"),
    m("XLM-USD", "perps", "XLM-USD"),
    m("vSOL_vUSDC", "spot", "SOL/USDC"),
    m("SOL-USD", "perps", "SOL-USD"),
  ]);
  const stats = {
    perps: [
      { market: "BTC-USD", intervalHours: 1, avg7dPct: "0.0011", periods7d: 168, positive21: 21 },
      { market: "GOOGL-USD", intervalHours: 1, avg7dPct: "0.0038", periods7d: 168, positive21: 21 },
      { market: "XLM-USD", intervalHours: 1, avg7dPct: "-0.0001", periods7d: 168, positive21: 4 },
    ],
    spotVolume24h: { vGOOGL_vUSDC: "692" },
  };

  it("puts assets whose past funding covered the fees fastest first", () => {
    const ranked = rankArbChoices(pairs, stats, 10);
    expect(ranked.map((c) => [c.asset, c.fit.eligible])).toEqual([
      ["GOOGL", true],
      ["BTC", false],
      // Funding âm và chưa có dữ liệu đều không có số giờ: theo thứ tự phổ biến.
      ["SOL", false],
      ["XLM", false],
    ]);
    expect(ranked[0]?.fit.breakEvenHours).toBeCloseTo(32.6, 1);
    expect(ranked[0]?.spotVolume24h).toBe("692");
    // Không có dữ liệu funding: không bao giờ đạt, không có số giờ.
    expect(ranked[2]).toMatchObject({ avg7dPct: null, fit: { breakEvenHours: null } });
  });

  it("uses the user's builder fee for the fee math (DEC-159)", () => {
    const free = rankArbChoices(pairs, stats, 0).find((c) => c.asset === "BTC");
    // 0.094% / 0.0011% ≈ 85 h, vẫn trên 72 h.
    expect(free?.fit.breakEvenHours).toBeCloseTo(85.5, 1);
  });

  it("keeps popular order while funding is loading", () => {
    expect(rankArbChoices(pairs, undefined, 10).map((c) => c.asset)).toEqual([
      "BTC",
      "SOL",
      "GOOGL",
      "XLM",
    ]);
  });
});

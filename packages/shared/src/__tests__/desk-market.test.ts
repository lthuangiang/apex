import { describe, expect, it } from "vitest";

import {
  buildPrompt,
  checkNumbers,
  intentOf,
  marketFacts,
  marketsForFacts,
  marketToday,
  moodOf,
} from "../desk/ai";

// Market today cho Desk AI (DEC-211): fact từ 24 nến 1h SoDEX, cửa sổ 24h trượt; thiếu dữ liệu thì bỏ fact.

const H = 3_600_000;
// SoDEX trả mới nhất trước: nến đầu (cũ nhất) mở ở 100, cao nhất 106, thấp nhất 98.
const candles = [
  { t: 2 * H, o: "103", h: "106", l: "102" },
  { t: 1 * H, o: "101", h: "104", l: "98" },
  { t: 0, o: "100", h: "102", l: "99" },
];

describe("market facts", () => {
  it("computes the 24h change from the oldest open, the range, and a USDC price", () => {
    const f = marketFacts({ market: "BTC-USD", price: "104.5", candles, quote: "USDC" });
    expect(f.map((x) => [x.id, x.value, x.unit, x.market])).toEqual([
      ["market_change_24h_pct:BTC-USD", "4.5", "pct", "BTC-USD"],
      ["market_range_24h_pct:BTC-USD", "8.16", "pct", "BTC-USD"],
      ["market_price:BTC-USD", "104.5", "usdc", "BTC-USD"],
    ]);
    // Tên market là dữ liệu hệ thống, không phải văn bản user.
    expect(f.every((x) => x.bot === null)).toBe(true);
  });

  it("drops the price when the quote isn't USDC, and every fact it can't compute", () => {
    expect(
      marketFacts({ market: "vBTC_vUSDC", price: "104.5", candles, quote: "vUSDC" }).map(
        (x) => x.key,
      ),
    ).toEqual(["market_change_24h_pct", "market_range_24h_pct"]);
    expect(
      marketFacts({ market: "BTC-USD", price: null, candles, quote: "USDC" }).map((x) => x.key),
    ).toEqual(["market_range_24h_pct"]);
    // SoDEX lỗi: không có nến, không có giá → không có fact nào (không bao giờ ghi 0).
    expect(marketFacts({ market: "BTC-USD", price: null, candles: [], quote: null })).toEqual([]);
  });

  it("picks running bots' markets first, without duplicates, at most 5", () => {
    expect(
      marketsForFacts([
        { market: "ETH-USD", state: "paused" },
        { market: "BTC-USD", state: "running" },
        { market: "BTC-USD", state: "paused" },
        { market: "A-USD", state: "paused" },
        { market: "B-USD", state: "paused" },
        { market: "C-USD", state: "paused" },
        { market: "D-USD", state: "running" },
      ]),
    ).toEqual(["BTC-USD", "D-USD", "ETH-USD", "A-USD", "B-USD"]);
  });

  it("sends market facts with their market name and lets only their numbers through", () => {
    const f = marketFacts({ market: "BTC-USD", price: "104.5", candles, quote: "USDC" });
    const p = buildPrompt("How's the market today?", f);
    expect(p.user).toContain('"market":"BTC-USD"');
    expect(p.user).not.toContain("userText");
    expect(p.system).toContain("describe them, never predict");
    expect(checkNumbers("BTC moved 4.5% with an 8.16% range.", f, "").ok).toBe(true);
    expect(checkNumbers("BTC moved 9% today.", f, "").ok).toBe(false);
  });

  it("answers market questions, but still refuses predictions", () => {
    expect(intentOf("How's the market today?")).toBe("market");
    expect(intentOf("Is the market volatile?")).toBe("market");
    expect(intentOf("Will the market go up tomorrow?")).toBe("out_of_scope");
    expect(intentOf("Predict the BTC price")).toBe("out_of_scope");
  });
});

describe("Market today card", () => {
  it("labels sideways below 2% and jumpy above 6%, nothing at or between the edges", () => {
    expect(moodOf("1.99")).toBe("sideways");
    expect(moodOf("2")).toBeNull();
    expect(moodOf("6")).toBeNull();
    expect(moodOf("6.01")).toBe("jumpy");
  });

  it("relates the mood to the user's own bots only when the kind fits, at most 3 lines", () => {
    const f = (market: string, range: string, change = "0.5") => [
      ...marketFacts({ market, price: null, candles: [], quote: null }),
      {
        id: `market_range_24h_pct:${market}`,
        key: "market_range_24h_pct" as const,
        bot: null,
        market,
        value: range,
        unit: "pct" as const,
        source: "sodex_klines",
      },
      {
        id: `market_change_24h_pct:${market}`,
        key: "market_change_24h_pct" as const,
        bot: null,
        market,
        value: change,
        unit: "pct" as const,
        source: "sodex_klines",
      },
    ];
    const lines = marketToday(
      [...f("ETH-USD", "1.4"), ...f("BTC-USD", "7.2"), ...f("SOL-USD", "4"), ...f("XRP-USD", "1")],
      new Map([
        ["ETH-USD", ["spot_grid"]],
        ["BTC-USD", ["volume_farm"]],
        ["SOL-USD", ["volume_farm"]],
      ]),
    );
    expect(lines.map((l) => [l.market, l.mood, l.relation])).toEqual([
      ["ETH-USD", "sideways", "grid"],
      ["BTC-USD", "jumpy", "volume"],
      ["SOL-USD", null, null],
    ]);
    // Sideways nhưng user không có bot grid: chỉ nhãn + số.
    expect(
      marketToday(f("ETH-USD", "1.4"), new Map([["ETH-USD", ["volume_farm"]]]))[0]?.relation,
    ).toBeNull();
  });
});

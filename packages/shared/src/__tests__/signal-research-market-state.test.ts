import { describe, expect, it } from "vitest";

import { dec, Decimal } from "../money";
import { typicalMovePct } from "../signal-research/logic";
import {
  btcTrendOf,
  hourlyMovesPct,
  marketGroupsOf,
  MARKET_STATE_RULES,
  pctChange,
  volatilityOf,
  volWindowComplete,
} from "../signal-research/market-state";

// Trạng thái thị trường lúc quyết định (Catalyst P0, #376): ngưỡng ở biên, thiếu dữ liệu → null, nhóm < 30 không có
// trung bình.

const HOUR = 3_600_000;

describe("BTC trend", () => {
  it("is up above +1.5%, down below −1.5%, flat in between and exactly at ±1.5%", () => {
    expect(btcTrendOf(dec("1.5"))).toBe("flat");
    expect(btcTrendOf(dec("1.5000001"))).toBe("up");
    expect(btcTrendOf(dec("-1.5"))).toBe("flat");
    expect(btcTrendOf(dec("-1.5000001"))).toBe("down");
    expect(btcTrendOf(dec("0"))).toBe("flat");
    expect(btcTrendOf(null)).toBeNull();
  });

  it("measures the signed % change, null when a price is missing", () => {
    expect(pctChange("100", "101.5")?.toFixed()).toBe("1.5");
    expect(pctChange("100", "98")?.toFixed()).toBe("-2");
    expect(pctChange(null, "100")).toBeNull();
    expect(pctChange("100", null)).toBeNull();
    expect(pctChange("0", "100")).toBeNull();
  });
});

describe("volatility", () => {
  /**
   * `below` mẫu nhỏ hơn giá trị hiện tại (1), một mẫu bằng nó, còn lại lớn hơn; tổng cộng cả giá trị hiện tại = 300. Hạng
   * giữa = (below + 2 ÷ 2) ÷ 300.
   */
  const history = (below: number) => [
    ...Array.from({ length: below }, () => dec("0.5")),
    dec("1"),
    ...Array.from({ length: 298 - below }, () => dec("2")),
  ];

  it("is low below the 33rd percentile, normal at exactly 33 and 67, high above 67", () => {
    // Hạng giữa: 98 / 300 = 32.67; 99 / 300 = 33.00; 201 / 300 = 67.00; 202 / 300 = 67.33.
    expect(volatilityOf(dec("1"), history(97))).toMatchObject({
      state: "low",
      percentile: 32.6667,
    });
    expect(volatilityOf(dec("1"), history(98))).toMatchObject({ state: "normal", percentile: 33 });
    expect(volatilityOf(dec("1"), history(200))).toMatchObject({ state: "normal", percentile: 67 });
    expect(volatilityOf(dec("1"), history(201))).toMatchObject({
      state: "high",
      percentile: 67.3333,
    });
  });

  it("needs ≥ 90% of the 240 one-minute candles in the 4 h window and some trading, else Not available", () => {
    expect(volWindowComplete({ candles: 240, volume: "12" })).toBe(true);
    expect(volWindowComplete({ candles: 216, volume: "1" })).toBe(true);
    expect(volWindowComplete({ candles: 215, volume: "1" })).toBe(false);
    expect(volWindowComplete({ candles: 240, volume: "0" })).toBe(false);
    expect(volWindowComplete({ candles: 0, volume: null })).toBe(false);
  });

  it("is null without the current move or with too little history", () => {
    expect(volatilityOf(null, history(150))).toBeNull();
    const short = Array.from({ length: MARKET_STATE_RULES.volMinSamples - 1 }, () => dec("1"));
    expect(volatilityOf(dec("1"), short)).toBeNull();
  });

  it("pairs hourly closes exactly H hours apart, the same way as Decide's typical move", () => {
    const closes = [
      { hour: 0, close: "100" },
      { hour: 4 * HOUR, close: "102" },
      { hour: 5 * HOUR, close: "99" },
      { hour: 9 * HOUR, close: "99" },
    ];
    expect(hourlyMovesPct(closes, 4).map((d) => d.toFixed())).toEqual(["2", "0"]);
    // typicalMovePct dùng chung cách ghép cặp: kết quả không đổi so với trước khi tách hàm.
    const many = Array.from({ length: 400 }, (_, i) => ({
      hour: i * HOUR,
      close: i % 2 === 0 ? "100" : "101",
    }));
    expect(typicalMovePct(many, 1)?.toFixed()).toBe(
      (() => {
        const xs = hourlyMovesPct(many, 1).sort((a, b) => a.cmp(b));
        const m = Math.floor(xs.length / 2);
        const hi = xs[m] ?? new Decimal(0);
        const lo = xs[m - 1] ?? new Decimal(0);
        return xs.length % 2 === 1 ? hi.toFixed() : hi.add(lo).div(2).toFixed();
      })(),
    );
  });
});

describe("result split by market state", () => {
  it("shows an average only for groups with 30 closed trades", () => {
    type K = "up" | "flat" | "down";
    const obs = (key: K, n: number, v: string) =>
      Array.from({ length: n }, (_, i) => ({ key, obs: { v: dec(v), at: i * HOUR } }));
    const g = marketGroupsOf<K>(
      ["up", "flat", "down"],
      [...obs("up", 30, "1"), ...obs("down", 29, "2")],
    );
    expect(g.map((x) => [x.key, x.closed, x.avgPct?.toFixed() ?? null, x.need])).toEqual([
      ["up", 30, "1", 0],
      ["flat", 0, null, 30],
      ["down", 29, null, 1],
    ]);
  });
});

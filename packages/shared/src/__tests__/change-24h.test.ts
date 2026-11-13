import { describe, expect, it } from "vitest";

import { byTime, change24hPct } from "../analysis/change-24h";

// % đổi giá 24 giờ (Watchlist, Market today): SoDEX trả nến mới nhất trước, phải dùng giá mở của nến cũ nhất.

const H = 3_600_000;

describe("24h change", () => {
  it("uses the oldest candle's open, whatever the order SoDEX returns", () => {
    const newestFirst = [
      { t: 23 * H, o: "109" },
      { t: 12 * H, o: "104" },
      { t: 0, o: "100" },
    ];
    expect(change24hPct("110", newestFirst)).toBe("10");
    expect(change24hPct("110", [...newestFirst].reverse())).toBe("10");
    // Lỗi cũ: lấy phần tử đầu (nến mới nhất) cho ra % của khoảng một giờ.
    expect(change24hPct("110", newestFirst)).not.toBe("0.92");
  });

  it("returns null without a price, candles or a usable open", () => {
    expect(change24hPct(null, [{ t: 0, o: "100" }])).toBeNull();
    expect(change24hPct("100", [])).toBeNull();
    expect(change24hPct("100", [{ t: 0, o: "0" }])).toBeNull();
  });

  it("sorts candles oldest first for the sparkline without changing the input", () => {
    const k = [
      { t: 2, o: "c" },
      { t: 1, o: "b" },
    ];
    expect(byTime(k).map((c) => c.o)).toEqual(["b", "c"]);
    expect(k.map((c) => c.o)).toEqual(["c", "b"]);
  });
});

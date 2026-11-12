import { describe, expect, it } from "vitest";

import { fromConfig, toConfig } from "../../bots/fields";
import { addr, ago, base, usd } from "../format";

// Copy Trading (DEC-163): số hiển thị theo artboard và form sửa bot copy giữ đúng danh sách market.

describe("copy format", () => {
  it("formats USD like the artboards and never invents a value", () => {
    expect(usd("84120", true)).toBe("+$84,120");
    expect(usd("-9800")).toBe("−$9,800");
    expect(usd("0", true)).toBe("$0");
    expect(usd(null)).toBeNull();
  });

  it("shortens addresses and markets", () => {
    expect(addr("0x3e9a000000000000000000000000000000011fd0")).toBe("0x3e9a…1fd0");
    expect(base("1000PEPE-USD")).toBe("1000PEPE");
  });

  it("says how long ago in short words", () => {
    const now = Date.parse("2026-11-11T12:00:00Z");
    expect(ago("2026-11-11T11:26:00Z", now)).toBe("34 min. ago");
    expect(ago("2026-11-10T12:00:00Z", now)).toBe("yesterday");
  });
});

describe("copy bot edit form", () => {
  it("keeps every market of a multi-market copy bot through edit and save", () => {
    const v = fromConfig("copy_trade", {
      leaderSource: "hyperliquid",
      leaderAddress: "0xabc",
      markets: ["BTC-USD", "ETH-USD"],
      leverage: 2,
    });
    expect(v.markets).toBe("BTC-USD,ETH-USD");
    expect(toConfig("copy_trade", v).markets).toEqual(["BTC-USD", "ETH-USD"]);
  });

  it("reads an old single-market config into the markets list", () => {
    expect(fromConfig("copy_trade", { market: "BTC-USD" }).markets).toBe("BTC-USD");
  });
});

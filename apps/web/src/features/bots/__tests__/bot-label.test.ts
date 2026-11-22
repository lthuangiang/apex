import { describe, expect, it } from "vitest";

import { botMarket } from "../bot-label";

// #472: bot nhiều market (`market` rỗng, ví dụ bot Signal Research) hiện "Multi-market", không bao giờ để trống.

const names = Object.assign((m: string) => m, {
  market: (m: string) => `M:${m}`,
  asset: (a: string) => a,
  info: () => undefined,
  qtyDigits: () => 4,
  priceDigits: () => 2,
}) as unknown as Parameters<typeof botMarket>[1];

const bot = (market: string, marketLabel: string | null = null) => ({
  market,
  marketLabel,
  capital: null,
  capitalUnit: "quote" as const,
});

describe("botMarket", () => {
  it("uses the market label first, then the market name", () => {
    expect(botMarket(bot("BTC-USD", "BTC · ETH · USDC"), names, "Multi-market")).toBe(
      "BTC · ETH · USDC",
    );
    expect(botMarket(bot("BTC-USD"), names, "Multi-market")).toBe("M:BTC-USD");
  });

  it("an empty market reads Multi-market", () => {
    expect(botMarket(bot(""), names, "Multi-market")).toBe("Multi-market");
  });
});

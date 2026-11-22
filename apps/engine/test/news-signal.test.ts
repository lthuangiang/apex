import type { NewsSignalRow } from "@drift/db";
import { NewsEntryBlock } from "@drift/shared";
import type { NewsTrade, OrderIntent } from "@drift/strategies";
import { describe, expect, it } from "vitest";

import {
  isUniqueViolation,
  NEWS_ACCOUNT_MARKET_UNIQUE,
  newsLeverageKey,
  newsOpenBlocked,
  newsSignalInput,
  newsTradeRow,
} from "../src/news-signal";

// Phần thuần của engine A cho bot `news_signal` (#419): chốt lệnh mở (lớp engine của trần 200 USDC), dòng
// `news_signal_trades`, chuyển tín hiệu DB → chiến lược.

const entry = (over: Partial<OrderIntent> = {}): OrderIntent => ({
  clOrdID: "c1",
  market: "SOL-USD",
  engine: "perps",
  side: "buy",
  type: "limit",
  price: "100.3",
  quantity: "1.99",
  timeInForce: "IOC",
  reduceOnly: false,
  tag: "ns:s1:entry",
  ...over,
});

const withoutPrice = (): OrderIntent => {
  const o: Partial<OrderIntent> = entry();
  delete o.price;
  return o as OrderIntent;
};

describe("newsOpenBlocked", () => {
  it("lets a limit IOC Perps entry at or under 200 USDC through", () => {
    expect(newsOpenBlocked(entry())).toBeNull();
    expect(newsOpenBlocked(entry({ price: "100", quantity: "2" }))).toBeNull();
  });

  it("NEWS_CAP_EXCEEDED only when price × quantity is above 200 USDC", () => {
    for (const o of [entry({ price: "100.01", quantity: "2" }), entry({ quantity: "1000" })])
      expect(newsOpenBlocked(o)).toBe(NewsEntryBlock.capExceeded);
  });

  it("NEWS_ORDER_INVALID for a market / GTC / Spot opening order, a missing price or a zero price / size (PM, engine B)", () => {
    for (const o of [
      entry({ type: "market" }),
      entry({ timeInForce: "GTC" }),
      entry({ engine: "spot" }),
      withoutPrice(),
      entry({ price: "0" }),
      entry({ quantity: "0" }),
      // Sai loại thắng vượt trần: lệnh market cỡ lớn vẫn là NEWS_ORDER_INVALID.
      entry({ type: "market", quantity: "1000" }),
    ])
      expect(newsOpenBlocked(o)).toBe(NewsEntryBlock.orderInvalid);
  });

  it("never blocks reduce-only orders (TP, SL, closes)", () => {
    expect(newsOpenBlocked(entry({ reduceOnly: true, type: "market", quantity: "1000" }))).toBe(
      null,
    );
  });
});

describe("news rows", () => {
  it("maps a signal row, keeping a missing quote as null", () => {
    const row = {
      id: "s1",
      storyKey: "k",
      market: "SOL-USD",
      kind: "crypto",
      catalyst: "listing",
      side: "short",
      level: "medium",
      firstPublishedAt: new Date(1_000),
      collectedAt: new Date(2_000),
      decidedAt: new Date(3_000),
      expiresAt: new Date(123_000),
      quoteBid: null,
      quoteAsk: null,
      quoteMid: null,
      quoteAt: null,
      typicalByHoldHours: { "24": "3", "48": null },
    } as unknown as NewsSignalRow;
    expect(newsSignalInput(row)).toEqual({
      id: "s1",
      storyKey: "k",
      market: "SOL-USD",
      kind: "crypto",
      catalyst: "listing",
      side: "short",
      level: "medium",
      firstPublishedAt: 1_000,
      collectedAt: 2_000,
      decidedAt: 3_000,
      expiresAt: 123_000,
      quote: null,
      typicalByHoldHours: { "24": "3", "48": null },
    });
  });

  it("builds a trade row: no fill = no entry price (never 0), closed carries its reason", () => {
    const t = {
      signalId: "s1",
      seq: 4,
      market: "SOL-USD",
      side: "long",
      status: "entering",
      sizeUsdc: "200",
      entryLimit: "100.3",
      filled: "0",
      filledNotional: "0",
      tp: null,
      sl: null,
      tpslSeq: 0,
      openedAt: 10_000,
      maxHoldUntil: 20_000,
      maxHoldOff: false,
      closedAt: null,
      closeReason: null,
    } as unknown as NewsTrade;
    expect(newsTradeRow("b1", "a1", t, 15_000)).toMatchObject({
      status: "open",
      qty: "0",
      entryAvgPrice: null,
      closedAt: null,
      closeReason: null,
      exitAvgPrice: null,
    });
    const filled = { ...t, status: "open", filled: "2", filledNotional: "200.4" } as NewsTrade;
    expect(newsTradeRow("b1", "a1", filled, 15_000).entryAvgPrice).toBe("100.2");
    const closed = {
      ...t,
      status: "closed",
      closedAt: 12_000,
      closeReason: "ENTRY_NOT_FILLED",
    } as NewsTrade;
    expect(newsTradeRow("b1", "a1", closed, 15_000)).toMatchObject({
      status: "closed",
      closedAt: new Date(12_000),
      closeReason: "ENTRY_NOT_FILLED",
    });
  });

  it("recognises only the account × market unique violation, also when wrapped", () => {
    const pg = { code: "23505", constraint: NEWS_ACCOUNT_MARKET_UNIQUE };
    expect(isUniqueViolation(pg, NEWS_ACCOUNT_MARKET_UNIQUE)).toBe(true);
    expect(isUniqueViolation({ cause: pg }, NEWS_ACCOUNT_MARKET_UNIQUE)).toBe(true);
    expect(
      isUniqueViolation({ code: "23505", constraint: "other" }, NEWS_ACCOUNT_MARKET_UNIQUE),
    ).toBe(false);
    expect(isUniqueViolation(new Error("x"), NEWS_ACCOUNT_MARKET_UNIQUE)).toBe(false);
    expect(newsLeverageKey("SOL-USD")).toBe("SOL-USD:1:isolated");
  });
});

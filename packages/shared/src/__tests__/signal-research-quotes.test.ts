import { describe, expect, it } from "vitest";

import { dec } from "../money";
import { unrealizedUsdc } from "../signal-research/display";
import {
  exitPriceOf,
  parseSrQuotes,
  srQuoteFresh,
  srQuotesSnapshot,
  type SrQuote,
} from "../signal-research/quotes";
import { NEWS_RULES } from "../signal-research/rules";

const NOW = 1_800_000_000_000;
const book = (over: Partial<SrQuote> = {}): SrQuote => ({
  bid: "99.9",
  ask: "100.1",
  source: "book",
  at: NOW - 1_000,
  ...over,
});

describe("#308 exit price for unrealized PnL", () => {
  it("Long closes on the bid, Short on the ask (never mid / last)", () => {
    expect(exitPriceOf("long", book(), NOW)?.toFixed()).toBe("99.9");
    expect(exitPriceOf("short", book(), NOW)?.toFixed()).toBe("100.1");
  });

  it("a book older than NEWS_RULES.bookFreshMs is skipped (null, never the old price)", () => {
    expect(exitPriceOf("long", book({ at: NOW - NEWS_RULES.bookFreshMs }), NOW)?.toFixed()).toBe(
      "99.9",
    );
    expect(exitPriceOf("long", book({ at: NOW - NEWS_RULES.bookFreshMs - 1 }), NOW)).toBeNull();
    expect(exitPriceOf("short", book({ at: NOW - 60_000 }), NOW)).toBeNull();
  });

  it("last price ± half spread uses NEWS_RULES.lastPriceFreshMs", () => {
    const at = NOW - NEWS_RULES.lastPriceFreshMs;
    expect(srQuoteFresh({ source: "last_spread", at }, NOW)).toBe(true);
    expect(srQuoteFresh({ source: "last_spread", at: at - 1 }, NOW)).toBe(false);
    expect(srQuoteFresh({ source: "book", at }, NOW)).toBe(false);
  });

  it("no quote or a broken book (ask < bid) → null", () => {
    expect(exitPriceOf("long", undefined, NOW)).toBeNull();
    expect(exitPriceOf("long", null, NOW)).toBeNull();
    expect(exitPriceOf("long", book({ bid: "101", ask: "100" }), NOW)).toBeNull();
  });

  it("unrealized PnL of a Long uses the bid, a Short the ask", () => {
    const base = {
      entryPrice: "100",
      qty: "1",
      sizeUsdc: "100",
      entryFee: "0.05",
      feePct: "0.05",
    };
    const q = book({ bid: "101", ask: "102" });
    // Long: 1 × (101 − 100) − 0.05 − 101 × 0.05% = 0.8995
    expect(
      unrealizedUsdc({ ...base, direction: "long" }, exitPriceOf("long", q, NOW))?.toFixed(),
    ).toBe("0.8995");
    // Short: 1 × (100 − 102) − 0.05 − 102 × 0.05% = −2.101
    expect(
      unrealizedUsdc({ ...base, direction: "short" }, exitPriceOf("short", q, NOW))?.toFixed(),
    ).toBe("-2.101");
    expect(
      unrealizedUsdc(
        { ...base, direction: "long" },
        exitPriceOf("long", book({ at: NOW - 6_000 }), NOW),
      ),
    ).toBeNull();
  });
});

describe("#308 sr:quotes snapshot", () => {
  it("round-trips through Redis text; quotes without a data time are left out", () => {
    const snap = srQuotesSnapshot(
      new Map([
        ["ETH-USD", { bid: dec("3500"), ask: dec("3500.5"), source: "book" as const, at: NOW }],
        ["SOL-USD", { bid: dec("1"), ask: dec("1.1"), source: "book" as const }],
      ]),
    );
    expect(snap).toEqual({
      "ETH-USD": { bid: "3500", ask: "3500.5", source: "book", at: NOW },
    });
    expect(parseSrQuotes(JSON.stringify(snap))).toEqual({
      quotes: snap,
      invalid: [],
      broken: false,
    });
  });

  it("a bad entry drops only that market; the others keep their price", () => {
    const good = { bid: "3500", ask: "3500.5", source: "book", at: NOW };
    const p = parseSrQuotes(
      JSON.stringify({
        "ETH-USD": good,
        "SOL-USD": { bid: "1", source: "book", at: 1 },
        "BTC-USD": { bid: "0", ask: "1", source: "book", at: 1 },
        "XRP-USD": "nope",
        // Chuỗi không phải số không được làm hỏng cả bản chụp.
        "ADA-USD": { bid: "abc", ask: "1", source: "book", at: 1 },
      }),
    );
    expect(p).toEqual({
      quotes: { "ETH-USD": good },
      invalid: ["SOL-USD", "BTC-USD", "XRP-USD", "ADA-USD"],
      broken: false,
    });
    expect(exitPriceOf("long", p.quotes["ETH-USD"], NOW)?.toFixed()).toBe("3500");
    expect(exitPriceOf("long", p.quotes["SOL-USD"], NOW)).toBeNull();
  });

  it("only an unreadable value (not JSON / not an object) means no quotes at all", () => {
    const none = { quotes: {}, invalid: [], broken: true };
    expect(parseSrQuotes(null)).toEqual({ quotes: {}, invalid: [], broken: false });
    expect(parseSrQuotes("{not json")).toEqual(none);
    expect(parseSrQuotes("[]")).toEqual(none);
    expect(parseSrQuotes("null")).toEqual(none);
    expect(parseSrQuotes('"x"')).toEqual(none);
  });
});

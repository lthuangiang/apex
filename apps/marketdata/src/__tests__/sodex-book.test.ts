import type { MmBookMessage } from "@drift/shared";
import { describe, expect, it } from "vitest";

import { SodexBookRelay } from "../sodex-book";

describe("SodexBookRelay (DEC-248)", () => {
  it("publishes only markets with a Market Making bot, and only when the best price changes", () => {
    const sent: MmBookMessage[] = [];
    const relay = new SodexBookRelay((m) => sent.push(m));
    relay.onSodex("BTC-USD", "100", "101", 1, 2);
    expect(sent).toHaveLength(0);
    relay.setMarkets(["BTC-USD"]);
    relay.onSodex("BTC-USD", "100", "101", 1, 2);
    relay.onSodex("BTC-USD", "100", "101", 3, 4);
    relay.onSodex("ETH-USD", "10", "11", 3, 4);
    relay.onSodex("BTC-USD", "100", "102", 5, 6);
    expect(sent).toEqual([
      { s: "BTC-USD", b: "100", a: "101", E: 1, at: 2 },
      { s: "BTC-USD", b: "100", a: "102", E: 5, at: 6 },
    ]);
  });

  it("forgets a market when its bots stop, so a restart publishes the price again", () => {
    const sent: MmBookMessage[] = [];
    const relay = new SodexBookRelay((m) => sent.push(m));
    relay.setMarkets(["BTC-USD"]);
    relay.onSodex("BTC-USD", "100", "101", 1, 2);
    relay.setMarkets([]);
    relay.setMarkets(["BTC-USD"]);
    relay.onSodex("BTC-USD", "100", "101", 3, 4);
    expect(sent).toHaveLength(2);
  });

  it("re-sends an unchanged price at most once a second, marked refresh (DEC-298)", () => {
    const sent: MmBookMessage[] = [];
    const relay = new SodexBookRelay((m) => sent.push(m));
    relay.setMarkets(["ETH-USD"]);
    relay.onSodex("ETH-USD", "10", "11", 1, 1_000);
    relay.onSodex("ETH-USD", "10", "11", 2, 1_500);
    relay.onSodex("ETH-USD", "10", "11", 3, 2_000);
    relay.onSodex("ETH-USD", "10", "11", 4, 2_400);
    relay.onSodex("ETH-USD", "10", "12", 5, 2_500);
    expect(sent).toEqual([
      { s: "ETH-USD", b: "10", a: "11", E: 1, at: 1_000 },
      { s: "ETH-USD", b: "10", a: "11", E: 3, at: 2_000, refresh: true },
      { s: "ETH-USD", b: "10", a: "12", E: 5, at: 2_500 },
    ]);
  });
});

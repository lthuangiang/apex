import { describe, expect, it } from "vitest";

import { checkNumbers, deskAiFacts, intentOf, marketsInQuestion } from "../desk/ai";
import type { DeskAiFact } from "../desk/ai";

// Câu hỏi thật của người dùng trên prod (2026-11-13): "How BTC today?", "Which strategy fits a sideways market?".

const LISTED = ["BTC-USD", "ETH-USD", "SOL-USD", "ONE-USD", "AI-USD", "1000PEPE-USD"];

describe("marketsInQuestion", () => {
  it("finds coins named in the question", () => {
    expect(marketsInQuestion("How BTC today?", LISTED)).toEqual(["BTC-USD"]);
    expect(marketsInQuestion("is eth or sol more jumpy", LISTED)).toEqual(["ETH-USD", "SOL-USD"]);
    expect(marketsInQuestion("How is ETH-USD doing", LISTED)).toEqual(["ETH-USD"]);
  });

  it("ignores common words unless written in capitals, and the name Desk AI", () => {
    expect(marketsInQuestion("how is my one bot doing", LISTED)).toEqual([]);
    expect(marketsInQuestion("Hi Desk AI, how is ONE?", LISTED)).toEqual(["ONE-USD"]);
    expect(marketsInQuestion("Ask Desk AI about this", LISTED)).toEqual([]);
  });

  it("returns nothing for coins not listed on SoDEX", () => {
    expect(marketsInQuestion("How is DOGE today?", LISTED)).toEqual([]);
  });
});

describe("intentOf", () => {
  it("treats a coin question as a market question", () => {
    expect(intentOf("How BTC today?", { asksMarket: true })).toBe("market");
    expect(intentOf("How BTC today?")).toBe("general");
  });

  it("answers strategy questions with the strategy list, not market numbers", () => {
    expect(intentOf("Which strategy fits a sideways market?")).toBe("strategy");
  });

  it("still refuses predictions", () => {
    expect(intentOf("Will BTC go up tomorrow?", { asksMarket: true })).toBe("out_of_scope");
  });
});

const fact = (over: Partial<DeskAiFact>): DeskAiFact => ({
  id: "x",
  key: "market_change_24h_pct",
  bot: null,
  market: "BTC-USD",
  value: "1.25",
  unit: "pct",
  source: "sodex_klines",
  ...over,
});

describe("checkNumbers", () => {
  it("allows the 24-hour window, list numbers and knowledge numbers", () => {
    const facts = [fact({})];
    const answer =
      "1. Over the last 24 hours BTC-USD moved 1.25%.\n2. Grids were built for ranges under 2%.";
    expect(checkNumbers(answer, facts)).toEqual({ ok: true, unknown: [] });
  });

  it("allows digits inside a market name", () => {
    const facts = [fact({ market: "1000PEPE-USD" })];
    expect(checkNumbers("1000PEPE-USD moved 1.25% today.", facts).ok).toBe(true);
  });

  it("still rejects invented numbers", () => {
    expect(checkNumbers("BTC could reach 120000 soon.", [fact({})]).unknown).toEqual(["120000"]);
  });
});

describe("deskAiFacts", () => {
  it("numbers bots that share a name", () => {
    const bot = (botId: string) => ({
      botId,
      name: "INTC Futures DCA",
      state: "stopped",
      net: null,
      fees: null,
      maxLoss: null,
      stop: null,
      taker: null,
    });
    const names = deskAiFacts({
      bots: [bot("a"), bot("b")] as unknown as Parameters<typeof deskAiFacts>[0]["bots"],
      goal: null,
      questionsUsed: 0,
    })
      .filter((f) => f.key === "bot_state")
      .map((f) => f.bot);
    expect(names).toEqual(["INTC Futures DCA", "INTC Futures DCA #2"]);
  });
});

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { claudeCostUsd, Decimal, NEWS_CLASSIFIER, NEWS_RULES } from "@drift/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  anthropicClassifier,
  articleUsageValues,
  cacheSelfCheck,
  classifierTool,
  emptyUsage,
  parseAnswer,
  weightedInput,
} from "../src/signal-research/classifier";
import {
  disabledReason,
  parseSignalEnv,
  signalResearchEnvSchema,
} from "../src/signal-research/index";
import { collectFloor } from "../src/signal-research/pipeline";
import {
  combineQuote,
  LiveBooks,
  medianTicks,
  QuoteSource,
  requestRestBook,
  type QuoteDeps,
  type RestBookResult,
} from "../src/signal-research/prices";
import { CLASSIFIER_SYSTEM } from "../src/signal-research/prompt";
import { sosoClient } from "../src/signal-research/soso";

const MIN = 60_000;
const cfg = {
  claudeDailyInputBudget: 1000,
  claudeMaxCallsPerCycle: 50,
  sosoMaxPages: 2,
  sosoMonthlyLimit: 9500,
  startLookbackMinutes: 15,
  maxCatchUpMinutes: 30,
};

describe("collect floor (by our own collection time)", () => {
  const now = Date.parse("2026-11-18T12:00:00Z");
  it("first run starts 15 min back", () => {
    expect(collectFloor(null, now, cfg)).toBe(now - 15 * MIN);
  });
  it("normal run: an article SoSoValue indexes 15 min late is still inside the window", () => {
    // Chu kỳ trước 5 phút trước: mốc dưới = now − 30 phút, nên bài đăng lúc now − 15 phút vẫn được xử lý.
    expect(collectFloor(now - 5 * MIN, now, cfg)).toBe(now - 30 * MIN);
    expect(now - 15 * MIN).toBeGreaterThan(collectFloor(now - 5 * MIN, now, cfg));
  });
  it("after downtime never catches up more than 30 min", () => {
    expect(collectFloor(now - 3 * 60 * MIN, now, cfg)).toBe(now - 30 * MIN);
  });
});

describe("quotes from stored market data only", () => {
  const now = 1_000_000;
  it("uses a fresh SoDEX book first", () => {
    const q = combineQuote({
      now,
      book: { bid: new Decimal("99"), ask: new Decimal("101"), at: now - 1000 },
      last: undefined,
      spread: null,
      tickSize: null,
    });
    expect(typeof q === "object" && q.source).toBe("book");
  });
  it("falls back to last price ± half the hourly median spread", () => {
    const q = combineQuote({
      now,
      book: undefined,
      last: { price: "100", at: now - 2000 },
      spread: { ticks: 2, samples: 500 },
      tickSize: "0.1",
    });
    expect(typeof q === "object" ? [q.bid.toFixed(), q.ask.toFixed(), q.source] : q).toEqual([
      "99.9",
      "100.1",
      "last_spread",
    ]);
  });
  it("no price → NO_SODEX_PRICE; price without book data → NO_BOOK_DATA (never a guessed spread)", () => {
    expect(
      combineQuote({ now, book: undefined, last: undefined, spread: null, tickSize: "0.1" }),
    ).toBe("NO_SODEX_PRICE");
    expect(
      combineQuote({
        now,
        book: undefined,
        last: { price: "100", at: now - 60_000 },
        spread: null,
        tickSize: "0.1",
      }),
    ).toBe("NO_SODEX_PRICE");
    expect(
      combineQuote({
        now,
        book: undefined,
        last: { price: "100", at: now },
        spread: null,
        tickSize: "0.1",
      }),
    ).toBe("NO_BOOK_DATA");
    expect(
      combineQuote({
        now,
        book: undefined,
        last: { price: "100", at: now },
        spread: { ticks: 1, samples: 500 },
        tickSize: null,
      }),
    ).toBe("NO_BOOK_DATA");
  });
  it("#507 D: QuoteSource keeps the book and last price ages of the last read, null when missing", async () => {
    const src = new QuoteSource({
      now: () => now,
      books: {
        get: (m) =>
          m === "BTC-USD"
            ? { bid: new Decimal("1"), ask: new Decimal("2"), at: now - 7_000 }
            : undefined,
      },
      lastPrices: (ms) =>
        Promise.resolve(
          new Map(
            ms.filter((m) => m === "BTC-USD").map((m) => [m, { price: "1.5", at: now - 20_000 }]),
          ),
        ),
      spreadHists: () => Promise.resolve(new Map()),
      tickSize: () => "0.1",
    });
    expect(src.ages("BTC-USD")).toBeUndefined();
    const q = await src.quotes(["BTC-USD", "ETH-USD"]);
    expect(q.get("BTC-USD")).toBe("NO_SODEX_PRICE");
    expect(q.get("ETH-USD")).toBe("NO_SODEX_PRICE");
    expect(src.ages("BTC-USD")).toEqual({ bookAgeMs: 7_000, lastAgeMs: 20_000 });
    expect(src.ages("ETH-USD")).toEqual({ bookAgeMs: null, lastAgeMs: null });
  });
  describe("#507 B1: REST book once through marketdata at the decision step", () => {
    /** Market có giá gần nhất tươi nhưng không có sổ live và không có mẫu spread (đúng như TRX / MON / SPCX trên prod). */
    function source(rest: QuoteDeps["restBook"], over: Partial<QuoteDeps> = {}) {
      return new QuoteSource({
        now: () => now,
        books: { get: () => undefined },
        lastPrices: (ms) =>
          Promise.resolve(new Map(ms.map((m) => [m, { price: "0.3", at: now - 2_000 }]))),
        spreadHists: () => Promise.resolve(new Map()),
        tickSize: () => "0.0001",
        ...(rest === undefined ? {} : { restBook: rest }),
        ...over,
      });
    }

    it("no spread samples + a real REST book → a rest_book quote from the book's best bid / ask", async () => {
      const calls: string[] = [];
      const src = source((m) => {
        calls.push(m);
        return Promise.resolve({ ok: true, bid: "0.2999", ask: "0.3002", at: now - 100 });
      });
      const q = await src.decisionQuote("TRX-USD");
      expect(
        typeof q === "object" ? [q.bid.toFixed(), q.ask.toFixed(), q.source, q.at] : q,
      ).toEqual(["0.2999", "0.3002", "rest_book", now - 100]);
      expect(calls).toEqual(["TRX-USD"]);
      expect(src.diag("TRX-USD")).toMatchObject({
        rest: "ok",
        spreadSamples: null,
        tickSize: true,
      });
    });

    it("REST error / timeout / unavailable / empty / crossed / zero keeps NO_BOOK_DATA with the reason in the diagnosis", async () => {
      const cases: [RestBookResult, string][] = [
        [{ ok: false, reason: "error" }, "error"],
        [{ ok: false, reason: "timeout" }, "timeout"],
        [{ ok: false, reason: "unavailable" }, "unavailable"],
        [{ ok: false, reason: "empty" }, "empty"],
        [{ ok: true, bid: "0.3", ask: "0.3", at: now }, "crossed"],
        [{ ok: true, bid: "0.31", ask: "0.3", at: now }, "crossed"],
        [{ ok: true, bid: "0", ask: "0.3", at: now }, "crossed"],
        [{ ok: true, bid: "x", ask: "0.3", at: now }, "error"],
      ];
      for (const [r, why] of cases) {
        const src = source(() => Promise.resolve(r));
        expect(await src.decisionQuote("MON-USD"), why).toBe("NO_BOOK_DATA");
        expect(src.diag("MON-USD"), why).toEqual({
          bookAgeMs: null,
          lastAgeMs: 2_000,
          spreadSamples: null,
          tickSize: true,
          rest: why,
        });
      }
      const throwing = source(() => Promise.reject(new Error("boom")));
      expect(await throwing.decisionQuote("MON-USD")).toBe("NO_BOOK_DATA");
      expect(throwing.diag("MON-USD")?.rest).toBe("error");
    });

    it("a fresh live book never sends the request; without restBook the reason stays as before", async () => {
      let calls = 0;
      const live = source(
        () => {
          calls += 1;
          return Promise.resolve({ ok: false, reason: "error" });
        },
        {
          books: { get: () => ({ bid: new Decimal("1"), ask: new Decimal("2"), at: now - 1_000 }) },
        },
      );
      const q = await live.decisionQuote("BTC-USD");
      expect(typeof q === "object" && q.source).toBe("book");
      expect(calls).toBe(0);
      expect(live.diag("BTC-USD")?.rest).toBe("not_tried");
      // Không có bước REST: như trước (#507 chỉ thêm khi main nối NATS).
      const off = source(undefined);
      expect(await off.decisionQuote("TRX-USD")).toBe("NO_BOOK_DATA");
      expect(off.diag("TRX-USD")?.rest).toBe("not_tried");
    });

    it("also covers no recent last price (NO_SODEX_PRICE) and keeps that reason when REST has nothing", async () => {
      const stale = { lastPrices: () => Promise.resolve(new Map()) };
      const ok = source(() => Promise.resolve({ ok: true, bid: "1", ask: "1.01", at: now }), stale);
      expect(typeof (await ok.decisionQuote("SPCX-USD"))).toBe("object");
      const none = source(() => Promise.resolve({ ok: false, reason: "empty" }), stale);
      expect(await none.decisionQuote("SPCX-USD")).toBe("NO_SODEX_PRICE");
    });

    it("the watcher path (quotes) never calls REST", async () => {
      let calls = 0;
      const src = source(() => {
        calls += 1;
        return Promise.resolve({ ok: true, bid: "1", ask: "2", at: now });
      });
      expect((await src.quotes(["TRX-USD"])).get("TRX-USD")).toBe("NO_BOOK_DATA");
      expect(calls).toBe(0);
    });

    it("requestRestBook reads marketdata's reply and refuses anything it can't trust", async () => {
      const ok = JSON.stringify({ ok: true, s: "TRX-USD", b: "0.29", a: "0.3", at: 5 });
      expect(await requestRestBook("TRX-USD", () => Promise.resolve(ok))).toEqual({
        ok: true,
        bid: "0.29",
        ask: "0.3",
        at: 5,
      });
      expect(await requestRestBook("MON-USD", () => Promise.resolve(ok))).toEqual({
        ok: false,
        reason: "error",
      });
      expect(await requestRestBook("TRX-USD", () => Promise.resolve("timeout"))).toEqual({
        ok: false,
        reason: "timeout",
      });
      expect(await requestRestBook("TRX-USD", () => Promise.resolve("unavailable"))).toEqual({
        ok: false,
        reason: "unavailable",
      });
      expect(await requestRestBook("TRX-USD", () => Promise.resolve("{bad"))).toEqual({
        ok: false,
        reason: "error",
      });
      expect(
        await requestRestBook("TRX-USD", () =>
          Promise.resolve(JSON.stringify({ ok: false, reason: "empty" })),
        ),
      ).toEqual({ ok: false, reason: "empty" });
      expect(await requestRestBook("TRX-USD", () => Promise.reject(new Error("x")))).toEqual({
        ok: false,
        reason: "error",
      });
      let sent = "";
      await requestRestBook("TRX-USD", (p) => {
        sent = p;
        return Promise.resolve("timeout");
      });
      expect(JSON.parse(sent)).toEqual({ market: "TRX-USD" });
    });
  });
  it("median ticks across hourly histograms", () => {
    expect(medianTicks([{ "1": 10, "2": 3 }, { "3": 5 }])).toEqual({ ticks: 1, samples: 18 });
    expect(medianTicks([])).toBeNull();
  });
  it("live books keep raw messages and parse only on read; malformed ones are ignored", () => {
    const b = new LiveBooks();
    b.onMessage("md.btc-usd.book", "not json", 1);
    expect(b.get("BTC-USD")).toBeUndefined();
    b.onMessage(
      "md.btc-usd.book",
      JSON.stringify({ s: "BTC-USD", b: "1", a: "0.5", E: 1, at: 1 }),
      1,
    );
    expect(b.get("BTC-USD")).toBeUndefined();
    b.onMessage(
      "md.btc-usd.book",
      JSON.stringify({ s: "BTC-USD", b: "1", a: "2", E: 1, at: 1 }),
      5,
    );
    expect(b.get("BTC-USD")?.at).toBe(5);
    b.onMessage(
      "md.1000pepe-usd.book",
      JSON.stringify({ s: "1000PEPE-USD", b: "1", a: "2", E: 1, at: 1 }),
      6,
    );
    expect(b.get("1000PEPE-USD")?.ask.toFixed()).toBe("2");
  });
});

describe("classifier answer", () => {
  const cands = [{ symbol: "SOL", market: "SOL-USD", kind: "crypto" as const }];
  const ok = {
    catalyst: "listing",
    market: "SOL-USD",
    relevance: "direct",
    promotional: false,
    event_date: "2026-11-18",
  };
  it("accepts only fixed choices and candidate markets", () => {
    expect(parseAnswer(ok, cands)).toMatchObject({
      ok: true,
      value: { market: "SOL-USD", eventDate: "2026-11-18" },
    });
    expect(parseAnswer({ ...ok, market: "NONE", event_date: "unknown" }, cands)).toMatchObject({
      ok: true,
      value: { market: null, eventDate: null },
    });
    expect(parseAnswer({ ...ok, market: "BTC-USD" }, cands)).toEqual({
      ok: false,
      error: "market_not_candidate",
    });
    expect(parseAnswer({ ...ok, catalyst: "partnership" }, cands)).toEqual({
      ok: false,
      error: "invalid_answer",
    });
  });
  it("treasury amount: copied as written, unknown / blank / missing → null, never invented", () => {
    const t = { ...ok, catalyst: "treasury_buy" };
    expect(parseAnswer({ ...t, treasury_amount: " $40M " }, cands)).toMatchObject({
      ok: true,
      value: { treasuryAmount: "$40M" },
    });
    for (const amount of ["unknown", "UNKNOWN", "  ", undefined])
      expect(parseAnswer({ ...t, treasury_amount: amount }, cands)).toMatchObject({
        ok: true,
        value: { treasuryAmount: null },
      });
    expect(parseAnswer({ ...t, treasury_amount: 40 }, cands)).toEqual({
      ok: false,
      error: "invalid_answer",
    });
  });
  it("tool: treasury_amount is optional, the other fields stay required", () => {
    const schema = classifierTool(["SOL-USD"]).input_schema as {
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(schema.properties.treasury_amount).toMatchObject({ type: "string" });
    expect(schema.required).toEqual([
      "catalyst",
      "market",
      "relevance",
      "promotional",
      "event_date",
    ]);
  });
  it("budget is in input-equivalent units: cache write 2× (1 h TTL), cache read 0.1×, output 5×", () => {
    expect(weightedInput({ input: 100, cacheWrite: 50, cacheRead: 1000, output: 20 })).toBe(
      100 + 100 + 100 + 100,
    );
  });
  it("cache self-check logs the first call of the day and warns when reads stay 0", () => {
    const infos: object[] = [];
    const warns: object[] = [];
    const check = cacheSelfCheck({ info: (o) => infos.push(o), warn: (o) => warns.push(o) }, () =>
      Date.parse("2026-11-18T10:00:00Z"),
    );
    const u = (cacheWrite: number, cacheRead: number) => ({
      ...emptyUsage(),
      calls: 1,
      cacheWrite,
      cacheRead,
    });
    check(u(4300, 0));
    expect(infos).toEqual([{ cacheWrite: 4300, cacheRead: 0, cachedPrefixTokens: 4300 }]);
    check(u(4300, 0));
    expect(warns).toHaveLength(1);
    check(u(0, 0));
    expect(warns).toHaveLength(1);
    const ok: object[] = [];
    const good = cacheSelfCheck({ info: () => undefined, warn: (o) => ok.push(o) });
    good(u(4300, 0));
    good(u(0, 4300));
    expect(ok).toEqual([]);
  });
});

describe("classifier prompt news-classifier-v5 (#399)", () => {
  it("ships with rules news-v4 (only the prompt changes)", () => {
    expect(NEWS_CLASSIFIER.promptVersion).toBe("news-classifier-v5");
    expect(NEWS_RULES.version).toBe("news-v4");
  });
  it("stock: a company's stock market debut is not a listing, a comparison name is not the subject", () => {
    expect(CLASSIFIER_SYSTEM).toMatch(
      /first day, beating SpaceX" — candidates SPCX-USD → none, market NONE\. A company's stock market debut is not a listing/,
    );
  });
  it("stock: a fund buying a company's shares is not treasury_buy of a coin", () => {
    expect(CLASSIFIER_SYSTEM).toMatch(
      /Capital Group raises its holding of Strategy shares.*candidates MSTR-USD, BTC-USD → none, market NONE\. A fund buying a company's shares is not treasury_buy/,
    );
  });
  it("keeps every v4 example and the v4 numbering (examples are only appended)", () => {
    expect(CLASSIFIER_SYSTEM).toMatch(/\n70\. "Issuer W launches another spot ETH ETF in the US"/);
    expect(CLASSIFIER_SYSTEM).toMatch(/\n71\. "Anthropic's shares/);
    expect(CLASSIFIER_SYSTEM).toMatch(/\n72\. "Capital Group/);
    expect(CLASSIFIER_SYSTEM.indexOf("\n72. ")).toBeLessThan(
      CLASSIFIER_SYSTEM.indexOf("# Edge cases"),
    );
  });
});

describe("classifier prompt rules from news-classifier-v4 (#395, #323)", () => {
  it("hack: a disclosed or patched vulnerability with no funds lost is none", () => {
    expect(CLASSIFIER_SYSTEM).toContain(
      "A disclosed, reported or patched vulnerability (a bug report, a CVE, a security advisory, a bug bounty, a fixed version released) is not a hack when no funds were taken and no attacker actually exploited it",
    );
    expect(CLASSIFIER_SYSTEM).toMatch(
      /Bitcoin Core discloses a bug that could stall nodes.*→ none, market NONE/,
    );
    expect(CLASSIFIER_SYSTEM).toMatch(
      /critical bug in protocol P's contracts.*→ none, market NONE/,
    );
  });
  it("hack: a real exploit of the chain itself is hack_exploit on that chain's coin (#323)", () => {
    expect(CLASSIFIER_SYSTEM).toContain(
      "A real exploit of the chain or coin itself is hack_exploit on that coin",
    );
    expect(CLASSIFIER_SYSTEM).toMatch(
      /Ethereum client bug lets attacker mint ETH; validators halt the chain" — candidates ETH-USD → hack_exploit, ETH-USD, direct/,
    );
  });
  it("hack: the stolen-coin rule is restated with the $860M ETH example", () => {
    expect(CLASSIFIER_SYSTEM).toContain(
      'This holds however large the amount and even when the headline is about the stolen coin, as in "About $860M in ETH drained / transferred by the hacker"',
    );
    expect(CLASSIFIER_SYSTEM).toMatch(
      /About \$860M in ETH drained by the hacker.*→ none, market NONE/,
    );
  });
  it("hack: moving or laundering funds from an earlier hack is not a new hack", () => {
    expect(CLASSIFIER_SYSTEM).toContain(
      "Funds moved or laundered from an earlier hack (on-chain tracking of the hacker's wallets, funds sent through a mixer or a bridge, a first large transfer since the theft) are not a new hack event",
    );
    expect(CLASSIFIER_SYSTEM).toMatch(
      /moves 488,000 ETH \(about \$860M\) through mixers.*→ none, market NONE/,
    );
  });
  it("ETF: one more ETF or one on a smaller exchange for a coin that already has ETFs is none", () => {
    expect(CLASSIFIER_SYSTEM).toContain(
      "Use etf_approved only for an approval or first trading day that matters for the coin",
    );
    expect(CLASSIFIER_SYSTEM).toMatch(
      /New bitcoin ETF lists on the Hong Kong exchange.*→ none, market NONE/,
    );
    expect(CLASSIFIER_SYSTEM).toMatch(
      /launches another spot ETH ETF in the US" — candidates ETH-USD → none/,
    );
    expect(CLASSIFIER_SYSTEM).toMatch(
      /first spot SOL ETF in the United States.*→ etf_approved, SOL-USD, direct/,
    );
    // Ví dụ 27 cũ ("Spot ETH ETF … → etf_approved") mâu thuẫn với luật mới nên đổi sang ETF đầu tiên của một coin.
    expect(CLASSIFIER_SYSTEM).not.toContain(
      "Spot ETH ETF from issuer V starts trading on Nasdaq today",
    );
  });
  it("adds the v4 edge-case questions", () => {
    expect(CLASSIFIER_SYSTEM).toContain(
      "For hack_exploit, also ask: did an attacker actually take funds or exploit the bug, and is this a new event?",
    );
    expect(CLASSIFIER_SYSTEM).toContain(
      "For etf_approved, ask: is this the coin's first ETF, or its first in a major market?",
    );
  });
});

describe("classifier prompt rules from news-classifier-v3 (#320)", () => {
  it("hack: the stolen asset (unit of the loss) is never the affected token", () => {
    expect(CLASSIFIER_SYSTEM).toContain(
      "The affected token of a hack is never the asset that was stolen or used as the unit of the loss",
    );
    expect(CLASSIFIER_SYSTEM).toContain(
      "Never name ETH, BTC or a stablecoin merely because it was stolen",
    );
    expect(CLASSIFIER_SYSTEM).toMatch(/12,000 ETH \(≈ \$21\.6M\) stolen .*→ none, market NONE/);
    expect(CLASSIFIER_SYSTEM).toMatch(/\$21M in BTC drained from exchange Y.*→ none, market NONE/);
    expect(CLASSIFIER_SYSTEM).toMatch(/USDT from bridge W.*→ none, market NONE/);
  });
  it("hack: contrasting positive example names the hacked protocol's own token", () => {
    expect(CLASSIFIER_SYSTEM).toMatch(
      /Protocol Q drained of 12,000 ETH; Q token falls" — candidates Q-USD, ETH-USD → hack_exploit, Q-USD, direct/,
    );
  });
  it("earnings: analyst / bank forecasts and price targets are none", () => {
    expect(CLASSIFIER_SYSTEM).toContain(
      "only the company's own reported results or its own guidance count",
    );
    expect(CLASSIFIER_SYSTEM).toMatch(
      /JPMorgan report: Nvidia's revenue is expected.*→ none, market NONE/,
    );
    expect(CLASSIFIER_SYSTEM).toMatch(/Morgan Stanley raises NVDA price target.*→ none/);
    expect(CLASSIFIER_SYSTEM).toMatch(
      /NVIDIA raises its own revenue guidance.*→ earnings_beat, NVDA-USD, direct/,
    );
  });
  it("keeps the v2 examples and edge-case questions", () => {
    expect(CLASSIFIER_SYSTEM).toContain(
      "For hack_exploit, ask: whose protocol or exchange was hacked?",
    );
    expect(CLASSIFIER_SYSTEM).toContain(
      "For earnings_beat and earnings_miss, ask: who is speaking?",
    );
    expect(CLASSIFIER_SYSTEM).toContain("For regulatory_action, ask: who is the target?");
  });
});

describe("classifier prompt rules from news-classifier-v2 (#298)", () => {
  it("regulatory_action: only against the project / company itself, never an individual employee", () => {
    expect(CLASSIFIER_SYSTEM).toContain("The target of the action must be the project or company");
    expect(CLASSIFIER_SYSTEM).toContain("an individual who works or used to work at the company");
    expect(CLASSIFIER_SYSTEM).toMatch(/Former Google engineer charged .*→ none, market NONE/);
  });
  it("civil lawsuits by investors are not regulatory_action", () => {
    expect(CLASSIFIER_SYSTEM).toContain("civil lawsuit filed by investors");
    expect(CLASSIFIER_SYSTEM).toMatch(/Meta investors file class-action lawsuit.*→ none/);
  });
  it("listing / delisting: the token must be the subject, a tag is not enough", () => {
    expect(CLASSIFIER_SYSTEM).toContain("The asset must itself be the token being listed");
    expect(CLASSIFIER_SYSTEM).toContain(
      "a coin the news provider tagged although the article never names it",
    );
    expect(CLASSIFIER_SYSTEM).toMatch(
      /built on Chainlink.*LINK is only named as related technology/,
    );
    expect(CLASSIFIER_SYSTEM).toContain(
      "Being a candidate (a tag from the news provider) is not enough",
    );
  });
  it("treasury: amount copied as written or unknown, never estimated", () => {
    expect(CLASSIFIER_SYSTEM).toContain("treasury_amount");
    expect(CLASSIFIER_SYSTEM).toContain("Never estimate, convert or round an amount");
    expect(CLASSIFIER_SYSTEM).toMatch(/sells 12 BTC.*treasury_amount "12 BTC"/);
  });
  it("keeps the cached prefix: tools + system with cache_control, same max_tokens", async () => {
    let body: Record<string, unknown> = {};
    vi.stubGlobal("fetch", (_url: unknown, init: { body: string }) => {
      body = JSON.parse(init.body) as Record<string, unknown>;
      return Promise.resolve(
        new Response(
          JSON.stringify({
            id: "m",
            type: "message",
            role: "assistant",
            model: "claude-haiku-4-5",
            content: [],
            stop_reason: "end_turn",
            stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    });
    try {
      await anthropicClassifier("k").classify(
        {
          title: "t",
          content: "c",
          source: "s",
          publishedAt: 0,
          candidates: [],
          universe: ["SOL-USD"],
        },
        1,
      );
    } finally {
      vi.unstubAllGlobals();
    }
    expect(body.max_tokens).toBe(NEWS_CLASSIFIER.maxTokens);
    expect(body.system).toEqual([
      {
        type: "text",
        text: CLASSIFIER_SYSTEM,
        cache_control: { type: "ephemeral", ttl: NEWS_CLASSIFIER.cacheTtl },
      },
    ]);
    expect(body.tools).toHaveLength(1);
    expect(JSON.stringify(body.messages)).not.toContain(CLASSIFIER_SYSTEM.slice(0, 40));
    // v3 (#320): the cached system text carries the new examples, and the article records the new classifier version.
    expect(JSON.stringify(body.system)).toContain(
      "Protocol Q drained of 12,000 ETH; Q token falls",
    );
    expect(JSON.stringify(body.system)).toContain("Morgan Stanley raises NVDA price target");
    // v4 (#395): the same cached prefix carries the v4 examples.
    expect(JSON.stringify(body.system)).toContain("Ethereum client bug lets attacker mint ETH");
    // v5 (#399): and the v5 counter-examples.
    expect(JSON.stringify(body.system)).toContain(
      "Capital Group raises its holding of Strategy shares",
    );
    expect(articleUsageValues({ usage: { ...emptyUsage(), calls: 1 } }).claudePromptVersion).toBe(
      "news-classifier-v5",
    );
  });
});

describe("per-article Claude usage (#290)", () => {
  const input = {
    title: "SOL protocol exploited",
    content: "exploit",
    source: "Odaily",
    publishedAt: Date.parse("2026-11-18T12:00:00Z"),
    candidates: [{ symbol: "SOL", market: "SOL-USD", kind: "crypto" as const }],
    universe: ["SOL-USD"],
  };
  const reply = {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-haiku-4-5",
    content: [
      {
        type: "tool_use",
        id: "tu_1",
        name: "record_classification",
        input: {
          catalyst: "hack_exploit",
          market: "SOL-USD",
          relevance: "direct",
          promotional: false,
          event_date: "2026-11-18",
        },
      },
    ],
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: {
      input_tokens: 512,
      output_tokens: 118,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 4635,
    },
  };
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  /** fetch giả: mỗi lần gọi lấy một phản hồi trong danh sách; `"network"` = lỗi mạng (không có phản hồi HTTP). */
  function stubFetch(steps: ("ok" | "429" | "network")[]) {
    let i = 0;
    vi.stubGlobal("fetch", () => {
      const s = steps[i] ?? "ok";
      i += 1;
      if (s === "network") return Promise.reject(new TypeError("fetch failed"));
      if (s === "429")
        return Promise.resolve(
          json({ type: "error", error: { type: "rate_limit_error", message: "x" } }, 429),
        );
      return Promise.resolve(json(reply));
    });
  }
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("one request per article: the article gets exactly that call's tokens, model and prompt version", async () => {
    stubFetch(["ok"]);
    const out = await anthropicClassifier("k").classify(input);
    expect(out.ok).toBe(true);
    expect(articleUsageValues(out)).toEqual({
      claudeCalls: 1,
      claudeInputTokens: 512,
      claudeCacheWriteTokens: 0,
      claudeCacheReadTokens: 4635,
      claudeOutputTokens: 118,
      claudeModel: NEWS_CLASSIFIER.model,
      claudePromptVersion: NEWS_CLASSIFIER.promptVersion,
    });
  });

  it("a retry after an HTTP error adds to the same article (an API error is not billed: 0 tokens is real)", async () => {
    stubFetch(["429", "ok"]);
    const out = await anthropicClassifier("k").classify(input);
    expect(out).toMatchObject({ ok: true, usageKnown: true });
    expect(articleUsageValues(out)).toMatchObject({
      claudeCalls: 2,
      claudeInputTokens: 512,
      claudeCacheReadTokens: 4635,
      claudeOutputTokens: 118,
    });
  });

  it("a call with no HTTP response (network / timeout) makes every token column null, never a partial 0", async () => {
    stubFetch(["network", "ok"]);
    const out = await anthropicClassifier("k").classify(input);
    expect(out).toMatchObject({ ok: true, usageKnown: false });
    expect(articleUsageValues(out)).toMatchObject({
      claudeCalls: 2,
      claudeInputTokens: null,
      claudeCacheWriteTokens: null,
      claudeCacheReadTokens: null,
      claudeOutputTokens: null,
    });
    stubFetch(["429", "429"]);
    const failed = await anthropicClassifier("k").classify(input);
    expect(failed).toMatchObject({ ok: false, usageKnown: true });
    expect(articleUsageValues(failed)).toMatchObject({ claudeCalls: 2, claudeInputTokens: 0 });
  });

  it("the daily budget unit and the per-article $ use the same prices", () => {
    for (const t of [
      { input: 512, cacheWrite: 0, cacheRead: 4635, output: 118 },
      { input: 100, cacheWrite: 4200, cacheRead: 0, output: 20 },
      { input: 3, cacheWrite: 7, cacheRead: 11, output: 13 },
    ])
      expect(weightedInput(t)).toBe(
        claudeCostUsd(t).mul(1_000_000).div(NEWS_CLASSIFIER.pricing.inputPerM).ceil().toNumber(),
      );
  });

  it("a fake classifier without usageKnown counts as known", () => {
    expect(
      articleUsageValues({ usage: { ...emptyUsage(), calls: 1, input: 3 } }).claudeInputTokens,
    ).toBe(3);
  });
});

describe("feature flag and env", () => {
  it("is off by default and needs both keys", () => {
    expect(disabledReason(signalResearchEnvSchema.parse({}))).toMatch(/SIGNAL_RESEARCH_ENABLED/);
    expect(
      disabledReason(signalResearchEnvSchema.parse({ SIGNAL_RESEARCH_ENABLED: "true" })),
    ).toMatch(/SOSO_API_KEY/);
    expect(
      disabledReason(
        signalResearchEnvSchema.parse({ SIGNAL_RESEARCH_ENABLED: "true", SOSO_API_KEY: "k" }),
      ),
    ).toMatch(/DESK_AI_API_KEY/);
    expect(
      disabledReason(
        signalResearchEnvSchema.parse({
          SIGNAL_RESEARCH_ENABLED: "true",
          SOSO_API_KEY: "k",
          DESK_AI_API_KEY: "c",
        }),
      ),
    ).toBeNull();
  });
  it("accepts true / 1 for the flag", () => {
    for (const v of ["true", "TRUE", "1"])
      expect(parseSignalEnv({ SIGNAL_RESEARCH_ENABLED: v }).env?.SIGNAL_RESEARCH_ENABLED).toBe(
        true,
      );
    for (const v of [undefined, "", "false", "0", "yes"])
      expect(parseSignalEnv({ SIGNAL_RESEARCH_ENABLED: v }).env?.SIGNAL_RESEARCH_ENABLED).toBe(
        false,
      );
  });
  it("never throws: invalid SIGNAL_* values are ignored with a warning when the flag is off", () => {
    const off = parseSignalEnv({
      SIGNAL_SOSO_MAX_PAGES: "10",
      SIGNAL_CLAUDE_MAX_CALLS_PER_CYCLE: "x",
    });
    expect(off.env?.SIGNAL_RESEARCH_ENABLED).toBe(false);
    expect(off.env?.SIGNAL_SOSO_MAX_PAGES).toBe(2);
    expect(off.warning).toMatch(/SIGNAL_SOSO_MAX_PAGES/);
    const on = parseSignalEnv({ SIGNAL_RESEARCH_ENABLED: "1", SIGNAL_SOSO_MAX_PAGES: "10" });
    expect(on.env).toBeNull();
    expect(on.warning).toMatch(/SIGNAL_SOSO_MAX_PAGES/);
  });
});

describe("SoSoValue client", () => {
  it("parses the real response shape and never puts the key in errors", async () => {
    const key = "soso-secret-key-123";
    const body = {
      code: 0,
      message: "success",
      data: {
        page: 1,
        page_size: 100,
        total: 1,
        list: [
          {
            id: "2123091637433757696",
            release_time: "1795019420000",
            title: "t",
            content: "<p>c</p>",
            author: "Bloomberg",
            category: 5,
            original_link: null,
            source_link: "https://sosovalue.com/x",
            matched_currencies: [{ currency_id: "1", symbol: "NFLX", name: '{"EN": "NETFLIX"}' }],
          },
          { id: "2", release_time: "x" },
        ],
      },
    };
    let seenKey = "";
    const ok = sosoClient(key, (_url, init) => {
      seenKey = new Headers(init?.headers).get("x-soso-api-key") ?? "";
      return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
    });
    const page = await ok.newsPage(1);
    expect(seenKey).toBe(key);
    expect(page.invalid).toBe(1);
    expect(page.items[0]).toMatchObject({
      release_time: 1795019420000,
      matched_currencies: [{ symbol: "NFLX" }],
    });
    const bad = sosoClient(key, () =>
      Promise.resolve(
        new Response(JSON.stringify({ code: 400101, message: `bad key ${key}` }), { status: 401 }),
      ),
    );
    const err: unknown = await bad.newsPage(1).catch((e: unknown) => e);
    expect(String(err)).not.toContain(key);
    expect(JSON.stringify(err)).not.toContain(key);
  });
});

/** Mọi file của lane tin tức (scheduler, shared, db, api): không có đường nào tới SoDEX. */
function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? filesUnder(p) : p.endsWith(".ts") ? [p] : [];
  });
}

describe("no SoDEX write path", () => {
  const root = join(import.meta.dirname, "../../..");
  const files = [
    ...filesUnder(join(root, "apps/scheduler/src/signal-research")),
    ...filesUnder(join(root, "packages/shared/src/signal-research")),
    join(root, "packages/shared/src/api/signal-research.ts"),
    join(root, "packages/db/src/signal-research.ts"),
    ...filesUnder(join(root, "apps/api/src/modules/signal-research")),
  ];
  it("covers the whole lane", () => {
    expect(files.length).toBeGreaterThanOrEqual(13);
  });
  it("the dry-run CLI only reads the SoDEX market list (no write client, no other SoDEX call)", () => {
    const src = readFileSync(join(root, "apps/scheduler/src/cli/signals-once.ts"), "utf8");
    expect(src).not.toMatch(/HttpGateway|SignedWriteClient|signer|gateway/i);
    const calls = [...src.matchAll(/rest\.(\w+)\(/g)].map((m) => m[1]);
    expect(calls).toEqual(["getPerpsSymbols"]);
  });
  it.each(files)("%s imports nothing that can reach SoDEX", (file) => {
    const src = readFileSync(file, "utf8");
    const imports = [...src.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1] ?? "");
    for (const i of imports) {
      expect(i).not.toMatch(/@drift\/sodex|signer|gateway|engine/i);
      // Chỉ import tương đối trong cùng lane, hoặc package nền tảng đã liệt kê.
      if (!i.startsWith(".") && !i.startsWith("node:"))
        expect([
          "@drift/db",
          "@drift/shared",
          "@anthropic-ai/sdk",
          "drizzle-orm",
          "zod",
          "ioredis",
          "pino",
          "fastify",
        ]).toContain(i);
    }
    expect(src).not.toMatch(/HttpGateway|SignedWriteClient|SodexRestClient|sodex\.dev/);
  });
});

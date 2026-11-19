import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { claudeCostUsd, Decimal, NEWS_CLASSIFIER } from "@drift/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  anthropicClassifier,
  articleUsageValues,
  cacheSelfCheck,
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
import { combineQuote, LiveBooks, medianTicks } from "../src/signal-research/prices";
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

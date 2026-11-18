import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { Decimal } from "@drift/shared";
import { describe, expect, it } from "vitest";

import { parseAnswer, weightedInput } from "../src/signal-research/classifier";
import { disabledReason, signalResearchEnvSchema } from "../src/signal-research/index";
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

describe("collect floor (watermark)", () => {
  const now = Date.parse("2026-11-18T12:00:00Z");
  it("first run starts 15 min back", () => {
    expect(collectFloor(null, now, cfg)).toBe(now - 15 * MIN);
  });
  it("normal run: watermark minus a 10 min overlap", () => {
    expect(collectFloor(now - 5 * MIN, now, cfg)).toBe(now - 15 * MIN);
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
  it("live books ignore malformed messages", () => {
    const b = new LiveBooks();
    b.onMessage("not json", 1);
    b.onMessage(JSON.stringify({ s: "BTC-USD", b: "1", a: "0.5", E: 1, at: 1 }), 1);
    expect(b.get("BTC-USD")).toBeUndefined();
    b.onMessage(JSON.stringify({ s: "BTC-USD", b: "1", a: "2", E: 1, at: 1 }), 5);
    expect(b.get("BTC-USD")?.at).toBe(5);
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
  it("budget counts cache reads at a tenth", () => {
    expect(weightedInput({ input: 100, cacheWrite: 50, cacheRead: 1000 })).toBe(250);
  });
});

describe("feature flag", () => {
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
    expect(files.length).toBeGreaterThanOrEqual(12);
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

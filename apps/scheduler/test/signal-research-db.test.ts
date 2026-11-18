import {
  candles1m,
  createDb,
  loadSignalResearchSummary,
  loadSignalResearchTrade,
  loadSignalResearchTrades,
  runMigrations,
  signalArticles,
  signalEvents,
  signalPaperTrades,
  signalResearchUsage,
  type Db,
} from "@drift/db";
import { NEWS_RULES } from "@drift/shared";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  emptyUsage,
  type Classification,
  type NewsClassifier,
} from "../src/signal-research/classifier";
import {
  createSignalResearch,
  signalResearchEnvSchema,
  type Logger,
} from "../src/signal-research/index";
import type { SosoClient, SosoNewsItem } from "../src/signal-research/soso";
import { saveNewsState } from "../src/signal-research/store";

// Pipeline lane tin tức (#271) trên Postgres thật: SoSoValue và Claude là mock, giá đến từ "marketdata" giả (sổ lệnh NATS /
// Redis md:last). Không có client SoDEX nào trong cả bài test.

const MIN = 60_000;
const HOUR = 60 * MIN;
const T0 = Date.parse("2026-11-18T12:00:00Z");

let container: StartedPostgreSqlContainer;
let db: Db;
let pool: ReturnType<typeof createDb>["pool"];

beforeAll(async () => {
  container = await new PostgreSqlContainer("timescale/timescaledb:2.16.1-pg16").start();
  await runMigrations(container.getConnectionUri());
  ({ db, pool } = createDb(container.getConnectionUri()));
  // 30 ngày nến theo giờ cho SOL-USD: ngày chẵn 100, ngày lẻ 102 → biến động 24 giờ ≈ 2 %.
  const rows = [];
  for (let h = 31 * 24; h >= 1; h -= 1) {
    const ts = T0 - h * HOUR;
    const day = Math.floor(ts / (24 * HOUR));
    const close = day % 2 === 0 ? "100" : "102";
    rows.push({
      market: "SOL-USD",
      ts: new Date(ts),
      open: close,
      high: close,
      low: close,
      close,
      volume: "1",
    });
  }
  await db.insert(candles1m).values(rows);
});
afterAll(async () => {
  await pool.end();
  await container.stop();
});
beforeEach(async () => {
  await db.execute(
    sql`truncate signal_articles, signal_events, signal_stories, signal_paper_trades, signal_research_usage, signal_source_health`,
  );
});

function item(
  id: string,
  at: number,
  title: string,
  opts: Partial<SosoNewsItem> = {},
): SosoNewsItem {
  return {
    id,
    release_time: at,
    title,
    content: `<p>${title}</p>`,
    author: "Odaily",
    category: 1,
    source_link: `https://sosovalue.com/${id}`,
    original_link: null,
    matched_currencies: [{ symbol: "SOL", name: "Solana" }],
    ...opts,
  };
}

function fakeSoso(items: () => SosoNewsItem[]): SosoClient & { calls: number } {
  const c = {
    calls: 0,
    newsPage(page: number) {
      c.calls += 1;
      const all = [...items()].sort((a, b) => b.release_time - a.release_time);
      return Promise.resolve({ items: all.slice((page - 1) * 100, page * 100), invalid: 0 });
    },
  };
  return c;
}

const NONE: Classification = {
  catalyst: "none",
  market: null,
  relevance: "passing_mention",
  promotional: false,
  eventDate: null,
};

function fakeClaude(
  byTitle: Record<string, Classification>,
): NewsClassifier & { titles: string[] } {
  const c = {
    titles: [] as string[],
    classify(input: Parameters<NewsClassifier["classify"]>[0]) {
      c.titles.push(input.title ?? "");
      return Promise.resolve({
        ok: true as const,
        value: byTitle[input.title ?? ""] ?? NONE,
        usage: { ...emptyUsage(), calls: 1, input: 1500, output: 40 },
      });
    },
  };
  return c;
}

function logger(errors: unknown[]): Logger {
  const l: Logger = {
    info: () => undefined,
    warn: () => undefined,
    error: (obj) => {
      errors.push(obj);
    },
    child: () => l,
  };
  return l;
}

function setup(input: {
  items: () => SosoNewsItem[];
  claude: NewsClassifier;
  now: () => number;
  env?: Record<string, string>;
  last?: Record<string, { price: string; at: number }>;
}) {
  const errors: unknown[] = [];
  const soso = fakeSoso(input.items);
  const sr = createSignalResearch({
    db,
    redis: {
      mget: (...keys: string[]) =>
        Promise.resolve(
          keys.map((k) => {
            const v = input.last?.[k.replace("md:last:", "")];
            return v === undefined ? null : JSON.stringify(v);
          }),
        ),
    },
    log: logger(errors),
    env: signalResearchEnvSchema.parse({
      SIGNAL_RESEARCH_ENABLED: "true",
      SOSO_API_KEY: "k",
      DESK_AI_API_KEY: "c",
      ...input.env,
    }),
    perps: () => [
      { name: "SOL-USD", status: "TRADING", tickSize: "0.01", takerFee: "0.0004" },
      { name: "BTC-USD", status: "TRADING", tickSize: "0.1", takerFee: "0.0004" },
    ],
    now: input.now,
    soso,
    classifier: input.claude,
  });
  return { sr, soso, errors };
}

const hack: Classification = {
  catalyst: "hack_exploit",
  market: "SOL-USD",
  relevance: "direct",
  promotional: false,
  eventDate: "2026-11-18",
};

describe("news pipeline end to end", () => {
  it("opens a short on the bid, merges a second source, closes at TP on the ask", async () => {
    let now = T0;
    // Giá trước tin (cho "moved before entry").
    await db
      .insert(candles1m)
      .values({
        market: "SOL-USD",
        ts: new Date(T0 - 5 * MIN),
        open: "101",
        high: "101",
        low: "101",
        close: "101",
        volume: "1",
      })
      .onConflictDoNothing();
    const items = [
      item("a1", T0 - 4 * MIN, "Protocol on Solana drained in exploit", {
        author: "Bloomberg",
        category: 5,
      }),
      item("a2", T0 - 3 * MIN, "Solana exploit: attacker moved funds", { author: "Odaily" }),
      item("a3", T0 - 2 * MIN, "Bitcoin recap", {
        matched_currencies: [{ symbol: "BTC", name: "Bitcoin" }],
      }),
      item("a4", T0 - 2 * MIN, "Unrelated stock", {
        matched_currencies: [{ symbol: "ANT", name: '{"EN": "ANTHROPIC"}' }],
      }),
      item("a5", T0 - 1 * MIN, "Protocol on Solana drained in exploit", { author: "TechFlow" }), // trùng y hệt a1
    ];
    const claude = fakeClaude({
      "Protocol on Solana drained in exploit": hack,
      "Solana exploit: attacker moved funds": hack,
    });
    const { sr, errors } = setup({ items: () => items, claude, now: () => now });
    sr.books.onMessage(
      JSON.stringify({ s: "SOL-USD", b: "99.99", a: "100.01", E: now, at: now }),
      now,
    );
    await sr.runCycle();
    expect(errors).toEqual([]);
    expect(claude.titles.sort()).toEqual([
      "Bitcoin recap",
      "Protocol on Solana drained in exploit",
      "Solana exploit: attacker moved funds",
    ]);

    const [t] = await db.select().from(signalPaperTrades);
    expect(t).toMatchObject({
      lane: "news",
      market: "SOL-USD",
      direction: "short",
      catalyst: "hack_exploit",
      levelAtEntry: "high",
      status: "open",
      priceSource: "book",
      ruleVersion: NEWS_RULES.version,
      outsideMarketHours: false,
    });
    expect(t?.entryPrice).toBe("99.990000000000000000");
    expect(Number(t?.movedBeforeEntryPct)).toBeCloseTo(-0.990099, 4);
    expect(t?.maxHoldUntil.getTime()).toBe(T0 + 24 * HOUR);
    expect(Number(t?.tpPct)).toBeGreaterThan(2.5);

    const reasons = await db
      .select({
        stage: signalEvents.stage,
        outcome: signalEvents.outcome,
        reason: signalEvents.reason,
      })
      .from(signalEvents);
    expect(reasons).toEqual(
      expect.arrayContaining([
        { stage: "normalize", outcome: "drop", reason: "DUPLICATE" },
        { stage: "normalize", outcome: "drop", reason: "NO_SODEX_MARKET" },
        { stage: "understand", outcome: "drop", reason: "NOT_A_SIGNAL_TYPE" },
        { stage: "filter", outcome: "merge", reason: "SAME_STORY" },
        { stage: "decide", outcome: "open", reason: null },
      ]),
    );

    // Không có giá → chờ. Giá ask xuống dưới TP → đóng TP theo ask.
    now = T0 + 10 * MIN;
    expect(await sr.watcher.tick()).toBe(0);
    sr.books.onMessage(
      JSON.stringify({ s: "SOL-USD", b: "96.4", a: "96.5", E: now, at: now }),
      now,
    );
    expect(await sr.watcher.tick()).toBe(1);
    const [closed] = await db.select().from(signalPaperTrades);
    expect(closed).toMatchObject({
      status: "closed",
      exitReason: "take_profit",
      exitPrice: "96.500000000000000000",
    });
    expect(Number(closed?.resultUsdc)).toBeGreaterThan(15);

    // Bài mới cùng câu chuyện ở chu kỳ sau: chỉ thêm nguồn, không mở lại.
    items.push(item("a6", now - MIN, "Solana exploit follow-up", { author: "PANews" }));
    claude.titles.length = 0;
    const more = fakeClaude({ "Solana exploit follow-up": hack });
    const s2 = setup({ items: () => items, claude: more, now: () => now });
    s2.sr.books.onMessage(
      JSON.stringify({ s: "SOL-USD", b: "96.4", a: "96.5", E: now, at: now }),
      now,
    );
    await s2.sr.runCycle();
    expect(await db.select().from(signalPaperTrades)).toHaveLength(1);

    const summary = await loadSignalResearchSummary(db, new Date(now), {
      sosoMonthlyLimit: 9500,
      claudeDailyInputBudget: 2_000_000,
    });
    expect(summary.funnel?.outcomes).toEqual({ closed: 1, tp: 1, sl: 0, maxHold: 0, open: 0 });
    expect(summary.funnel).toMatchObject({ long: 0, short: 1, merged: 2, stories: 1, passed: 1 });
    expect(summary.funnel?.drops.score.reasons).toEqual(
      expect.arrayContaining([
        { reason: "notOnSodex", n: 1 },
        { reason: "notCatalyst", n: 1 },
      ]),
    );
    expect(summary.rows[0]).toMatchObject({
      type: "news",
      label: "live",
      closed: 1,
      status: "collecting",
    });
    expect(summary.levels.find((l) => l.level === "high")).toMatchObject({
      trades: 1,
      closed: 1,
      short: 1,
    });
    expect(summary.sources.find((s) => s.key === "sosoNews")?.status).toBe("live");
    expect(summary.funnel?.claudeCostPerDay).not.toBeNull();

    const page = await loadSignalResearchTrades(db, { limit: 50, show: "entered" }, new Date(now));
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      asset: "SOL-USD",
      side: "short",
      delaySecs: 240,
      what: {
        type: "news",
        headline: "Protocol on Solana drained in exploit",
        newsType: "hack",
        levelAtEntry: "high",
        sources: 2,
        topTier: 1,
        later: { level: "high", sources: 3 },
      },
      result: { outcome: "tp" },
    });
    const detail = await loadSignalResearchTrade(db, page.items[0]?.id ?? "", new Date(now));
    expect(detail?.steps.map((s) => s.key)).toEqual([
      "received",
      "understood",
      "checks",
      "trade",
      "result",
    ]);
    expect(detail?.steps[2]?.checks.every((c) => c.ok)).toBe(true);
  });

  it("skips a market with a price but no book data instead of calling REST", async () => {
    const now = T0;
    const items = [item("b1", T0 - 2 * MIN, "Solana exploit", { author: "Odaily" })];
    const { sr } = setup({
      items: () => items,
      claude: fakeClaude({ "Solana exploit": hack }),
      now: () => now,
      last: { "SOL-USD": { price: "100", at: now } },
    });
    await sr.runCycle();
    expect(await db.select().from(signalPaperTrades)).toHaveLength(0);
    const [e] = await db
      .select({ reason: signalEvents.reason })
      .from(signalEvents)
      .where(eq(signalEvents.stage, "filter"));
    expect(e?.reason).toBe("NO_BOOK_DATA");
    const skipped = await loadSignalResearchTrades(
      db,
      { limit: 50, show: "skipped" },
      new Date(now),
    );
    expect(skipped.items[0]).toMatchObject({
      asset: "SOL-USD",
      skipped: { reason: "noPrice" },
      result: null,
    });
    const d = await loadSignalResearchTrade(db, skipped.items[0]?.id ?? "", new Date(now));
    expect(d?.steps.at(-1)?.checks.at(-1)).toEqual({ key: "priceAvailable", ok: false });
  });
});

describe("backlog protection", () => {
  it("first run with 7 days of news: nothing older than 15 min reaches Claude", async () => {
    const items = Array.from({ length: 100 }, (_, i) =>
      item(`w${String(i)}`, T0 - (i + 1) * 100 * MIN, `old ${String(i)}`),
    );
    items.push(item("n1", T0 - 5 * MIN, "fresh 1"), item("n2", T0 - 12 * MIN, "fresh 2"));
    const claude = fakeClaude({});
    const { sr, soso } = setup({ items: () => items, claude, now: () => T0 });
    await sr.runCycle();
    expect(claude.titles.sort()).toEqual(["fresh 1", "fresh 2"]);
    expect(soso.calls).toBe(1);
    const backlog = await db
      .select()
      .from(signalArticles)
      .where(eq(signalArticles.status, "backlog"));
    expect(backlog.length).toBe(100 - 2); // trang 1 có 100 bài mới nhất: 2 bài mới + 98 bài cũ
  });

  it("after 3 h of downtime only the last 30 min is classified", async () => {
    await saveNewsState(db, T0 - 3 * HOUR, T0 - 3 * HOUR);
    const items = Array.from({ length: 18 }, (_, i) =>
      item(`d${String(i)}`, T0 - (i + 1) * 10 * MIN + 1, `down ${String(i)}`),
    );
    const claude = fakeClaude({});
    const { sr } = setup({ items: () => items, claude, now: () => T0 });
    await sr.runCycle();
    expect(claude.titles.sort()).toEqual(["down 0", "down 1", "down 2"]);
    const backlog = await db
      .select()
      .from(signalArticles)
      .where(eq(signalArticles.status, "backlog"));
    expect(backlog).toHaveLength(15);
  });

  it("stale news (> 24 h) is dropped before Claude, in Normalize and in the queue", async () => {
    await saveNewsState(db, T0 - 3 * 24 * HOUR, T0 - 3 * 24 * HOUR);
    const items = [
      item("s1", T0 - 25 * HOUR, "stale one"),
      item("s2", T0 - 26 * HOUR, "stale two"),
    ];
    const claude = fakeClaude({});
    const { sr } = setup({
      items: () => items,
      claude,
      now: () => T0,
      env: { SIGNAL_NEWS_MAX_CATCHUP_MIN: String(4 * 24 * 60) },
    });
    // Bài đang chờ trong hàng đợi đã quá 24 giờ.
    await db.insert(signalArticles).values({
      id: "q1",
      source: "Odaily",
      title: "queued",
      content: "queued",
      publishedAt: new Date(T0 - 25 * HOUR),
      collectedAt: new Date(T0 - 25 * HOUR),
      matchedCurrencies: [],
      candidates: [{ symbol: "SOL", market: "SOL-USD", kind: "crypto" }],
      contentHash: "q1",
      status: "pending",
      ruleVersion: NEWS_RULES.version,
    });
    await sr.runCycle();
    expect(claude.titles).toEqual([]);
    const stale = await db
      .select({ stage: signalEvents.stage, articleId: signalEvents.articleId })
      .from(signalEvents)
      .where(eq(signalEvents.reason, "STALE_NEWS"));
    expect(stale.map((s) => `${s.stage}:${s.articleId ?? ""}`).sort()).toEqual([
      "normalize:s1",
      "normalize:s2",
      "understand:q1",
    ]);
  });

  it("per-cycle caps: at most N Claude calls (FIFO carry-over) and M SoSoValue pages", async () => {
    let now = T0;
    const items = Array.from({ length: 5 }, (_, i) =>
      item(`c${String(i)}`, T0 - (5 - i) * MIN, `cap ${String(i)}`),
    );
    const claude = fakeClaude({});
    const { sr } = setup({
      items: () => items,
      claude,
      now: () => now,
      env: { SIGNAL_CLAUDE_MAX_CALLS_PER_CYCLE: "2" },
    });
    await sr.runCycle();
    expect(claude.titles).toEqual(["cap 0", "cap 1"]);
    now += MIN;
    await sr.runCycle();
    expect(claude.titles).toEqual(["cap 0", "cap 1", "cap 2", "cap 3"]);

    const many = Array.from({ length: 250 }, (_, i) =>
      item(`p${String(i)}`, T0 + MIN + i * 100, `page ${String(i)}`, { matched_currencies: [] }),
    );
    const p = setup({ items: () => many, claude: fakeClaude({}), now: () => T0 + 2 * MIN });
    await p.sr.runCycle();
    expect(p.soso.calls).toBe(2);
    const [u] = await db.select().from(signalResearchUsage);
    expect(u?.sosoRequests).toBe(4);
  });

  it("daily budget reached: stops classifying and records why", async () => {
    await db
      .insert(signalResearchUsage)
      .values({ day: "2026-11-18", claudeInputTokens: 3_000_000 });
    const items = [item("x1", T0 - MIN, "budget")];
    const claude = fakeClaude({});
    const { sr } = setup({ items: () => items, claude, now: () => T0 });
    await sr.runCycle();
    expect(claude.titles).toEqual([]);
    const [e] = await db
      .select({ reason: signalEvents.reason })
      .from(signalEvents)
      .where(eq(signalEvents.stage, "understand"));
    expect(e?.reason).toBe("CLAUDE_BUDGET_REACHED");
  });
});

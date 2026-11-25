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
  signalStories,
  type Db,
} from "@drift/db";
import {
  articleClaudeUsage,
  NEWS_ASSET_MAP_VERSION,
  NEWS_CLASSIFIER,
  NEWS_RULES,
} from "@drift/shared";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

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
import type { RestBookResult } from "../src/signal-research/prices";
import {
  SOSO_BASE_URL,
  SosoError,
  type SosoClient,
  type SosoNewsItem,
} from "../src/signal-research/soso";
import { adoptInFlightArticles, saveNewsState } from "../src/signal-research/store";

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

/**
 * #304 (DEC-328 mục 2): lệnh chỉ tính vào số thống kê / cổng khi classifier tạo ra nó đã qua cổng precision. Cho
 * classifier hiện tại qua (50 bài nhãn Right) ở các test đo số thống kê của lệnh.
 */
async function passCurrentClassifier() {
  await pool.query(
    `with u as (insert into users (id, email) values (gen_random_uuid(), 'lbl-' || gen_random_uuid() || '@example.test') returning id)
     insert into signal_classification_labels (id, article_id, classifier_version, labeled_by, verdict, source)
     select gen_random_uuid(), 'lbl-' || g, $1, u.id, 'right', 'random' from u, generate_series(1, 50) g`,
    [NEWS_CLASSIFIER.promptVersion],
  );
}

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

/** Tin NATS `md.<market>.book` giả của marketdata. */
function book(
  sr: { books: { onMessage: (subject: string, raw: string, at: number) => void } },
  market: string,
  b: string,
  a: string,
  at: number,
) {
  sr.books.onMessage(
    `md.${market.toLowerCase()}.book`,
    JSON.stringify({ s: market, b, a, E: at, at }),
    at,
  );
}

const PERPS = [
  { name: "SOL-USD", status: "TRADING", tickSize: "0.01", takerFee: "0.0004" },
  { name: "BTC-USD", status: "TRADING", tickSize: "0.1", takerFee: "0.0004" },
];

function setup(input: {
  items: () => SosoNewsItem[];
  claude: NewsClassifier;
  now: () => number;
  env?: Record<string, string>;
  last?: Record<string, { price: string; at: number }>;
  perps?: () => typeof PERPS | null;
  soso?: SosoClient;
  /** #507: sổ REST qua marketdata (NATS request) giả. */
  requestBook?: (market: string) => Promise<RestBookResult>;
}) {
  const errors: unknown[] = [];
  const soso = fakeSoso(input.items);
  /** Giá trị Redis đã ghi (`sr:quotes`, #308) kèm TTL. */
  const written = new Map<string, { value: string; ms: number }>();
  const sr = createSignalResearch({
    db,
    redis: {
      set: (key: string, value: string, _px: "PX", ms: number) => {
        written.set(key, { value, ms });
        return Promise.resolve("OK");
      },
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
    perps: input.perps ?? (() => PERPS),
    now: input.now,
    soso: input.soso ?? soso,
    classifier: input.claude,
    ...(input.requestBook === undefined ? {} : { requestBook: input.requestBook }),
  });
  return { sr, soso, errors, written };
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
    const { sr, errors, written } = setup({ items: () => items, claude, now: () => now });
    book(sr, "SOL-USD", "99.99", "100.01", now);
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
      assetMapVersion: NEWS_ASSET_MAP_VERSION,
      outsideMarketHours: false,
    });
    expect(t?.entryPrice).toBe("99.990000000000000000");
    expect(Number(t?.movedBeforeEntryPct)).toBeCloseTo(-0.990099, 4);
    expect(t?.maxHoldUntil.getTime()).toBe(T0 + 24 * HOUR);
    expect(Number(t?.tpPct)).toBeGreaterThan(2.5);
    // #297: TP / SL lưu theo tick 0.01 của SOL-USD, không phải 18 chữ số thập phân.
    expect(t?.tpPrice).toMatch(/^\d+\.\d{2}0*$/);
    expect(t?.slPrice).toMatch(/^\d+\.\d{2}0*$/);

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
    // #308: bản chụp `sr:quotes` cho api không có market thiếu giá (api hiện như chưa có giá, không bao giờ 0).
    expect(JSON.parse(written.get("sr:quotes")?.value ?? "null")).toEqual({});
    expect(written.get("sr:quotes")?.ms).toBe(60_000);
    // Có sổ nhưng chưa chạm TP: lệnh vẫn mở, bản chụp có bid / ask và giờ của sổ.
    book(sr, "SOL-USD", "97.9", "98", now);
    expect(await sr.watcher.tick()).toBe(0);
    expect(JSON.parse(written.get("sr:quotes")?.value ?? "null")).toEqual({
      "SOL-USD": { bid: "97.9", ask: "98", source: "book", at: now },
    });
    book(sr, "SOL-USD", "96.4", "96.5", now);
    expect(await sr.watcher.tick()).toBe(1);
    const [closed] = await db.select().from(signalPaperTrades);
    // Giá nhảy qua TP: thoát đúng ở TP (thận trọng, như DEC-321).
    expect(closed).toMatchObject({ status: "closed", exitReason: "take_profit" });
    expect(closed?.exitPrice).toBe(closed?.tpPrice);
    expect(Number(closed?.resultUsdc)).toBeGreaterThan(10);
    // MFE lưu lúc đóng (giá giữa 96.45 so với giá vào 99.99, lệnh short), MAE = 0.
    expect(Number(closed?.mfePct)).toBeCloseTo(3.5404, 3);
    expect(Number(closed?.maePct)).toBe(0);

    // Bài mới cùng câu chuyện ở chu kỳ sau: chỉ thêm nguồn, không mở lại.
    items.push(item("a6", now - MIN, "Solana exploit follow-up", { author: "PANews" }));
    claude.titles.length = 0;
    const more = fakeClaude({ "Solana exploit follow-up": hack });
    const s2 = setup({ items: () => items, claude: more, now: () => now });
    book(s2.sr, "SOL-USD", "96.4", "96.5", now);
    await s2.sr.runCycle();
    expect(await db.select().from(signalPaperTrades)).toHaveLength(1);

    await passCurrentClassifier();
    const summary = await loadSignalResearchSummary(db, new Date(now), {
      sosoMonthlyLimit: 9500,
      claudeDailyInputBudget: 2_000_000,
    });
    expect(summary.funnel?.outcomes).toEqual({
      closed: 1,
      tp: 1,
      sl: 0,
      maxHold: 0,
      maxHoldNoPrice: 0,
      opposite: 0,
      open: 0,
    });
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
    expect(detail?.steps[3]?.facts.map((f) => f.key)).toContain("movedBeforeEntry");
    const result = detail?.steps[4]?.facts ?? [];
    expect(result.map((f) => f.key)).toEqual([
      "exit",
      "priceMove",
      "fees",
      "best",
      "worst",
      "random",
    ]);
    expect(result.find((f) => f.key === "fees")?.usd).toMatch(/^\d/); // chi phí dương
    expect(result.find((f) => f.key === "priceMove")?.pct).toBeGreaterThan(0);
    expect(result.find((f) => f.key === "best")?.pct).toBeCloseTo(3.5404, 3);
    // Random chưa tính (cửa sổ giữ chưa xong): null, không bao giờ 0.
    expect(result.find((f) => f.key === "random")?.pct).toBeNull();
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

describe("review PR #278 fixes", () => {
  it("M1: an article SoSoValue indexes 15 min late is still classified in a normal cycle", async () => {
    await saveNewsState(db, T0 - 2 * MIN, T0 - 5 * MIN);
    const items = [item("l1", T0 - 15 * MIN, "late indexed")];
    const claude = fakeClaude({});
    const { sr } = setup({ items: () => items, claude, now: () => T0 });
    await sr.runCycle();
    expect(claude.titles).toEqual(["late indexed"]);
  });

  it("B1: without the SoDEX market list the cycle only collects, then normalizes next cycle", async () => {
    let perps: typeof PERPS | null = null;
    const items = [item("m1", T0 - 2 * MIN, "collect only")];
    const claude = fakeClaude({});
    const { sr } = setup({ items: () => items, claude, now: () => T0, perps: () => perps });
    await sr.runCycle();
    expect(claude.titles).toEqual([]);
    const [a] = await db.select().from(signalArticles).where(eq(signalArticles.id, "m1"));
    expect(a?.status).toBe("collected");
    perps = PERPS;
    await sr.runCycle();
    expect(claude.titles).toEqual(["collect only"]);
  });

  it("R2: a transient drop does not lock; a retry within 2 h trades, measured from the first article", async () => {
    const items = [item("t1", T0 - 2 * MIN, "SOL hack first", { author: "Odaily" })];
    const claude = fakeClaude({ "SOL hack first": hack, "SOL hack second": hack });
    // Không có giá → NO_SODEX_PRICE (tạm thời).
    const first = setup({ items: () => items, claude, now: () => T0 });
    await first.sr.runCycle();
    const [s1] = await db.select().from(signalStories);
    expect(s1).toMatchObject({ outcome: "skipped", locked: false });
    // Chu kỳ sau có giá: bài sau cùng key được thử lại và vào lệnh; nguồn của lần thử trước vẫn được tính.
    const now = T0 + 5 * MIN;
    items.push(item("t2", now - MIN, "SOL hack second", { author: "Bloomberg", category: 5 }));
    const second = setup({ items: () => items, claude, now: () => now });
    book(second.sr, "SOL-USD", "99.99", "100.01", now);
    await second.sr.runCycle();
    const [t] = await db.select().from(signalPaperTrades);
    expect(t).toMatchObject({ articleId: "t2", levelAtEntry: "high", retry: true });
    // eventAt và moved_before_entry đo từ bài ĐẦU TIÊN (t1), không phải bài theo dõi.
    expect(t?.eventAt.getTime()).toBe(T0 - 2 * MIN);
    const entered = await db.select().from(signalStories).where(eq(signalStories.locked, true));
    expect(entered).toHaveLength(1);
    expect(entered[0]).toMatchObject({ outcome: "entered", tradeId: t?.id });
    // R3: hai lần thử cùng key = một câu chuyện.
    const summary = await loadSignalResearchSummary(db, new Date(now), {
      sosoMonthlyLimit: 9500,
      claudeDailyInputBudget: 2_000_000,
    });
    expect(summary.funnel?.stories).toBe(1);
    expect(summary.funnel?.levels).toEqual({ high: 1, medium: 0, low: 0 });
    expect(summary.levels.find((l) => l.level === "high")?.signals).toBe(1);
    const page = await loadSignalResearchTrades(db, { limit: 50, show: "entered" }, new Date(now));
    expect(page.items[0]?.retry).toBe(true);
  });

  it("#507 D: NO_SODEX_PRICE records how old the book and the last price were (null when there is none)", async () => {
    const claude = fakeClaude({ "SOL hack none": hack, "SOL hack stale": hack });
    // Không có dữ liệu nào: cả hai null.
    const none = setup({
      items: () => [item("d1", T0 - 2 * MIN, "SOL hack none", { author: "Odaily" })],
      claude,
      now: () => T0,
    });
    await none.sr.runCycle();
    const reasonOf = async (articleId: string) =>
      (await db.select().from(signalEvents).where(eq(signalEvents.articleId, articleId))).find(
        (e) => e.reason === "NO_SODEX_PRICE",
      );
    expect((await reasonOf("d1"))?.detail).toMatchObject({ bookAgeMs: null, lastAgeMs: null });
    // Sổ lệnh và giá gần nhất đều cũ: ghi đúng tuổi của từng nguồn.
    const now = T0 + 30 * MIN;
    const stale = setup({
      items: () => [item("d2", now - MIN, "SOL hack stale", { author: "Bloomberg", category: 5 })],
      claude,
      now: () => now,
      last: { "SOL-USD": { price: "100", at: now - 40_000 } },
    });
    book(stale.sr, "SOL-USD", "99.99", "100.01", now - 25_000);
    await stale.sr.runCycle();
    expect((await reasonOf("d2"))?.detail).toMatchObject({ bookAgeMs: 25_000, lastAgeMs: 40_000 });
  });

  it("#507: last price but no live book and no spread samples → NO_BOOK_DATA saying what is missing; a real REST book trades as rest_book", async () => {
    const claude = fakeClaude({ "SOL hack nobook": hack, "SOL hack restbook": hack });
    const eventOf = async (articleId: string) =>
      (await db.select().from(signalEvents).where(eq(signalEvents.articleId, articleId))).find(
        (e) => e.reason === "NO_BOOK_DATA",
      );
    // Như TRX / MON / SPCX trên prod: có giá gần nhất, không có sổ live, không có mẫu spread theo giờ, REST không trả được.
    const off = setup({
      items: () => [item("n1", T0 - 2 * MIN, "SOL hack nobook", { author: "Odaily" })],
      claude,
      now: () => T0,
      last: { "SOL-USD": { price: "100", at: T0 - 2_000 } },
      requestBook: () => Promise.resolve({ ok: false, reason: "timeout" }),
    });
    await off.sr.runCycle();
    expect((await eventOf("n1"))?.detail).toMatchObject({
      bookAgeMs: null,
      lastAgeMs: 2_000,
      spreadSamples: null,
      tickSize: true,
      rest: "timeout",
    });
    expect(await db.select().from(signalPaperTrades)).toEqual([]);
    // Cùng tình huống, marketdata trả sổ REST thật: vào lệnh với đúng giá mua / bán của sổ.
    const now = T0 + 30 * MIN;
    const asked: string[] = [];
    const on = setup({
      items: () => [
        item("n2", now - MIN, "SOL hack restbook", { author: "Bloomberg", category: 5 }),
      ],
      claude,
      now: () => now,
      last: { "SOL-USD": { price: "100", at: now - 2_000 } },
      requestBook: (m) => {
        asked.push(m);
        return Promise.resolve({ ok: true, bid: "99.99", ask: "100.01", at: now - 50 });
      },
    });
    await on.sr.runCycle();
    expect(asked).toContain("SOL-USD");
    const [t] = await db.select().from(signalPaperTrades);
    expect(t).toMatchObject({ articleId: "n2", priceSource: "rest_book" });
  });

  describe("#511: open trades on a market without a live book or spread samples", () => {
    /** Mở một lệnh bằng sổ REST (short SOL, tin hack) rồi trả watcher + điều khiển giờ / sổ REST. */
    async function openOnRest(title: string) {
      const claude = fakeClaude({ [title]: hack });
      let now = T0;
      let reply: RestBookResult = { ok: true, bid: "99.99", ask: "100.01", at: T0 };
      const asked: { market: string; at: number }[] = [];
      const s = setup({
        items: () => [item(`r-${title}`, T0 - MIN, title, { author: "Bloomberg", category: 5 })],
        claude,
        now: () => now,
        // Giá gần nhất luôn mới (như prod: có nến), nhưng không có sổ live / mẫu spread.
        last: new Proxy(
          {},
          {
            get: (_t, k) => (k === "SOL-USD" ? { price: "100", at: now - 2_000 } : undefined),
          },
        ),
        requestBook: (market) => {
          asked.push({ market, at: now });
          return Promise.resolve({ ...reply, ...(reply.ok ? { at: now } : {}) } as RestBookResult);
        },
      });
      await s.sr.runCycle();
      const [t] = await db.select().from(signalPaperTrades);
      if (t === undefined) throw new Error("no trade");
      expect(t.priceSource).toBe("rest_book");
      return {
        sr: s.sr,
        t,
        asked,
        set: (o: { now?: number; reply?: RestBookResult }) => {
          if (o.now !== undefined) now = o.now;
          if (o.reply !== undefined) reply = o.reply;
        },
      };
    }
    const tradeNow = async () => (await db.select().from(signalPaperTrades))[0];

    it("SL hit on the REST book closes at the observed price; reads at most every 15 s per market", async () => {
      const o = await openOnRest("SOL hack rest sl");
      const sl = Number(o.t.slPrice);
      // Short: SL chạm khi ask ≥ SL. Sổ REST báo giá trên SL.
      const above = (sl + 0.5).toFixed(2);
      o.asked.length = 0;
      o.set({
        now: T0 + 20_000,
        reply: { ok: true, bid: (sl + 0.4).toFixed(2), ask: above, at: 0 },
      });
      // Lượt đầu chưa nạp lệnh: tick đọc REST và đóng.
      expect(await o.sr.watcher.tick()).toBe(1);
      const c = await tradeNow();
      expect(c).toMatchObject({ status: "closed", exitReason: "stop_loss" });
      expect(Number(c?.exitPrice)).toBe(Number(above));
      expect(o.asked.map((a) => a.market)).toEqual(["SOL-USD"]);
    });

    it("no price at all: reads REST at most every 15 s; after the hold limit + 1 h closes max_hold_no_price with no result", async () => {
      const o = await openOnRest("SOL hack rest none");
      o.asked.length = 0;
      o.set({ now: T0 + 20_000, reply: { ok: false, reason: "empty" } });
      expect(await o.sr.watcher.tick()).toBe(0);
      o.set({ now: T0 + 30_000 });
      expect(await o.sr.watcher.tick()).toBe(0);
      expect(o.asked).toHaveLength(1);
      o.set({ now: T0 + 35_000 });
      expect(await o.sr.watcher.tick()).toBe(0);
      expect(o.asked).toHaveLength(2);
      const holdEnd = o.t.maxHoldUntil.getTime();
      // Đúng hạn giữ: đọc REST ngay (không chờ nhịp 15 s), vẫn không có giá → giữ mở.
      o.set({ now: holdEnd + 1_000 });
      expect(await o.sr.watcher.tick()).toBe(0);
      o.set({ now: holdEnd + 3_000 });
      const before = o.asked.length;
      expect(await o.sr.watcher.tick()).toBe(0);
      expect(o.asked).toHaveLength(before);
      // Chưa đủ 1 giờ sau hạn giữ: vẫn mở.
      o.set({ now: holdEnd + 3_600_000 - 1 });
      expect(await o.sr.watcher.tick()).toBe(0);
      expect((await tradeNow())?.status).toBe("open");
      o.set({ now: holdEnd + 3_600_000 });
      expect(await o.sr.watcher.tick()).toBe(1);
      expect(await tradeNow()).toMatchObject({
        status: "closed",
        exitReason: "max_hold_no_price",
        exitPrice: null,
        exitFee: null,
        resultUsdc: null,
        resultPct: null,
      });
      const ev = (await db.select().from(signalEvents)).find(
        (e) => e.reason === "MAX_HOLD_NO_PRICE",
      );
      expect(ev).toMatchObject({ stage: "watch", outcome: "close" });
      expect(ev?.detail).toMatchObject({ exitPrice: null, resultUsdc: null });
      // Không tính vào lãi / lỗ: tóm tắt đếm riêng.
      const summary = await loadSignalResearchSummary(db, new Date(holdEnd + 3_600_000), {
        sosoMonthlyLimit: 9500,
        claudeDailyInputBudget: 2_000_000,
      });
      expect(summary.funnel?.outcomes).toMatchObject({ closed: 0, maxHold: 0, maxHoldNoPrice: 1 });
      const page = await loadSignalResearchTrades(
        db,
        { limit: 50, show: "entered" },
        new Date(holdEnd + 3_600_000),
      );
      expect(page.items[0]?.result).toMatchObject({ outcome: "maxHoldNoPrice", pnl: null });
    });

    it("hold limit with a REST price closes max_hold at that price", async () => {
      const o = await openOnRest("SOL hack rest hold");
      const holdEnd = o.t.maxHoldUntil.getTime();
      o.set({ now: holdEnd + 1_000, reply: { ok: true, bid: "99.5", ask: "99.6", at: 0 } });
      expect(await o.sr.watcher.tick()).toBe(1);
      const c = await tradeNow();
      expect(c).toMatchObject({ status: "closed", exitReason: "max_hold" });
      expect(Number(c?.exitPrice)).toBe(99.6);
    });

    it("a market with a live book never reads REST", async () => {
      const o = await openOnRest("SOL hack rest live");
      o.asked.length = 0;
      o.set({ now: T0 + 20_000 });
      book(o.sr, "SOL-USD", "99.8", "99.9", T0 + 20_000);
      await o.sr.watcher.tick();
      expect(o.asked).toEqual([]);
    });
  });

  it("#507: a real but wide REST book (stock out of hours) is still blocked by the cost filter", async () => {
    const claude = fakeClaude({ "SOL hack wide": hack });
    const wide = setup({
      items: () => [
        item("w1", T0 - 2 * MIN, "SOL hack wide", { author: "Bloomberg", category: 5 }),
      ],
      claude,
      now: () => T0,
      last: { "SOL-USD": { price: "100", at: T0 - 2_000 } },
      requestBook: () => Promise.resolve({ ok: true, bid: "90", ask: "110", at: T0 }),
    });
    await wide.sr.runCycle();
    expect(await db.select().from(signalPaperTrades)).toEqual([]);
    const reasons = (
      await db.select().from(signalEvents).where(eq(signalEvents.articleId, "w1"))
    ).map((e) => e.reason);
    expect(reasons.some((r) => r === "MOVE_TOO_SMALL_FOR_COST" || r === "TOO_THIN_TO_TRADE")).toBe(
      true,
    );
    expect(reasons).not.toContain("NO_BOOK_DATA");
  });

  it("R2: a follow-up 28 h after a story that never traded merges as too old and never trades", async () => {
    const items = [item("o1", T0 - 2 * MIN, "SOL hack day one", { author: "Odaily" })];
    const claude = fakeClaude({ "SOL hack day one": hack, "SOL hack losses update": hack });
    const first = setup({ items: () => items, claude, now: () => T0 });
    await first.sr.runCycle(); // không có giá → bỏ, không khoá
    const now = T0 + 28 * HOUR;
    items.push(
      item("o2", now - MIN, "SOL hack losses update", { author: "Bloomberg", category: 5 }),
    );
    const later = setup({ items: () => items, claude, now: () => now });
    book(later.sr, "SOL-USD", "99.99", "100.01", now);
    await later.sr.runCycle();
    expect(await db.select().from(signalPaperTrades)).toHaveLength(0);
    const all = await db.select().from(signalEvents).where(eq(signalEvents.articleId, "o2"));
    expect(all.map((x) => `${x.stage}:${x.outcome}:${x.reason ?? ""}`)).toContain(
      "filter:merge:STORY_TOO_OLD",
    );
    expect(await db.select().from(signalStories)).toHaveLength(1);
  });

  it("R1: an article-level drop (promotional) never locks or adds a source; the real article then trades", async () => {
    const promo = { ...hack, promotional: true };
    const items = [item("p1", T0 - 2 * MIN, "promo SOL hack", { author: "kol" })];
    const claude = fakeClaude({ "promo SOL hack": promo, "real SOL hack": hack });
    const s = setup({ items: () => items, claude, now: () => T0 });
    book(s.sr, "SOL-USD", "99.99", "100.01", T0);
    await s.sr.runCycle();
    expect(await db.select().from(signalStories)).toHaveLength(0);
    const [drop] = await db
      .select()
      .from(signalEvents)
      .where(eq(signalEvents.reason, "PROMOTIONAL"));
    expect(drop).toMatchObject({ stage: "understand", outcome: "drop", storyId: null });
    items.push(item("p2", T0 - MIN, "real SOL hack", { author: "Bloomberg", category: 5 }));
    const now = T0 + MIN;
    const s2 = setup({ items: () => items, claude, now: () => now });
    book(s2.sr, "SOL-USD", "99.99", "100.01", now);
    await s2.sr.runCycle();
    const [t] = await db.select().from(signalPaperTrades);
    expect(t).toMatchObject({ articleId: "p2", retry: false, levelAtEntry: "medium" });
    const [st] = await db.select().from(signalStories);
    expect(st?.sources).toEqual([expect.objectContaining({ name: "Bloomberg" })]);
  });

  it("M4: the random baseline is stored once the hold window is over, and the summary reads it", async () => {
    const items = [item("r1", T0 - 2 * MIN, "SOL hack random", { author: "Odaily" })];
    const claude = fakeClaude({ "SOL hack random": hack });
    let now = T0;
    const s = setup({ items: () => items, claude, now: () => now });
    book(s.sr, "SOL-USD", "99.99", "100.01", T0);
    await s.sr.runCycle();
    // MFE / MAE null tới lần quan sát giá đầu tiên của watcher (không bao giờ 0 khi chưa thấy giá).
    const [opened] = await db.select().from(signalPaperTrades);
    expect(opened).toMatchObject({ mfePct: null, maePct: null });
    // Đóng ở hết giữ tối đa, rồi chu kỳ sau cửa sổ giữ: random được tính từ nến.
    const end = T0 + 24 * HOUR;
    now = end;
    book(s.sr, "SOL-USD", "99.99", "100.01", now);
    s.sr.watcher.invalidate();
    expect(await s.sr.watcher.tick()).toBe(1);
    const flat = [];
    for (let m = 1; m < 24 * 60; m += 1)
      flat.push({
        market: "SOL-USD",
        ts: new Date(T0 + m * MIN),
        open: "100",
        high: "100",
        low: "100",
        close: "100",
        volume: "1",
      });
    await db.insert(candles1m).values(flat).onConflictDoNothing();
    now = end + 5 * MIN;
    const later = setup({ items: () => [], claude, now: () => now });
    await later.sr.runCycle();
    const [t] = await db.select().from(signalPaperTrades);
    expect(t?.randomDoneAt).not.toBeNull();
    expect(t?.randomLongShare).toBe("0.000000000000000000");
    expect(t?.randomPct).not.toBeNull();
    await passCurrentClassifier();
    const summary = await loadSignalResearchSummary(db, new Date(now), {
      sosoMonthlyLimit: 9500,
      claudeDailyInputBudget: 2_000_000,
    });
    expect(summary.rows[0]?.randomPct).not.toBeNull();
    expect(summary.rows[0]?.clusters).toBe(1);
    expect(summary.directions.map((d) => d.side)).toEqual(["long", "short"]);
    expect(summary.directions[1]).toMatchObject({ side: "short", closed: 1 });
  });

  it("monthly SoSoValue cap: no request, no crash, source shows Delayed", async () => {
    await db.insert(signalResearchUsage).values({ day: "2026-11-01", sosoRequests: 9500 });
    const claude = fakeClaude({});
    const s = setup({ items: () => [item("q1", T0 - MIN, "x")], claude, now: () => T0 });
    await s.sr.runCycle();
    expect(s.soso.calls).toBe(0);
    expect(s.errors).toEqual([]);
    const summary = await loadSignalResearchSummary(db, new Date(T0), {
      sosoMonthlyLimit: 9500,
      claudeDailyInputBudget: 2_000_000,
    });
    expect(summary.sources.find((x) => x.key === "sosoNews")?.status).toBe("delayed");
  });

  it("the only network targets are SoSoValue and the Claude API (real clients, stubbed fetch)", async () => {
    const urls: string[] = [];
    const tool = {
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
        input_tokens: 100,
        output_tokens: 20,
        cache_creation_input_tokens: 4200,
        cache_read_input_tokens: 0,
      },
    };
    const soso = {
      code: 0,
      message: "success",
      data: {
        list: [
          {
            id: "f1",
            release_time: String(T0 - MIN),
            title: "SOL protocol exploited",
            content: "<p>exploit</p>",
            author: "Odaily",
            category: 1,
            matched_currencies: [{ currency_id: "1", symbol: "SOL", name: "Solana" }],
          },
        ],
      },
    };
    vi.stubGlobal("fetch", (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      urls.push(url);
      const body = url.startsWith(SOSO_BASE_URL) ? soso : tool;
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    });
    try {
      const errors: unknown[] = [];
      const sr = createSignalResearch({
        db,
        redis: { mget: (...keys: string[]) => Promise.resolve(keys.map(() => null)) },
        log: logger(errors),
        env: signalResearchEnvSchema.parse({
          SIGNAL_RESEARCH_ENABLED: "true",
          SOSO_API_KEY: "k",
          DESK_AI_API_KEY: "c",
        }),
        perps: () => PERPS,
        now: () => T0,
      });
      book(sr, "SOL-USD", "99.99", "100.01", T0);
      await sr.runCycle();
      await sr.watcher.tick();
      expect(errors).toEqual([]);
      expect(urls.length).toBeGreaterThanOrEqual(2);
      for (const u of urls)
        expect(u.startsWith(SOSO_BASE_URL) || u.startsWith("https://api.anthropic.com/")).toBe(
          true,
        );
      expect(await db.select().from(signalPaperTrades)).toHaveLength(1);
      const [f1] = await db.select().from(signalArticles).where(eq(signalArticles.id, "f1"));
      expect(f1).toMatchObject({
        claudeCalls: 1,
        claudeInputTokens: 100,
        claudeCacheWriteTokens: 4200,
        claudeCacheReadTokens: 0,
        claudeOutputTokens: 20,
        claudeModel: NEWS_CLASSIFIER.model,
        claudePromptVersion: NEWS_CLASSIFIER.promptVersion,
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("per-article Claude usage (#290)", () => {
  it("stores each article's own usage on the article; articles that never reach Claude stay null", async () => {
    await saveNewsState(db, T0 - 3 * 24 * HOUR, T0 - 3 * 24 * HOUR);
    const items = [
      item("u1", T0 - 2 * MIN, "SOL hack usage", { author: "Odaily" }),
      item("u2", T0 - MIN, "nothing here"),
      item("u3", T0 - 25 * HOUR, "stale usage"),
    ];
    const claude = fakeClaude({ "SOL hack usage": hack });
    const s = setup({
      items: () => items,
      claude,
      now: () => T0,
      env: { SIGNAL_NEWS_MAX_CATCHUP_MIN: String(4 * 24 * 60) },
    });
    book(s.sr, "SOL-USD", "99.99", "100.01", T0);
    await s.sr.runCycle();
    const rows = new Map((await db.select().from(signalArticles)).map((r) => [r.id, r] as const));
    for (const id of ["u1", "u2"])
      expect(rows.get(id)).toMatchObject({
        claudeCalls: 1,
        claudeInputTokens: 1500,
        claudeCacheWriteTokens: 0,
        claudeCacheReadTokens: 0,
        claudeOutputTokens: 40,
        claudeModel: NEWS_CLASSIFIER.model,
        claudePromptVersion: NEWS_CLASSIFIER.promptVersion,
      });
    // 1 500 × 1 / 1M + 40 × 5 / 1M = 0.0017 USD
    const u1 = rows.get("u1");
    expect(u1 === undefined ? undefined : articleClaudeUsage(u1)?.costUsd).toBe("0.0017");
    const u3 = rows.get("u3");
    expect(u3).toMatchObject({ status: "dropped", claudeCalls: null, claudeInputTokens: null });
    expect(u3 === undefined ? undefined : articleClaudeUsage(u3)).toBeNull();
    // Bảng ngày vẫn cộng như cũ: tổng của các bài = số trong ngày.
    const [day] = await db.select().from(signalResearchUsage);
    expect(day).toMatchObject({ claudeCalls: 2, claudeInputTokens: 3000, claudeOutputTokens: 80 });
  });

  it("unknown usage (a call without a response) leaves the token columns null and the $ Not available", async () => {
    const items = [item("n1", T0 - MIN, "network trouble")];
    const claude: NewsClassifier = {
      classify: () =>
        Promise.resolve({
          ok: false as const,
          error: "api:APIConnectionError",
          usage: { ...emptyUsage(), calls: 2, input: 500, output: 10 },
          usageKnown: false,
        }),
    };
    const { sr } = setup({ items: () => items, claude, now: () => T0 });
    await sr.runCycle();
    const [a] = await db.select().from(signalArticles).where(eq(signalArticles.id, "n1"));
    expect(a).toMatchObject({
      status: "classified",
      claudeCalls: 2,
      claudeInputTokens: null,
      claudeOutputTokens: null,
    });
    expect(a === undefined ? undefined : articleClaudeUsage(a)).toMatchObject({
      calls: 2,
      tokens: null,
      costUsd: null,
    });
  });
});

describe("news-v3 (#298): asset in text, treasury on BTC / ETH, small treasury, version gate", () => {
  const perps = () => [
    ...PERPS,
    { name: "LINK-USD", status: "TRADING", tickSize: "0.001", takerFee: "0.0004" },
  ];

  it("drops a tag-only asset and treasury on BTC after Claude; flags small treasury on other coins", async () => {
    const items = [
      item("v1", T0 - 3 * MIN, "Coinbase adds three new tokens", {
        matched_currencies: [{ symbol: "LINK", name: "CHAINLINK" }],
      }),
      item("v2", T0 - 2 * MIN, "Small firm F sells 12 BTC to cover costs", {
        matched_currencies: [{ symbol: "BTC", name: "Bitcoin" }],
      }),
      item("v3", T0 - MIN, "Company G says it bought Solana for its treasury"),
    ];
    const claude = fakeClaude({
      "Coinbase adds three new tokens": { ...hack, catalyst: "listing", market: "LINK-USD" },
      "Small firm F sells 12 BTC to cover costs": {
        ...hack,
        catalyst: "treasury_sell",
        market: "BTC-USD",
        treasuryAmount: "12 BTC",
      },
      "Company G says it bought Solana for its treasury": {
        ...hack,
        catalyst: "treasury_buy",
        treasuryAmount: null,
      },
    });
    const { sr, errors } = setup({ items: () => items, claude, now: () => T0, perps });
    await sr.runCycle();
    expect(errors).toEqual([]);

    const ev = await db
      .select({
        articleId: signalEvents.articleId,
        outcome: signalEvents.outcome,
        reason: signalEvents.reason,
        detail: signalEvents.detail,
      })
      .from(signalEvents)
      .where(eq(signalEvents.stage, "understand"));
    const by = new Map(ev.map((e) => [e.articleId, e]));
    expect(by.get("v1")).toMatchObject({ outcome: "drop", reason: "ASSET_NOT_IN_TEXT" });
    expect(by.get("v2")).toMatchObject({ outcome: "drop", reason: "TREASURY_MAJOR_ASSET" });
    expect(by.get("v3")).toMatchObject({
      outcome: "pass",
      reason: null,
      detail: { market: "SOL-USD", catalyst: "treasury_buy", smallTreasury: true },
    });
    const [a3] = await db.select().from(signalArticles).where(eq(signalArticles.id, "v3"));
    expect(a3?.classification).toMatchObject({ treasuryAmount: null, smallTreasury: true });
    const [a2] = await db.select().from(signalArticles).where(eq(signalArticles.id, "v2"));
    expect(a2?.classification).toMatchObject({ treasuryAmount: "12 BTC" });
    expect(a2?.classification).not.toHaveProperty("smallTreasury");
    // Bỏ ở Understand vì lỗi của bài: không tạo story cho LINK / BTC.
    const stories = await db.select({ market: signalStories.market }).from(signalStories);
    expect(stories.map((s) => s.market)).toEqual(["SOL-USD"]);

    const summary = await loadSignalResearchSummary(db, new Date(T0), {
      sosoMonthlyLimit: 9500,
      claudeDailyInputBudget: 2_000_000,
    });
    expect(summary.funnel?.drops.score.reasons).toEqual(
      expect.arrayContaining([
        { reason: "assetNotInText", n: 1 },
        { reason: "treasuryMajorAsset", n: 1 },
      ]),
    );
  });

  it("news-v2 trades stay in the trade list as history but never count toward the summary / gate", async () => {
    const storyId = "00000000-0000-4000-8000-000000000298";
    const tradeId = "00000000-0000-4000-8000-000000000299";
    await pool.query(
      `insert into signal_articles (id, source, title, published_at, collected_at, matched_currencies, candidates, content_hash, status, rule_version)
       values ('old-1', 'Bloomberg', 'Old v2 story', '2026-11-17T10:00:00Z', '2026-11-17T10:03:00Z', '[]', '[]', 'old', 'classified', 'news-v2')`,
    );
    await pool.query(
      `insert into signal_stories (id, story_key, market, catalyst, direction, first_article_id, first_seen_at, sources, level_at_entry, later_level, outcome, locked, rule_version)
       values ($1, 'SOL-USD|regulatory_action', 'SOL-USD', 'regulatory_action', 'short', 'old-1', '2026-11-17T10:03:00Z',
               '[{"name":"Bloomberg","tier":"top","articleId":"old-1","at":"2026-11-17T10:00:00.000Z"}]', 'medium', 'medium', 'entered', true, 'news-v2')`,
      [storyId],
    );
    await pool.query(
      `insert into signal_paper_trades (id, lane, story_id, article_id, market, token, catalyst, direction, size_usdc, qty, entry_price, entry_mid,
         spread_at_entry_pct, fee_pct, entry_fee, typical_move_pct, tp_pct, sl_pct, tp_price, sl_price, max_hold_until, event_at, seen_at, opened_at,
         moved_before_entry_pct, level_at_entry, sources_at_entry, outside_market_hours, price_source, status, exit_price, exit_reason, exited_at,
         exit_fee, result_usdc, result_pct, rule_version)
       values ($1, 'news', $2, 'old-1', 'SOL-USD', 'SOL', 'regulatory_action', 'short', 500, 3.5, 142.18, 142.2, 0.03, 0.05, 0.25, 1.33,
         2, 1, 139.34, 143.6, '2026-11-20T10:03:00Z', '2026-11-17T10:00:00Z', '2026-11-17T10:03:00Z', '2026-11-17T10:03:05Z', -0.6, 'medium',
         '[{"name":"Bloomberg","tier":"top"}]', false, 'book', 'closed', 139.3, 'take_profit', '2026-11-18T09:12:00Z', 0.24, 9.5, 1.9, 'news-v2')`,
      [tradeId, storyId],
    );
    expect(NEWS_RULES.version).toBe("news-v6");
    // Một chu kỳ của version hiện tại (bài không phải tín hiệu) để lane có dữ liệu của version hiện tại.
    const { sr } = setup({
      items: () => [item("now-1", T0 - MIN, "SOL market recap")],
      claude: fakeClaude({}),
      now: () => T0,
    });
    await sr.runCycle();

    const summary = await loadSignalResearchSummary(db, new Date(T0), {
      sosoMonthlyLimit: 9500,
      claudeDailyInputBudget: 2_000_000,
    });
    expect(summary.rows[0]).toMatchObject({
      rulesVersion: 5,
      closed: 0,
      opened: 0,
    });
    expect(summary.funnel?.outcomes).toEqual({
      closed: 0,
      tp: 0,
      sl: 0,
      maxHold: 0,
      maxHoldNoPrice: 0,
      opposite: 0,
      open: 0,
    });
    expect(summary.assets).not.toContain("SOL-USD");

    // #344: mặc định danh sách chỉ có quy tắc hiện tại; news-v2 hiện khi bật "Show older rules" (olderRules=true).
    const page = await loadSignalResearchTrades(db, { limit: 50, show: "all" }, new Date(T0));
    expect(page.items.map((i) => i.id)).not.toContain(tradeId);
    const older = await loadSignalResearchTrades(
      db,
      { limit: 50, show: "all", olderRules: "true" },
      new Date(T0),
    );
    expect(older.items.find((i) => i.id === tradeId)).toMatchObject({ rulesVersion: 2 });
    expect(summary.olderRules).toEqual({ trades: 1, versions: [2] });
    const detail = await loadSignalResearchTrade(db, tradeId, new Date(T0));
    expect(detail).toMatchObject({ rulesVersion: 2 });
  });
});

describe("#309: company tags use the SoDEX market list, asset map version", () => {
  it("keeps a SpaceX tag as SPCX-USD (stock) and still drops Anthropic and a coin on COIN-USD", async () => {
    const perps = () => [
      ...PERPS,
      { name: "SPCX-USD", status: "TRADING", tickSize: "0.01", takerFee: "0.0004" },
      { name: "COIN-USD", status: "TRADING", tickSize: "0.01", takerFee: "0.0004" },
    ];
    const items = [
      item("spx", T0 - 3 * MIN, "SpaceX files for an IPO", {
        matched_currencies: [{ symbol: "SPCX", name: '{"EN":"SPACEX"}' }],
      }),
      item("ant", T0 - 2 * MIN, "Anthropic raises a new round", {
        matched_currencies: [{ symbol: "ANT", name: '{"EN":"ANTHROPIC"}' }],
      }),
      item("coin", T0 - MIN, "COIN token rallies", {
        matched_currencies: [{ symbol: "COIN", name: "Some Coin" }],
      }),
    ];
    const { sr, errors } = setup({
      items: () => items,
      claude: fakeClaude({}),
      now: () => T0,
      perps,
    });
    await sr.runCycle();
    expect(errors).toEqual([]);
    const rows = await db.select().from(signalArticles);
    const by = new Map(rows.map((r) => [r.id, r]));
    expect(by.get("spx")?.candidates).toEqual([
      { symbol: "SPCX", market: "SPCX-USD", kind: "stock" },
    ]);
    expect(by.get("spx")?.status).not.toBe("dropped");
    expect(by.get("ant")).toMatchObject({ status: "dropped", candidates: [] });
    expect(by.get("coin")).toMatchObject({ status: "dropped", candidates: [] });
    const drops = await db
      .select({
        articleId: signalEvents.articleId,
        reason: signalEvents.reason,
        detail: signalEvents.detail,
      })
      .from(signalEvents)
      .where(eq(signalEvents.stage, "normalize"));
    const assets = { assetMapVersion: NEWS_ASSET_MAP_VERSION };
    expect(drops).toEqual(
      expect.arrayContaining([
        { articleId: "ant", reason: "NO_SODEX_MARKET", detail: assets },
        { articleId: "coin", reason: "NO_SODEX_MARKET", detail: assets },
        { articleId: "spx", reason: null, detail: { candidates: ["SPCX-USD"], ...assets } },
      ]),
    );
    // Đổi danh sách tài sản không đổi version quy tắc (không reset cổng).
    expect(NEWS_RULES.version).toBe("news-v6");
    expect(NEWS_ASSET_MAP_VERSION).toMatch(/^assets-\d{4}-\d{2}-\d{2}[a-z]$/);
    expect(drops.some((d) => d.articleId === "spx" && d.reason !== null)).toBe(false);
  });
});

describe("latency clocks (#375)", () => {
  it("stores Claude start / done and decided / opened from the scheduler clock; opened_at stays the cycle start", async () => {
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
      item("lat1", T0 - 4 * MIN, "Protocol on Solana drained in exploit", {
        author: "Bloomberg",
        category: 5,
      }),
      item("lat2", T0 - 2 * MIN, "Unrelated stock", {
        matched_currencies: [{ symbol: "ANT", name: '{"EN": "ANTHROPIC"}' }],
      }),
    ];
    const claude = fakeClaude({ "Protocol on Solana drained in exploit": hack });
    // Đồng hồ đi 50 ms mỗi lần đọc: lần đọc đầu = giờ bắt đầu chu kỳ (T0).
    let reads = 0;
    const clock = () => T0 + 50 * reads++;
    const { sr, errors } = setup({ items: () => items, claude, now: clock });
    book(sr, "SOL-USD", "99.99", "100.01", T0);
    await sr.runCycle();
    expect(errors).toEqual([]);

    const arts = new Map((await db.select().from(signalArticles)).map((a) => [a.id, a]));
    const a1 = arts.get("lat1");
    if (a1 === undefined) throw new Error("lat1 missing");
    expect(a1.collectedAt.getTime()).toBe(T0);
    const started = a1.claudeStartedAt?.getTime() ?? NaN;
    const done = a1.claudeDoneAt?.getTime() ?? NaN;
    expect(started).toBeGreaterThan(T0);
    expect(done).toBeGreaterThan(started);
    // `classified_at` vẫn là giờ bắt đầu chu kỳ (không đổi), nên không dùng để đo.
    expect(a1.classifiedAt?.getTime()).toBe(T0);
    // Bài không tới Claude: không có mốc.
    expect(arts.get("lat2")?.claudeStartedAt).toBeNull();
    expect(arts.get("lat2")?.claudeDoneAt).toBeNull();

    const evs = await db.select().from(signalEvents).where(eq(signalEvents.articleId, "lat1"));
    const decided = evs.filter((e) => e.stage === "filter" || e.stage === "decide");
    expect(decided.length).toBeGreaterThan(0);
    for (const e of decided) {
      expect(e.at.getTime()).toBe(T0);
      expect(e.decidedClockAt?.getTime() ?? NaN).toBeGreaterThan(done);
    }
    // Bước dùng chung không có mốc quyết định.
    expect(
      evs.filter((e) => e.stage === "understand").every((e) => e.decidedClockAt === null),
    ).toBe(true);

    const [t] = await db.select().from(signalPaperTrades);
    if (t === undefined) throw new Error("no trade");
    expect(t.openedAt.getTime()).toBe(T0);
    expect(t.maxHoldUntil.getTime()).toBe(T0 + 24 * HOUR);
    const dAt = t.decidedClockAt?.getTime() ?? NaN;
    const oAt = t.openedClockAt?.getTime() ?? NaN;
    expect(dAt).toBeGreaterThan(done);
    expect(oAt).toBeGreaterThan(dAt);
    // Event Decide · open mang đúng mốc quyết định của lệnh.
    expect(decided.find((e) => e.stage === "decide")?.decidedClockAt?.getTime()).toBe(dAt);
  });
});

// #394: chu kỳ chỉnh bằng env, trần 20 request / phút của SoSoValue, 429 / 42901.
describe("SoSoValue rate limit in the news cycle", () => {
  const health = async () => {
    const r = await pool.query<{
      last_error: string | null;
      last_ok_at: Date | null;
      last_cycle_at: Date | null;
      watermark_at: Date | null;
    }>(
      "select last_error, last_ok_at, last_cycle_at, watermark_at from signal_source_health where source = 'sosovalue'",
    );
    return r.rows[0];
  };
  const articles = async () =>
    Number((await pool.query<{ n: string }>("select count(*) n from signal_articles")).rows[0]?.n);
  const sosoUsed = async () =>
    Number(
      (
        await pool.query<{ n: string | null }>(
          "select sum(soso_requests) n from signal_research_usage",
        )
      ).rows[0]?.n ?? 0,
    );
  /** 150 bài mới, mỗi giây một bài trước `at`: trang 1 đầy và toàn bài mới → cần trang 2. */
  const burst = (at: number) =>
    Array.from({ length: 150 }, (_, i) =>
      item(`b${String(i)}`, at - (i + 1) * 1_000, `Story ${String(i)}`, {
        matched_currencies: [{ symbol: "BTC", name: "Bitcoin" }],
      }),
    );

  it.each([
    ["HTTP 429", () => new SosoError("SoSoValue answered 429", 429, 42901)],
    ["code 42901 in the body", () => new SosoError("SoSoValue answered 200", 200, 42901)],
  ])(
    "%s on page 2: stops the cycle, marks rate_limited, no retry, nothing saved, the cursor stays; the next cycle gets every article",
    async (_name, err) => {
      let now = T0;
      const first = setup({ items: () => [], claude: fakeClaude({}), now: () => now });
      await first.sr.runCycle();
      const before = await health();
      expect(before?.last_cycle_at?.getTime()).toBe(T0);

      now = T0 + MIN;
      const items = burst(now);
      const calls: number[] = [];
      const limited: SosoClient = {
        newsPage(page) {
          calls.push(page);
          if (page === 2) return Promise.reject(err());
          return Promise.resolve({
            items: [...items].slice(0, 100),
            invalid: 0,
          });
        },
      };
      const { sr, errors } = setup({
        items: () => items,
        claude: fakeClaude({}),
        now: () => now,
        soso: limited,
      });
      await sr.runCycle();
      expect(errors).toEqual([]);
      // Trang 1, rồi trang 2 bị chặn: không thử lại trang 2 hay trang nào khác trong chu kỳ này.
      expect(calls).toEqual([1, 2]);
      const after = await health();
      expect(after?.last_error).toBe("rate_limited");
      // Con trỏ không tiến; trang 1 đã lấy cũng không lưu (để chu kỳ sau đọc lại cả trang 2).
      expect(after?.last_cycle_at?.getTime()).toBe(before?.last_cycle_at?.getTime());
      expect(after?.watermark_at?.getTime()).toBe(before?.watermark_at?.getTime());
      expect(after?.last_ok_at?.getTime()).toBe(T0);
      expect(await articles()).toBe(0);
      const summary = await loadSignalResearchSummary(db, new Date(now), {
        sosoMonthlyLimit: 9500,
        claudeDailyInputBudget: 1000,
        cycleMinutes: 1,
      });
      // Bị giới hạn tốc độ: chủ ý chờ chu kỳ sau → "Delayed", không "Down".
      expect(summary.sources.find((s) => s.key === "sosoNews")?.status).toBe("delayed");
      expect(summary.cycleMinutes).toBe(1);

      // Chu kỳ sau, SoSoValue trả lại bình thường: đủ 150 bài, không mất bài nào.
      now = T0 + 2 * MIN;
      const ok = setup({ items: () => items, claude: fakeClaude({}), now: () => now });
      await ok.sr.runCycle();
      expect(ok.soso.calls).toBe(2);
      expect(await articles()).toBe(150);
      expect((await health())?.last_cycle_at?.getTime()).toBe(now);
    },
  );

  it("never sends more than 20 requests a minute, counting every page; blocked requests are not sent or counted", async () => {
    const now = T0;
    const { sr, soso } = setup({
      items: () => [item("x1", T0 - MIN, "One story")],
      claude: fakeClaude({}),
      now: () => now,
      env: { SIGNAL_NEWS_CYCLE_MINUTES: "1" },
    });
    // 21 lần tới nhịp trong cùng một phút (mỗi chu kỳ 1 trang): lần thứ 21 bị chặn phía DeskLabs.
    for (let i = 0; i < 21; i += 1) await sr.runCycle();
    expect(soso.calls).toBe(20);
    expect(await sosoUsed()).toBe(20);
    expect((await health())?.last_error).toBe("rate_limited");
    expect(await articles()).toBe(1);
  });

  it("pages of one cycle count toward the minute: page 2 is blocked once 20 are used", async () => {
    let t = T0;
    const items = burst(T0);
    const { sr, soso } = setup({ items: () => items, claude: fakeClaude({}), now: () => t });
    // Dùng hết 19 lượt trong phút này bằng 19 chu kỳ 1 trang (sau chu kỳ đầu, trang 1 đã biết → không đọc trang 2).
    await sr.runCycle(); // 2 trang (trang 1 đầy, toàn bài mới)
    for (let i = 0; i < 17; i += 1) await sr.runCycle();
    expect(soso.calls).toBe(19);
    // Sang phút sau một chút: 2 request đầu (ở T0) vẫn trong cửa sổ trượt.
    t = T0 + 30_000;
    // 100 bài mới hơn mọi bài đã lưu: trang 1 đầy, toàn bài mới → cần trang 2.
    const fresh = Array.from({ length: 100 }, (_, i) =>
      item(`n${String(i)}`, t - (i + 1) * 100, `New ${String(i)}`, {
        matched_currencies: [{ symbol: "BTC", name: "Bitcoin" }],
      }),
    );
    items.unshift(...fresh);
    await sr.runCycle(); // trang 1 (lượt 20) đầy, toàn bài mới → cần trang 2, bị chặn
    expect(soso.calls).toBe(20);
    expect((await health())?.last_error).toBe("rate_limited");
  });

  it("the scheduler writes the cycle it uses to sr:lane on every tick", async () => {
    const { sr, written } = setup({
      items: () => [],
      claude: fakeClaude({}),
      now: () => T0,
      env: { SIGNAL_NEWS_CYCLE_MINUTES: "1" },
    });
    expect(sr.cycleMinutes).toBe(1);
    await sr.runCycle();
    const lane = written.get("sr:lane");
    expect(lane?.ms).toBe(15 * MIN);
    expect(JSON.parse(lane?.value ?? "null")).toEqual({
      cycleMinutes: 1,
      sosoMonthlyLimit: 9500,
      updatedAt: new Date(T0).toISOString(),
    });
  });
});

describe("news-v4 (#395): ETF on BTC / ETH, in-flight articles of the previous rules", () => {
  const perps = () => [
    ...PERPS,
    { name: "ETH-USD", status: "TRADING", tickSize: "0.01", takerFee: "0.0004" },
  ];

  it("drops ETF news on BTC and ETH at Score (ETF_MAJOR_ASSET), keeps ETF news on other coins", async () => {
    const items = [
      item("e1", T0 - 3 * MIN, "New BTC fund lists in Hong Kong", {
        matched_currencies: [{ symbol: "BTC", name: "Bitcoin" }],
      }),
      item("e2", T0 - 2 * MIN, "Regulator delays a decision on an ETH product", {
        matched_currencies: [{ symbol: "ETH", name: "Ethereum" }],
      }),
      item("e3", T0 - MIN, "Regulator approves the first SOL fund"),
    ];
    const claude = fakeClaude({
      "New BTC fund lists in Hong Kong": { ...hack, catalyst: "etf_approved", market: "BTC-USD" },
      "Regulator delays a decision on an ETH product": {
        ...hack,
        catalyst: "etf_delayed_or_rejected",
        market: "ETH-USD",
      },
      "Regulator approves the first SOL fund": { ...hack, catalyst: "etf_approved" },
    });
    const { sr, errors } = setup({ items: () => items, claude, now: () => T0, perps });
    await sr.runCycle();
    expect(errors).toEqual([]);

    const ev = await db
      .select({
        articleId: signalEvents.articleId,
        outcome: signalEvents.outcome,
        reason: signalEvents.reason,
        ruleVersion: signalEvents.ruleVersion,
      })
      .from(signalEvents)
      .where(eq(signalEvents.stage, "understand"));
    const by = new Map(ev.map((e) => [e.articleId, e]));
    expect(by.get("e1")).toMatchObject({ outcome: "drop", reason: "ETF_MAJOR_ASSET" });
    expect(by.get("e2")).toMatchObject({ outcome: "drop", reason: "ETF_MAJOR_ASSET" });
    expect(by.get("e3")).toMatchObject({
      outcome: "pass",
      reason: null,
      ruleVersion: NEWS_RULES.version,
    });
    // Lỗi của bài: không tạo story cho BTC / ETH.
    const stories = await db.select({ market: signalStories.market }).from(signalStories);
    expect(stories.map((s) => s.market)).toEqual(["SOL-USD"]);

    const summary = await loadSignalResearchSummary(db, new Date(T0), {
      sosoMonthlyLimit: 9500,
      claudeDailyInputBudget: 2_000_000,
    });
    expect(summary.funnel?.drops.score.reasons).toEqual(
      expect.arrayContaining([{ reason: "etfMajorAsset", n: 2 }]),
    );
  });

  it("moves news-v3 articles still collected / pending at deploy to the current rules with their events, then classifies them", async () => {
    const sol = JSON.stringify([{ symbol: "SOL", name: "Solana" }]);
    await pool.query(
      `insert into signal_articles (id, source, title, content, published_at, collected_at, matched_currencies, candidates, content_hash, status, rule_version)
       values ('p-v3', 'Odaily', 'Solana lending protocol drained', 'Solana lending protocol drained', $1, $1, $2,
               '[{"market":"SOL-USD","symbol":"SOL","kind":"crypto"}]', 'h-p-v3', 'pending', 'news-v3'),
              ('c-v3', 'Odaily', 'Solana bridge exploited', 'Solana bridge exploited', $1, $1, $2, '[]', 'h-c-v3', 'collected', 'news-v3'),
              ('done-v3', 'Odaily', 'Old classified story', 'Old classified story', $1, $1, $2, '[]', 'h-done', 'classified', 'news-v3')`,
      [new Date(T0 - 4 * MIN), sol],
    );
    await pool.query(
      `insert into signal_events (id, article_id, stage, outcome, rule_version, at)
       values (gen_random_uuid(), 'p-v3', 'collect', 'pass', 'news-v3', $1),
              (gen_random_uuid(), 'p-v3', 'normalize', 'pass', 'news-v3', $1),
              (gen_random_uuid(), 'c-v3', 'collect', 'pass', 'news-v3', $1),
              (gen_random_uuid(), 'done-v3', 'understand', 'drop', 'news-v3', $1)`,
      [new Date(T0 - 4 * MIN)],
    );
    const claude = fakeClaude({
      "Solana lending protocol drained": hack,
      "Solana bridge exploited": hack,
    });
    const { sr, errors } = setup({ items: () => [], claude, now: () => T0 });
    await sr.runCycle();
    expect(errors).toEqual([]);

    // Bài dở dang chạy tiếp theo luật và prompt hiện tại; không bài nào bị bỏ rơi.
    expect(claude.titles.sort()).toEqual([
      "Solana bridge exploited",
      "Solana lending protocol drained",
    ]);
    const arts = await db
      .select({
        id: signalArticles.id,
        status: signalArticles.status,
        rule: signalArticles.ruleVersion,
      })
      .from(signalArticles);
    const a = new Map(arts.map((x) => [x.id, x]));
    expect(a.get("p-v3")).toMatchObject({ status: "classified", rule: NEWS_RULES.version });
    expect(a.get("c-v3")).toMatchObject({ status: "classified", rule: NEWS_RULES.version });
    // Bài v3 đã xong giữ nguyên là lịch sử của v3.
    expect(a.get("done-v3")).toMatchObject({ status: "classified", rule: "news-v3" });

    const ev = await db
      .select({
        articleId: signalEvents.articleId,
        stage: signalEvents.stage,
        rule: signalEvents.ruleVersion,
      })
      .from(signalEvents);
    // Event Collect / Normalize cũ đi cùng bài sang version hiện tại (trace và phễu không tách đôi).
    for (const e of ev.filter((x) => x.articleId === "p-v3" || x.articleId === "c-v3"))
      expect(e.rule).toBe(NEWS_RULES.version);
    expect(ev.filter((x) => x.articleId === "p-v3").map((x) => x.stage)).toEqual(
      expect.arrayContaining(["collect", "normalize", "understand"]),
    );
    expect(ev.find((x) => x.articleId === "done-v3")?.rule).toBe("news-v3");

    // Lần chạy sau không còn gì để chuyển.
    expect(await adoptInFlightArticles(db)).toBe(0);
  });
});

describe("news-v5 (#506): listing on BTC / ETH", () => {
  const perps = () => [
    ...PERPS,
    { name: "ETH-USD", status: "TRADING", tickSize: "0.01", takerFee: "0.0004" },
  ];

  it("drops listing news on BTC and ETH at Score (LISTING_MAJOR_ASSET), keeps listings of other coins and delisting", async () => {
    const items = [
      item("l1", T0 - 4 * MIN, "Exchange adds BTC spot trading", {
        matched_currencies: [{ symbol: "BTC", name: "Bitcoin" }],
      }),
      item("l2", T0 - 3 * MIN, "Exchange lists ETH perpetuals", {
        matched_currencies: [{ symbol: "ETH", name: "Ethereum" }],
      }),
      item("l3", T0 - 2 * MIN, "Major exchange will list SOL"),
      item("l4", T0 - MIN, "Exchange delists BTC pairs", {
        matched_currencies: [{ symbol: "BTC", name: "Bitcoin" }],
      }),
    ];
    const claude = fakeClaude({
      "Exchange adds BTC spot trading": { ...hack, catalyst: "listing", market: "BTC-USD" },
      "Exchange lists ETH perpetuals": { ...hack, catalyst: "listing", market: "ETH-USD" },
      "Major exchange will list SOL": { ...hack, catalyst: "listing" },
      "Exchange delists BTC pairs": { ...hack, catalyst: "delisting", market: "BTC-USD" },
    });
    const { sr, errors } = setup({ items: () => items, claude, now: () => T0, perps });
    await sr.runCycle();
    expect(errors).toEqual([]);

    const ev = await db
      .select({
        articleId: signalEvents.articleId,
        outcome: signalEvents.outcome,
        reason: signalEvents.reason,
        ruleVersion: signalEvents.ruleVersion,
      })
      .from(signalEvents)
      .where(eq(signalEvents.stage, "understand"));
    const by = new Map(ev.map((e) => [e.articleId, e]));
    expect(by.get("l1")).toMatchObject({
      outcome: "drop",
      reason: "LISTING_MAJOR_ASSET",
      ruleVersion: NEWS_RULES.version,
    });
    expect(by.get("l2")).toMatchObject({ outcome: "drop", reason: "LISTING_MAJOR_ASSET" });
    expect(by.get("l3")).toMatchObject({ outcome: "pass", reason: null });
    // Delisting không thuộc luật này.
    expect(by.get("l4")).toMatchObject({ outcome: "pass", reason: null });
    // Listing BTC / ETH không tạo story.
    const stories = await db.select({ market: signalStories.market }).from(signalStories);
    expect(stories.map((s) => s.market).sort()).toEqual(["BTC-USD", "SOL-USD"]);

    const summary = await loadSignalResearchSummary(db, new Date(T0), {
      sosoMonthlyLimit: 9500,
      claudeDailyInputBudget: 2_000_000,
    });
    expect(summary.funnel?.drops.score.reasons).toEqual(
      expect.arrayContaining([{ reason: "listingMajorAsset", n: 2 }]),
    );
  });
});

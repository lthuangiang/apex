import {
  bots,
  botVersions,
  candles1m,
  createDb,
  newsSignals,
  runMigrations,
  signalPaperTrades,
  sodexAccounts,
  users,
  type Db,
} from "@drift/db";
import {
  baselineVersionConfig,
  NEWS_ASSET_MAP_VERSION,
  NEWS_CLASSIFIER,
  NEWS_RULES,
  NEWS_SIGNAL_TTL_MS,
} from "@drift/shared";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { sql } from "drizzle-orm";
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
import { publishNewsSignals, type NewsSignalArticle } from "../src/signal-research/news-signals";
import type { SosoClient, SosoNewsItem } from "../src/signal-research/soso";

// Tín hiệu mainnet dùng chung (#419 PR 4) trên Postgres thật: chu kỳ tin ghi `news_signals` khi cờ bật, idempotent theo
// story key × chu kỳ, thiếu giá thì null, NATS lỗi không làm hỏng chu kỳ, research versions không đổi. SoSoValue / Claude
// là mock; không có SoDEX.

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
  const rows = [];
  for (let h = 31 * 24; h >= 1; h -= 1) {
    const ts = T0 - h * HOUR;
    const close = Math.floor(ts / (24 * HOUR)) % 2 === 0 ? "100" : "102";
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
  // `news_signals` bất biến (trigger chặn DELETE); TRUNCATE không qua trigger dòng.
  await db.execute(
    sql`truncate news_signals cascade; truncate signal_articles, signal_events, signal_stories, signal_paper_trades, signal_research_usage, signal_source_health, signal_contexts`,
  );
});

const item = (id: string, at: number, title: string): SosoNewsItem => ({
  id,
  release_time: at,
  title,
  content: `<p>${title}</p>`,
  author: "Odaily",
  category: 1,
  source_link: `https://sosovalue.com/${id}`,
  original_link: null,
  matched_currencies: [{ symbol: "SOL", name: "Solana" }],
});

const fakeSoso = (items: SosoNewsItem[]): SosoClient => ({
  newsPage: () => Promise.resolve({ items, invalid: 0 }),
});

const hack: Classification = {
  catalyst: "hack_exploit",
  market: "SOL-USD",
  relevance: "direct",
  promotional: false,
  eventDate: "2026-11-18",
};

const claude: NewsClassifier = {
  classify: (input) =>
    Promise.resolve({
      ok: true as const,
      value:
        input.title === "Solana protocol drained in exploit"
          ? hack
          : { ...hack, catalyst: "none" as const },
      usage: { ...emptyUsage(), calls: 1, input: 1500, output: 40 },
    }),
};

const quiet: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => quiet,
};

function setup(opts: { publish: boolean; notify?: (id: string) => void; withBook?: boolean }) {
  const sr = createSignalResearch({
    db,
    redis: { mget: (...keys: string[]) => Promise.resolve(keys.map(() => null)) },
    log: quiet,
    env: signalResearchEnvSchema.parse({
      SIGNAL_RESEARCH_ENABLED: "true",
      SOSO_API_KEY: "k",
      DESK_AI_API_KEY: "c",
      SIGNAL_NEWS_PUBLISH_ENABLED: opts.publish ? "true" : "false",
    }),
    perps: () => [{ name: "SOL-USD", status: "TRADING", tickSize: "0.01", takerFee: "0.0004" }],
    now: () => T0,
    soso: fakeSoso([item("a1", T0 - 2 * MIN, "Solana protocol drained in exploit")]),
    classifier: claude,
    ...(opts.notify === undefined ? {} : { notifySignal: opts.notify }),
  });
  if (opts.withBook !== false)
    sr.books.onMessage(
      "md.sol-usd.book",
      JSON.stringify({ s: "SOL-USD", b: "99.99", a: "100.01", E: T0, at: T0 }),
      T0,
    );
  return sr;
}

const signals = () => db.select().from(newsSignals);
const paperTrades = () => db.select().from(signalPaperTrades);

describe("news_signals from the news cycle", () => {
  it("writes exactly one row for an eligible story, with TTL, quote, typical and versions, then rings NATS", async () => {
    const rung: string[] = [];
    await setup({ publish: true, notify: (id) => rung.push(id) }).runCycle();
    const rows = await signals();
    expect(rows).toHaveLength(1);
    const [s] = rows;
    expect(s).toMatchObject({
      storyKey: "SOL-USD|hack_exploit",
      articleId: "a1",
      market: "SOL-USD",
      kind: "crypto",
      catalyst: "hack_exploit",
      side: "short",
      level: "low",
      classifierVersion: NEWS_CLASSIFIER.promptVersion,
      assetMapVersion: NEWS_ASSET_MAP_VERSION,
      ruleVersion: NEWS_RULES.version,
      // #530 PR2: tin một coin giữ đường cũ (không event key, một coin).
      eventKey: null,
      eventCoins: 1,
    });
    expect(s?.cycleAt.getTime()).toBe(T0);
    expect(s?.firstPublishedAt.getTime()).toBe(T0 - 2 * MIN);
    expect(s?.decidedAt.getTime()).toBe(T0);
    expect((s?.expiresAt.getTime() ?? 0) - (s?.decidedAt.getTime() ?? 0)).toBe(NEWS_SIGNAL_TTL_MS);
    expect(Number(s?.quoteBid)).toBe(99.99);
    expect(Number(s?.quoteAsk)).toBe(100.01);
    expect(Number(s?.quoteMid)).toBe(100);
    // Giờ giữ mặc định của hack_exploit (24 h) có biến động thường gặp từ 31 ngày nến.
    expect(Object.keys(s?.typicalByHoldHours ?? {})).toEqual(["24"]);
    expect(s?.typicalByHoldHours["24"]).not.toBeNull();
    expect(rung).toEqual([s?.id]);
    // Research versions vẫn chạy như cũ: Baseline mở lệnh giấy.
    expect(await paperTrades()).toHaveLength(1);
  });

  it("writes nothing when SIGNAL_NEWS_PUBLISH_ENABLED is off, and research results are the same", async () => {
    const rung: string[] = [];
    await setup({ publish: false, notify: (id) => rung.push(id) }).runCycle();
    expect(await signals()).toHaveLength(0);
    expect(rung).toEqual([]);
    expect(await paperTrades()).toHaveLength(1);
  });

  it("stores null quote fields (never 0) when SoDEX has no price", async () => {
    await setup({ publish: true, withBook: false }).runCycle();
    const [s] = await signals();
    expect(s).toMatchObject({ quoteBid: null, quoteAsk: null, quoteMid: null, quoteAt: null });
  });

  it("a failing NATS notify does not break the cycle", async () => {
    await setup({
      publish: true,
      notify: () => {
        throw new Error("nats down");
      },
    }).runCycle();
    expect(await signals()).toHaveLength(1);
    expect(await paperTrades()).toHaveLength(1);
  });

  it("adds the hold hours of live news_signal bots (config copied from a version)", async () => {
    const [u] = await db
      .insert(users)
      .values({ email: `${String(Math.random())}@x.test` })
      .returning();
    const [a] = await db
      .insert(sodexAccounts)
      .values({
        userId: u?.id ?? "",
        address: "0x4E1e4796c10C637EDAB56461450BD8D02EFb29Db",
        sodexAccountId: 77n,
        network: "mainnet",
        status: "connected",
      })
      .returning();
    const [b] = await db
      .insert(bots)
      .values({
        userId: u?.id ?? "",
        sodexAccountId: a?.id ?? "",
        strategy: "news_signal",
        market: "SOL-USD",
        engine: "perps",
        name: "News",
        state: "running",
      })
      .returning();
    const base = baselineVersionConfig();
    const config = {
      ...base,
      news: { ...base.news, hack_exploit: { enabled: true, maxHoldHours: 12 } },
      sizeUsdc: "100",
      leverage: 1,
    };
    const [bv] = await db
      .insert(botVersions)
      .values({ botId: b?.id ?? "", version: 1, config, paramSource: "manual", status: "active" })
      .returning();
    await db
      .update(bots)
      .set({ activeVersionId: bv?.id ?? null })
      .where(sql`id = ${b?.id ?? ""}`);
    try {
      await setup({ publish: true }).runCycle();
      const [s] = await signals();
      expect(Object.keys(s?.typicalByHoldHours ?? {})).toEqual(["12", "24"]);
    } finally {
      await db
        .update(bots)
        .set({ state: "archived" })
        .where(sql`id = ${b?.id ?? ""}`);
    }
  });
});

describe("publishNewsSignals", () => {
  const group: NewsSignalArticle[] = [
    {
      articleId: "x1",
      source: "Odaily",
      tier: "mid",
      publishedAt: T0 - 5 * MIN,
      collectedAt: T0 - 4 * MIN,
      candidate: { market: "SOL-USD", kind: "crypto" },
      catalyst: "listing",
    },
  ];
  const deps = (rung: string[]) => ({
    db,
    now: () => T0 + 1_500,
    quotes: { quotes: () => Promise.resolve(new Map()) },
    typical: () => Promise.resolve(null),
    notify: (id: string) => {
      rung.push(id);
    },
    log: quiet,
  });

  it("is idempotent for the same story and cycle (no second row, no second ring)", async () => {
    const rung: string[] = [];
    const groups = new Map([["SOL-USD|listing", group]]);
    expect(await publishNewsSignals(deps(rung), T0, groups)).toBe(1);
    expect(await publishNewsSignals(deps(rung), T0, groups)).toBe(0);
    const rows = await signals();
    expect(rows).toHaveLength(1);
    expect(rung).toEqual([rows[0]?.id]);
    // decided_at = đồng hồ lúc ghi (sau giờ bắt đầu chu kỳ), expires_at = + 120 s; thiếu nến → typical null.
    expect(rows[0]?.decidedAt.getTime()).toBe(T0 + 1_500);
    expect(rows[0]?.expiresAt.getTime()).toBe(T0 + 1_500 + NEWS_SIGNAL_TTL_MS);
    expect(rows[0]?.typicalByHoldHours).toEqual({ "24": null });
    // Chu kỳ khác của cùng câu chuyện là một tín hiệu mới.
    expect(await publishNewsSignals(deps(rung), T0 + 5 * MIN, groups)).toBe(1);
  });
});

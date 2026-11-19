import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  auditLog,
  candles1m,
  createDb,
  createSignalBotVersion,
  MIGRATIONS_FOLDER,
  runMigrations,
  runningSignalBotVersions,
  setSignalBotVersionStatus,
  signalBotVersions,
  signalClassifierVersions,
  signalEvents,
  signalPaperTrades,
  signalStories,
  versionSegmentStart,
  type Db,
} from "@drift/db";
import {
  AppError,
  baselineVersionConfig,
  NEWS_CLASSIFIER,
  NEWS_RULES,
  type BotVersionConfig,
} from "@drift/shared";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { and, eq, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
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

// News bot versions (#303, DEC-328) trên Postgres thật: classifier chạy một lần mỗi bài, Filter / Decide riêng từng version,
// giới hạn + shadow, tin ngược chiều, seed Baseline và migration lệnh cũ. SoSoValue / Claude là mock; không có SoDEX.

const MIN = 60_000;
const HOUR = 60 * MIN;
const T0 = Date.parse("2026-11-18T12:00:00Z");

let container: StartedPostgreSqlContainer;
let db: Db;
let pool: ReturnType<typeof createDb>["pool"];
let baselineId: string;

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
  const [b] = await db
    .select()
    .from(signalBotVersions)
    .where(eq(signalBotVersions.isBaseline, true));
  baselineId = b?.id ?? "";
});
afterAll(async () => {
  await pool.end();
  await container.stop();
});
beforeEach(async () => {
  await db.execute(
    sql`truncate signal_articles, signal_events, signal_stories, signal_paper_trades, signal_research_usage, signal_source_health`,
  );
  await db.delete(signalBotVersions).where(eq(signalBotVersions.isBaseline, false));
  await db
    .update(signalBotVersions)
    .set({ status: "running" })
    .where(eq(signalBotVersions.id, baselineId));
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

const fakeSoso = (items: SosoNewsItem[]): SosoClient => ({
  newsPage: (page: number) =>
    Promise.resolve({
      items: [...items]
        .sort((a, b) => b.release_time - a.release_time)
        .slice((page - 1) * 100, page * 100),
      invalid: 0,
    }),
});

const hack: Classification = {
  catalyst: "hack_exploit",
  market: "SOL-USD",
  relevance: "direct",
  promotional: false,
  eventDate: "2026-11-18",
};
const listing: Classification = { ...hack, catalyst: "listing" };

function fakeClaude(byTitle: Record<string, Classification>): NewsClassifier & { calls: number } {
  const c = {
    calls: 0,
    classify(input: Parameters<NewsClassifier["classify"]>[0]) {
      c.calls += 1;
      return Promise.resolve({
        ok: true as const,
        value: byTitle[input.title ?? ""] ?? { ...hack, catalyst: "none" as const },
        usage: { ...emptyUsage(), calls: 1, input: 1500, output: 40 },
      });
    },
  };
  return c;
}

const quiet: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => quiet,
};

function setup(items: SosoNewsItem[], claude: NewsClassifier, now: () => number) {
  const sr = createSignalResearch({
    db,
    redis: { mget: (...keys: string[]) => Promise.resolve(keys.map(() => null)) },
    log: quiet,
    env: signalResearchEnvSchema.parse({
      SIGNAL_RESEARCH_ENABLED: "true",
      SOSO_API_KEY: "k",
      DESK_AI_API_KEY: "c",
    }),
    perps: () => [
      { name: "SOL-USD", status: "TRADING", tickSize: "0.01", takerFee: "0.0004" },
      { name: "BTC-USD", status: "TRADING", tickSize: "0.1", takerFee: "0.0004" },
    ],
    now,
    soso: fakeSoso(items),
    classifier: claude,
  });
  const book = (market: string, b: string, a: string, at: number) => {
    sr.books.onMessage(
      `md.${market.toLowerCase()}.book`,
      JSON.stringify({ s: market, b, a, E: at, at }),
      at,
    );
  };
  return { sr, book };
}

const cfgWith = (over: Partial<BotVersionConfig>): BotVersionConfig => ({
  ...baselineVersionConfig(),
  ...over,
});

async function newVersion(name: string, over: Partial<BotVersionConfig>, start = true) {
  return createSignalBotVersion(db, {
    name,
    config: cfgWith(over),
    createdBy: null,
    savedFromVersionId: baselineId,
    start,
    now: new Date(T0 - HOUR),
  });
}

async function pauseBaseline() {
  await setSignalBotVersionStatus(db, { id: baselineId, status: "paused", userId: null });
}

/** Một lệnh paper đã có sẵn (đang mở hoặc đã đóng) của một version. */
async function insertTrade(over: Partial<typeof signalPaperTrades.$inferInsert>) {
  const [t] = await db
    .insert(signalPaperTrades)
    .values({
      lane: "news",
      label: "live",
      eventAt: new Date(T0 - 2 * HOUR),
      seenAt: new Date(T0 - 2 * HOUR),
      market: "BTC-USD",
      token: "BTC",
      catalyst: "listing",
      direction: "long",
      sizeUsdc: "500",
      qty: "0.01",
      entryPrice: "50000",
      entryMid: "50000",
      spreadAtEntryPct: "0.01",
      feePct: "0.05",
      entryFee: "0.25",
      typicalMovePct: "2",
      tpPct: "3",
      slPct: "1.5",
      tpPrice: "51500",
      slPrice: "49250",
      maxHoldUntil: new Date(T0 + 20 * HOUR),
      openedAt: new Date(T0 - 2 * HOUR),
      levelAtEntry: "low",
      sourcesAtEntry: [],
      outsideMarketHours: false,
      priceSource: "book",
      status: "open",
      ruleVersion: NEWS_RULES.version,
      ...over,
    })
    .returning();
  if (t === undefined) throw new Error("insert failed");
  return t;
}

const tradesOf = (versionId: string) =>
  db.select().from(signalPaperTrades).where(eq(signalPaperTrades.versionId, versionId));

const filterReasons = async (versionId: string) =>
  (
    await db
      .select({ reason: signalEvents.reason, outcome: signalEvents.outcome })
      .from(signalEvents)
      .where(and(eq(signalEvents.versionId, versionId), eq(signalEvents.stage, "filter")))
  ).map((e) => `${e.outcome}:${e.reason ?? ""}`);

describe("baseline version", () => {
  it("is seeded by the migration with the current NEWS_RULES decision parameters", async () => {
    const rows = await db.select().from(signalBotVersions);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      number: NEWS_RULES.versionNumber,
      name: "Baseline",
      status: "running",
      isBaseline: true,
      createdBy: null,
    });
    expect(rows[0]?.config).toEqual(baselineVersionConfig());
    const { versions, invalid } = await runningSignalBotVersions(db);
    expect(invalid).toEqual([]);
    expect(versions.map((v) => v.id)).toEqual([baselineId]);
  });
});

describe("version service", () => {
  it("allows at most 3 running versions (service and DB trigger), keeps config immutable, writes audit", async () => {
    const v2 = await newVersion("Two", { minLevel: "medium" });
    const v3 = await newVersion("Three", { minLevel: "high" });
    expect([v2.number, v3.number]).toEqual([
      NEWS_RULES.versionNumber + 1,
      NEWS_RULES.versionNumber + 2,
    ]);
    await expect(newVersion("Four", {})).rejects.toMatchObject({
      code: "STATE_CONFLICT",
      details: { reason: "MAX_RUNNING_VERSIONS" },
    });
    const paused = await newVersion("Four", {}, false);
    expect(paused.status).toBe("paused");
    await expect(
      setSignalBotVersionStatus(db, { id: paused.id, status: "running", userId: null }),
    ).rejects.toBeInstanceOf(AppError);
    // Trigger DB chặn cả khi đi vòng qua service.
    await expect(
      db
        .update(signalBotVersions)
        .set({ status: "running" })
        .where(eq(signalBotVersions.id, paused.id)),
    ).rejects.toThrow();
    await expect(
      db
        .update(signalBotVersions)
        .set({ config: cfgWith({ minLevel: "low" }) })
        .where(eq(signalBotVersions.id, v2.id)),
    ).rejects.toThrow();
    // Stop một version thì version khác chạy được; stopped không quay lại running.
    await setSignalBotVersionStatus(db, { id: v3.id, status: "stopped", userId: null });
    await setSignalBotVersionStatus(db, { id: paused.id, status: "running", userId: null });
    await expect(
      setSignalBotVersionStatus(db, { id: v3.id, status: "running", userId: null }),
    ).rejects.toMatchObject({ code: "STATE_CONFLICT" });
    const audits = await db.select({ action: auditLog.action }).from(auditLog);
    expect(audits.filter((a) => a.action === "signal_research.version_created")).toHaveLength(3);
    expect(audits.filter((a) => a.action === "signal_research.version_status")).toHaveLength(2);
    // Config sai bị từ chối trước khi lưu.
    await expect(
      createSignalBotVersion(db, {
        name: "Bad",
        config: { ...cfgWith({}), minTpCostMultiple: "0.5" },
        createdBy: null,
        savedFromVersionId: null,
        start: false,
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("segment start is the later of version save and classifier start", async () => {
    const at = new Date(T0);
    await db
      .insert(signalClassifierVersions)
      .values({ promptVersion: "test-prompt", model: "m", startedAt: at })
      .onConflictDoNothing();
    expect(
      await versionSegmentStart(db, {
        versionCreatedAt: new Date(T0 - HOUR),
        promptVersion: "test-prompt",
      }),
    ).toEqual(at);
    expect(
      await versionSegmentStart(db, {
        versionCreatedAt: new Date(T0 + HOUR),
        promptVersion: "test-prompt",
      }),
    ).toEqual(new Date(T0 + HOUR));
  });
});

describe("decide per running version", () => {
  it("one Claude read, then each version decides with its own config (minLevel low vs high)", async () => {
    const strict = await newVersion("High only", { minLevel: "high" });
    const claude = fakeClaude({ "Solana protocol drained in exploit": hack });
    const { sr, book } = setup(
      [item("a1", T0 - 2 * MIN, "Solana protocol drained in exploit")],
      claude,
      () => T0,
    );
    book("SOL-USD", "99.99", "100.01", T0);
    await sr.runCycle();
    expect(claude.calls).toBe(1);
    const base = await tradesOf(baselineId);
    expect(base).toHaveLength(1);
    expect(base[0]).toMatchObject({
      label: "live",
      direction: "short",
      classifierVersion: NEWS_CLASSIFIER.promptVersion,
      shadowReason: null,
    });
    expect(await tradesOf(strict.id)).toHaveLength(0);
    expect(await filterReasons(strict.id)).toEqual(["drop:LEVEL_TOO_LOW"]);
    // Mỗi version có story riêng.
    const stories = await db.select().from(signalStories);
    expect(stories.map((s) => s.versionId).sort()).toEqual([baselineId, strict.id].sort());
    const [cv] = await db
      .select()
      .from(signalClassifierVersions)
      .where(eq(signalClassifierVersions.promptVersion, NEWS_CLASSIFIER.promptVersion));
    expect(cv?.startedAt.getTime()).toBe(T0);
  });

  it("per-version size, TP and max hold come from the config", async () => {
    await pauseBaseline();
    const v = await newVersion("Wide", {
      sizeUsdc: "1000",
      tpMultiple: "2",
      news: { ...baselineVersionConfig().news, hack_exploit: { enabled: true, maxHoldHours: 12 } },
    });
    const { sr, book } = setup(
      [item("a1", T0 - 2 * MIN, "Solana protocol drained in exploit")],
      fakeClaude({ "Solana protocol drained in exploit": hack }),
      () => T0,
    );
    book("SOL-USD", "99.99", "100.01", T0);
    await sr.runCycle();
    const [t] = await tradesOf(v.id);
    expect(t?.sizeUsdc).toBe("1000.000000000000000000");
    expect(Number(t?.tpPct)).toBeCloseTo(Number(t?.typicalMovePct) * 2, 8);
    expect(t?.maxHoldUntil.getTime()).toBe(T0 + 12 * HOUR);
  });

  it("asset modes only / except / kind and a news type turned off drop with their own reason", async () => {
    await pauseBaseline();
    const only = await newVersion("Only BTC", {
      assets: { mode: "only", markets: ["BTC-USD"], crypto: true, stocks: true },
    });
    const except = await newVersion("Not SOL", {
      assets: { mode: "except", markets: ["SOL-USD"], crypto: true, stocks: true },
    });
    const off = await newVersion("No hacks", {
      news: { ...baselineVersionConfig().news, hack_exploit: { enabled: false, maxHoldHours: 24 } },
    });
    const { sr, book } = setup(
      [item("a1", T0 - 2 * MIN, "Solana protocol drained in exploit")],
      fakeClaude({ "Solana protocol drained in exploit": hack }),
      () => T0,
    );
    book("SOL-USD", "99.99", "100.01", T0);
    await sr.runCycle();
    expect(await db.select().from(signalPaperTrades)).toHaveLength(0);
    expect(await filterReasons(only.id)).toEqual(["drop:ASSET_NOT_IN_VERSION"]);
    expect(await filterReasons(except.id)).toEqual(["drop:ASSET_NOT_IN_VERSION"]);
    expect(await filterReasons(off.id)).toEqual(["drop:NEWS_TYPE_OFF"]);
    // Không tạo story khi version tự loại.
    expect(await db.select().from(signalStories)).toHaveLength(0);

    await setSignalBotVersionStatus(db, { id: only.id, status: "stopped", userId: null });
    const noCrypto = await newVersion("Stocks only", {
      assets: { mode: "all", markets: [], crypto: false, stocks: true },
    });
    const { sr: sr2, book: book2 } = setup(
      [item("a2", T0 + 3 * MIN, "Solana bridge hacked")],
      fakeClaude({ "Solana bridge hacked": hack }),
      () => T0 + 5 * MIN,
    );
    book2("SOL-USD", "99.99", "100.01", T0 + 5 * MIN);
    await sr2.runCycle();
    expect(await filterReasons(noCrypto.id)).toEqual(["drop:ASSET_NOT_IN_VERSION"]);
  });

  it("one open trade per (version, asset): an open trade blocks only its own version", async () => {
    await insertTrade({
      versionId: baselineId,
      market: "SOL-USD",
      token: "SOL",
      direction: "short",
      catalyst: "hack_exploit",
    });
    const other = await newVersion("Other", {});
    const { sr, book } = setup(
      [item("a1", T0 - 2 * MIN, "Solana protocol drained in exploit")],
      fakeClaude({ "Solana protocol drained in exploit": hack }),
      () => T0,
    );
    book("SOL-USD", "99.99", "100.01", T0);
    await sr.runCycle();
    expect(await filterReasons(baselineId)).toEqual(["drop:NEWS_TRADE_ALREADY_OPEN"]);
    expect(await tradesOf(other.id)).toHaveLength(1);
    // Chỉ mục DB: hai lệnh thật đang mở cùng version × token bị từ chối.
    await expect(
      insertTrade({ versionId: other.id, market: "SOL-USD", token: "SOL" }),
    ).rejects.toThrow();
  });
});

describe("limits and shadow trades", () => {
  const run = async (now = T0) => {
    const { sr, book } = setup(
      [item("a1", now - 2 * MIN, "Solana protocol drained in exploit")],
      fakeClaude({ "Solana protocol drained in exploit": hack }),
      () => now,
    );
    book("SOL-USD", "99.99", "100.01", now);
    await sr.runCycle();
    return { sr, book };
  };

  it("Max open trades: blocked signal becomes a shadow trade followed to TP by the watcher", async () => {
    await pauseBaseline();
    const v = await newVersion("One at a time", { maxOpenTrades: 1 });
    await insertTrade({ versionId: v.id });
    const { sr, book } = await run();
    const shadow = (await tradesOf(v.id)).find((t) => t.label === "shadow");
    expect(shadow).toMatchObject({ shadowReason: "LIMIT_OPEN", status: "open", market: "SOL-USD" });
    expect(await filterReasons(v.id)).toEqual(["drop:LIMIT_OPEN"]);
    const [story] = await db.select().from(signalStories).where(eq(signalStories.versionId, v.id));
    expect(story).toMatchObject({ outcome: "shadow", locked: true, tradeId: shadow?.id });
    // Watcher theo dõi lệnh shadow như lệnh thật.
    book("SOL-USD", "96.4", "96.5", T0);
    expect(await sr.watcher.tick()).toBeGreaterThanOrEqual(1);
    const [closed] = await db
      .select()
      .from(signalPaperTrades)
      .where(eq(signalPaperTrades.id, shadow?.id ?? ""));
    expect(closed).toMatchObject({ status: "closed", exitReason: "take_profit", label: "shadow" });
  });

  it("Max new trades per day (UTC): shadow with LIMIT_DAY", async () => {
    await pauseBaseline();
    const v = await newVersion("One a day", { maxNewTradesPerDay: 1 });
    await insertTrade({
      versionId: v.id,
      status: "closed",
      resultUsdc: "1",
      openedAt: new Date(T0 - 3 * HOUR),
    });
    // Lệnh của hôm qua (UTC) không tính.
    await insertTrade({
      versionId: v.id,
      market: "ETH-USD",
      token: "ETH",
      status: "closed",
      resultUsdc: "1",
      openedAt: new Date(T0 - 13 * HOUR),
    });
    await run();
    const shadow = (await tradesOf(v.id)).find((t) => t.label === "shadow");
    expect(shadow?.shadowReason).toBe("LIMIT_DAY");
  });

  it("not enough fake balance: shadow with NO_BALANCE (closed results and open size counted)", async () => {
    await pauseBaseline();
    const v = await newVersion("Big", { sizeUsdc: "5000", maxOpenTrades: 2 });
    await insertTrade({ versionId: v.id, sizeUsdc: "5000" });
    await insertTrade({
      versionId: v.id,
      market: "ETH-USD",
      token: "ETH",
      status: "closed",
      resultUsdc: "-1",
      openedAt: new Date(T0 - 30 * HOUR),
    });
    await run();
    const shadow = (await tradesOf(v.id)).find((t) => t.label === "shadow");
    expect(shadow?.shadowReason).toBe("NO_BALANCE");
  });

  it("shadow trades never count toward balance or the open-trades limit", async () => {
    await pauseBaseline();
    const v = await newVersion("Two max", { maxOpenTrades: 2 });
    await insertTrade({
      versionId: v.id,
      label: "shadow",
      shadowReason: "LIMIT_OPEN",
      sizeUsdc: "9999",
    });
    await insertTrade({
      versionId: v.id,
      label: "shadow",
      shadowReason: "LIMIT_OPEN",
      market: "ETH-USD",
      token: "ETH",
      sizeUsdc: "9999",
    });
    await run();
    const live = (await tradesOf(v.id)).filter((t) => t.label === "live");
    expect(live).toHaveLength(1);
  });
});

describe("opposite news on an open trade", () => {
  it("Keep leaves the trade open, Close closes at market; both record the would-have close result", async () => {
    await pauseBaseline();
    const keep = await newVersion("Keep", { onOppositeNews: "keep" });
    const close = await newVersion("Close", { onOppositeNews: "close" });
    const longOn = (versionId: string) =>
      insertTrade({
        versionId,
        market: "SOL-USD",
        token: "SOL",
        catalyst: "listing",
        direction: "long",
        qty: "5",
        entryPrice: "100",
        entryMid: "100",
        entryFee: "0.25",
        tpPrice: "103",
        slPrice: "98",
      });
    const kt = await longOn(keep.id);
    const ct = await longOn(close.id);
    const { sr, book } = setup(
      [item("a1", T0 - 2 * MIN, "Solana protocol drained in exploit")],
      fakeClaude({ "Solana protocol drained in exploit": hack }),
      () => T0,
    );
    book("SOL-USD", "99.5", "99.52", T0);
    await sr.runCycle();

    const [k] = await db.select().from(signalPaperTrades).where(eq(signalPaperTrades.id, kt.id));
    expect(k).toMatchObject({ status: "open" });
    // Long đóng theo bid 99.5: (99.5 − 100) × 5 − 0.25 − 99.5 × 5 × 0.05% = −2.99875.
    expect(k?.oppositeExitPrice).toBe("99.500000000000000000");
    expect(Number(k?.oppositeResultUsdc)).toBeCloseTo(-2.99875, 6);
    expect(k?.oppositeStoryId).not.toBeNull();
    expect(await filterReasons(keep.id)).toEqual(["drop:NEWS_TRADE_ALREADY_OPEN"]);

    const [c] = await db.select().from(signalPaperTrades).where(eq(signalPaperTrades.id, ct.id));
    expect(c).toMatchObject({ status: "closed", exitReason: "opposite_news" });
    expect(c?.exitPrice).toBe("99.500000000000000000");
    expect(Number(c?.resultUsdc)).toBeCloseTo(-2.99875, 6);
    expect(c?.oppositeResultUsdc).toBe(c?.resultUsdc);
    const closeEv = await db
      .select()
      .from(signalEvents)
      .where(and(eq(signalEvents.tradeId, ct.id), eq(signalEvents.stage, "watch")));
    expect(closeEv[0]).toMatchObject({ reason: "OPPOSITE_NEWS", versionId: close.id });
    // Sau khi đóng, tín hiệu mới (short) của version Close được xét tiếp và vào lệnh.
    const next = (await tradesOf(close.id)).filter((t) => t.status === "open");
    expect(next.map((t) => t.direction)).toEqual(["short"]);
  });

  it("news in the same direction is not opposite news", async () => {
    await pauseBaseline();
    const close = await newVersion("Close", { onOppositeNews: "close" });
    const t = await insertTrade({
      versionId: close.id,
      market: "SOL-USD",
      token: "SOL",
      direction: "long",
      catalyst: "favorable_ruling",
    });
    const { sr, book } = setup(
      [item("a1", T0 - 2 * MIN, "Solana listed on a major exchange")],
      fakeClaude({ "Solana listed on a major exchange": listing }),
      () => T0,
    );
    book("SOL-USD", "99.99", "100.01", T0);
    await sr.runCycle();
    const [row] = await db.select().from(signalPaperTrades).where(eq(signalPaperTrades.id, t.id));
    expect(row).toMatchObject({ status: "open", oppositeAt: null });
  });
});

describe("migration 0046 on existing data", () => {
  it("attaches open trades, stories and filter events from before the migration to the Baseline version", async () => {
    await db.execute(sql`create database premig`);
    const uri = container.getConnectionUri().replace(/\/[^/?]+(\?|$)/, "/premig$1");
    const dir = mkdtempSync(join(tmpdir(), "mig-"));
    try {
      cpSync(MIGRATIONS_FOLDER, dir, { recursive: true });
      const journalPath = join(dir, "meta", "_journal.json");
      const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
        entries: { tag: string }[];
      };
      journal.entries = journal.entries.filter((e) => !e.tag.startsWith("0046"));
      writeFileSync(journalPath, JSON.stringify(journal));
      rmSync(join(dir, "0046_sr_bot_versions.sql"));
      const p = createDb(uri);
      try {
        await migrate(p.db, { migrationsFolder: dir });
        await p.pool.query(`
          insert into signal_articles (id, source, published_at, collected_at, matched_currencies, candidates, content_hash, status, rule_version, claude_prompt_version, claude_model, classified_at)
          values ('old1', 'Odaily', now(), now(), '[]', '[]', 'h', 'classified', 'news-v3', 'news-classifier-v2', 'claude-haiku-4-5', now() - interval '1 hour');
          insert into signal_stories (id, story_key, market, catalyst, direction, first_article_id, first_seen_at, sources, level_at_entry, later_level, outcome, locked, rule_version)
          values ('00000000-0000-7000-8000-000000000001', 'SOL-USD|hack_exploit', 'SOL-USD', 'hack_exploit', 'short', 'old1', now(), '[]', 'low', 'low', 'entered', true, 'news-v3');
          insert into signal_events (id, article_id, stage, outcome, rule_version) values
            ('00000000-0000-7000-8000-000000000002', 'old1', 'understand', 'pass', 'news-v3'),
            ('00000000-0000-7000-8000-000000000003', 'old1', 'decide', 'open', 'news-v3');
          insert into signal_paper_trades (id, lane, label, article_id, event_at, seen_at, market, token, catalyst, direction, size_usdc, qty, entry_price, entry_mid, spread_at_entry_pct, fee_pct, entry_fee, typical_move_pct, tp_pct, sl_pct, tp_price, sl_price, max_hold_until, opened_at, level_at_entry, sources_at_entry, outside_market_hours, price_source, status, rule_version)
          values ('00000000-0000-7000-8000-000000000004', 'news', 'live', 'old1', now(), now(), 'SOL-USD', 'SOL', 'hack_exploit', 'short', 500, 5, 100, 100, 0.01, 0.05, 0.25, 2, 3, 1.5, 97, 101.5, now() + interval '1 day', now() - interval '2 hours', 'low', '[]', false, 'book', 'open', 'news-v3');
        `);
        await migrate(p.db, { migrationsFolder: MIGRATIONS_FOLDER });
        const base = await p.pool.query<{ id: string; created_at: Date }>(
          "select id, created_at from signal_bot_versions where is_baseline",
        );
        const bid = base.rows[0]?.id;
        expect(bid).toBeDefined();
        const trade = await p.pool.query<{ version_id: string; classifier_version: string }>(
          "select version_id, classifier_version from signal_paper_trades",
        );
        expect(trade.rows[0]).toEqual({
          version_id: bid,
          classifier_version: "news-classifier-v2",
        });
        // Mốc Baseline = lệnh cũ nhất, để lệnh cũ vẫn tính cho Baseline.
        const opened = await p.pool.query<{ opened_at: Date }>(
          "select opened_at from signal_paper_trades",
        );
        expect(base.rows[0]?.created_at.getTime()).toBe(opened.rows[0]?.opened_at.getTime());
        const story = await p.pool.query<{ version_id: string }>(
          "select version_id from signal_stories",
        );
        expect(story.rows[0]?.version_id).toBe(bid);
        const evs = await p.pool.query<{ stage: string; version_id: string | null }>(
          "select stage, version_id from signal_events order by stage",
        );
        expect(evs.rows).toEqual([
          { stage: "decide", version_id: bid },
          { stage: "understand", version_id: null },
        ]);
        const cv = await p.pool.query<{ prompt_version: string }>(
          "select prompt_version from signal_classifier_versions",
        );
        expect(cv.rows.map((r) => r.prompt_version)).toEqual(["news-classifier-v2"]);
      } finally {
        await p.pool.end();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

import {
  candles1m,
  createDb,
  fundingRates,
  runMigrations,
  signalArticles,
  signalContexts,
  signalEvents,
  signalStories,
  type Db,
} from "@drift/db";
import {
  dec,
  movedPct,
  NEWS_RULES,
  SIGNAL_CONTEXT_VERSION,
  TradeDirection,
  type Quote,
} from "@drift/shared";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { asc, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { captureSignalContext } from "../src/signal-research/context";
import {
  runContextBackfill,
  type BackfillOptions,
  type BackfillReport,
} from "../src/signal-research/context-backfill";

// Backfill ngữ cảnh cho tín hiệu cũ (#333) trên Postgres thật: chỉ dữ liệu có timestamp < thời điểm quyết định, nhãn
// `backfilled` tách khỏi `live` và không bao giờ ghi đè live, chạy lại idempotent, thiếu dữ liệu → `na`, H1 luôn `na`.

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
/** Thời điểm quyết định của tín hiệu cũ. */
const T0 = Date.parse("2026-11-18T12:00:00Z");
/** Lúc chạy backfill. */
const NOW = T0 + 2 * DAY;

let container: StartedPostgreSqlContainer;
let db: Db;
let pool: ReturnType<typeof createDb>["pool"];

const silent = { info: () => undefined, warn: () => undefined };
const fast: Partial<BackfillOptions> = { pauseMs: 0 };

const run = (options: Partial<BackfillOptions> = fast, now = NOW): Promise<BackfillReport> =>
  runContextBackfill({ db, log: silent, now: () => now, options });

const candle = (market: string, ts: number, close: string, volume = "1") => ({
  market,
  ts: new Date(ts),
  open: close,
  high: close,
  low: close,
  close,
  volume,
});

/**
 * BTC: nến giờ 31 ngày trước T0 xen kẽ 100 / 101 (biến động 1 giờ ≈ 1%); nến phút T0 − 30 … T0 − 2 giá 100, riêng
 * T0 − 25 … T0 − 21 giá 99; nến T0 − 1 phút (đóng đúng T0) giá 102 = giá lúc quyết định.
 */
async function seedCandles() {
  const rows: (typeof candles1m.$inferInsert)[] = [];
  for (let h = 31 * 24; h >= 1; h -= 1)
    rows.push(candle("BTC-USD", T0 - h * HOUR, h % 2 === 0 ? "100" : "101", "10"));
  for (let m = 30; m >= 2; m -= 1)
    rows.push(candle("BTC-USD", T0 - m * MIN, m >= 21 && m <= 25 ? "99" : "100"));
  rows.push(candle("BTC-USD", T0 - MIN, "102"));
  await db.insert(candles1m).values(rows);
}

/** 90 kỳ funding 8 giờ trước T0; kỳ cuối rất âm (percentile thấp → Long `yes`). */
async function seedFunding(market: string) {
  const rows: (typeof fundingRates.$inferInsert)[] = [];
  for (let i = 90; i >= 1; i -= 1)
    rows.push({
      market,
      fundingTime: new Date(T0 - i * 8 * HOUR + HOUR),
      rate: i === 1 ? "-0.001" : ((i % 10) * 0.00001).toFixed(6),
    });
  await db.insert(fundingRates).values(rows);
}

/** Bài + event Understand `pass` lúc `decidedAt` (như bước 3 của một chu kỳ). */
async function signal(
  id: string,
  opts: {
    market?: string;
    catalyst?: string;
    direction?: string;
    publishedAt?: number;
    decidedAt?: number;
    detail?: Record<string, unknown>;
  } = {},
) {
  const market = opts.market ?? "BTC-USD";
  const catalyst = opts.catalyst ?? "listing";
  const decidedAt = opts.decidedAt ?? T0;
  await db.insert(signalArticles).values({
    id,
    source: "Test",
    title: id,
    publishedAt: new Date(opts.publishedAt ?? T0 - 5 * MIN),
    collectedAt: new Date(decidedAt - MIN),
    matchedCurrencies: [],
    candidates: [],
    contentHash: id,
    status: "classified",
    ruleVersion: NEWS_RULES.version,
  });
  await db.insert(signalEvents).values({
    articleId: id,
    stage: "understand",
    outcome: "pass",
    detail: opts.detail ?? {
      market,
      catalyst,
      direction: opts.direction ?? TradeDirection.long,
    },
    ruleVersion: NEWS_RULES.version,
    at: new Date(decidedAt),
  });
}

const rows = () => db.select().from(signalContexts).orderBy(asc(signalContexts.articleId));
const snapshot = async (articleId: string) => {
  const [r] = await db.select().from(signalContexts).where(eq(signalContexts.articleId, articleId));
  if (r === undefined) throw new Error(`no snapshot for ${articleId}`);
  return r;
};
const omit = (o: object, keys: readonly string[]) =>
  Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k)));
const values = (r: typeof signalContexts.$inferSelect) => omit(r, ["id", "createdAt"]);

beforeAll(async () => {
  container = await new PostgreSqlContainer("timescale/timescaledb:2.16.1-pg16").start();
  await runMigrations(container.getConnectionUri());
  ({ db, pool } = createDb(container.getConnectionUri()));
});
afterAll(async () => {
  await pool.end();
  await container.stop();
});
beforeEach(async () => {
  await db.execute(
    sql`truncate candles_1m, funding_rates, signal_contexts, signal_articles, signal_events, signal_stories`,
  );
  await seedCandles();
  await seedFunding("BTC-USD");
});

describe("backfilled snapshot values", () => {
  it("records H2 / H3 from data before the decision, labelled backfilled, with H1 na and no H1 numbers", async () => {
    await signal("a1");
    const r = await run();
    expect(r).toMatchObject({
      scanned: 1,
      written: 1,
      kept: 0,
      invalid: 0,
      failed: 0,
      more: false,
    });
    const s = await snapshot("a1");
    expect(s.source).toBe("backfilled");
    expect(s.decidedAt.getTime()).toBe(T0);
    expect(s.contextVersion).toBe(SIGNAL_CONTEXT_VERSION);
    expect(s.ruleVersion).toBe(NEWS_RULES.version);
    expect(s.direction).toBe("long");
    // H1: không tái dựng được tập ví theo dõi / lần poll lúc đó → na, số null (không bao giờ 0).
    expect({
      s: s.h1Status,
      w: s.h1WalletsChecked,
      hl: s.h1AssetOnHyperliquid,
      a: s.h1AgreeingWallets,
      o: s.h1OpposingWallets,
      u: s.h1AgreeingUsdc,
      f: s.h1FirstAt,
      aa: s.h1AgreeingAddresses,
      oa: s.h1OpposingAddresses,
    }).toEqual({
      s: "na",
      w: null,
      hl: null,
      a: null,
      o: null,
      u: null,
      f: null,
      aa: null,
      oa: null,
    });
    // H2: 90 kỳ trong 30 ngày trước T0, kỳ cuối thấp nhất.
    expect(s.h2Status).toBe("yes");
    expect(s.h2Samples).toBe(90);
    expect(s.h2FundingTime?.getTime()).toBe(T0 - 7 * HOUR);
    expect(dec(s.h2FundingRate ?? "0").eq("-0.001")).toBe(true);
    // H3: giá trước bài đầu story (T0 − 5 phút) 100 → giá đóng nến cuối trước quyết định 102 = +2% ≥ biến động 1 giờ.
    expect(s.h3Status).toBe("yes");
    expect(dec(s.h3MovedPct ?? "0").eq(movedPct("100", "102") ?? "NaN")).toBe(true);
    expect(s.h3TypicalMovePct).not.toBeNull();
  });

  it("missing past data → na, never a guessed value", async () => {
    await signal("sol", { market: "SOL-USD" });
    await run();
    const s = await snapshot("sol");
    expect([s.h1Status, s.h2Status, s.h3Status]).toEqual(["na", "na", "na"]);
    expect(s.h2Samples).toBe(0);
    expect(s.h2FundingRate).toBeNull();
    expect(s.h3MovedPct).toBeNull();
    expect(s.h3TypicalMovePct).toBeNull();
    expect(s.volumeVs24h).toBeNull();
  });

  it("H2: fewer than 30 funding periods before the decision → na", async () => {
    await db.execute(sql`delete from funding_rates where funding_time < ${new Date(T0 - 8 * DAY)}`);
    await signal("a1");
    await run();
    const s = await snapshot("a1");
    expect(s.h2Status).toBe("na");
    expect(s.h2Samples).toBeLessThan(30);
  });

  it("H3: the story start is rebuilt only from earlier attempts and sources seen before the decision", async () => {
    // Lần thử trước (story chưa khoá) cùng key, bài đầu đăng T0 − 20 phút, qua Understand T0 − 18 phút.
    await signal("e1", { publishedAt: T0 - 20 * MIN, decidedAt: T0 - 18 * MIN });
    // Nguồn gộp vào story SAU quyết định (qua Understand T0 + 10 phút) dù giờ đăng sớm hơn: không tính.
    await signal("late", { publishedAt: T0 - 90 * MIN, decidedAt: T0 + 10 * MIN });
    await db.insert(signalStories).values({
      storyKey: "BTC-USD|listing",
      market: "BTC-USD",
      catalyst: "listing",
      direction: "long",
      firstArticleId: "e1",
      firstSeenAt: new Date(T0 - 18 * MIN),
      sources: [
        { name: "Test", tier: "mid", articleId: "e1", at: new Date(T0 - 20 * MIN).toISOString() },
        { name: "Test", tier: "mid", articleId: "late", at: new Date(T0 - 90 * MIN).toISOString() },
      ],
      levelAtEntry: "low",
      laterLevel: "low",
      outcome: "skipped",
      locked: false,
      ruleVersion: NEWS_RULES.version,
    });
    // Story tạo SAU quyết định: không tính.
    await db.insert(signalStories).values({
      storyKey: "BTC-USD|listing",
      market: "BTC-USD",
      catalyst: "listing",
      direction: "long",
      firstArticleId: "x",
      firstSeenAt: new Date(T0 + HOUR),
      sources: [
        { name: "Test", tier: "mid", articleId: "x", at: new Date(T0 - 4 * HOUR).toISOString() },
      ],
      levelAtEntry: "low",
      laterLevel: "low",
      outcome: "skipped",
      locked: false,
      ruleVersion: NEWS_RULES.version,
    });
    await signal("a1");
    await run();
    // Mốc = T0 − 20 phút → giá nến đóng trước đó (T0 − 21 phút) 99.
    const s = await snapshot("a1");
    expect(dec(s.h3MovedPct ?? "0").toFixed(10)).toBe(movedPct("99", "102")?.toFixed(10));
  });

  it("skips understand events it cannot read, without guessing", async () => {
    await signal("bad", { detail: { market: "BTC-USD" } });
    const r = await run();
    expect(r).toMatchObject({ scanned: 1, written: 0, invalid: 1 });
    expect(await rows()).toHaveLength(0);
  });
});

describe("no lookahead", () => {
  it("funding, candles and stories stamped at or after the decision never change the snapshot", async () => {
    await signal("a1");
    await run();
    const clean = values(await snapshot("a1"));
    await db.execute(sql`truncate signal_contexts`);

    // Dữ liệu sau quyết định, cực trị: funding rất dương, nến giá 500, story mở sau đó.
    await db.insert(fundingRates).values([
      { market: "BTC-USD", fundingTime: new Date(T0), rate: "0.05" },
      { market: "BTC-USD", fundingTime: new Date(T0 + HOUR), rate: "0.05" },
    ]);
    await db
      .insert(candles1m)
      .values([candle("BTC-USD", T0, "500", "999"), candle("BTC-USD", T0 + MIN, "500", "999")]);
    await run();
    expect(values(await snapshot("a1"))).toEqual(clean);
  });
});

describe("backfilled never overwrites live", () => {
  it("an article with a live snapshot is left untouched", async () => {
    await signal("a1");
    const q: Quote = { bid: dec("101.95"), ask: dec("102.05"), source: "book" };
    await captureSignalContext(
      db,
      {
        articleId: "a1",
        market: "BTC-USD",
        direction: TradeDirection.long,
        storyStartAt: T0 - 5 * MIN,
      },
      T0,
      q,
    );
    const live = await snapshot("a1");
    expect(live.source).toBe("live");
    const r = await run();
    expect(r).toMatchObject({ scanned: 0, written: 0 });
    expect(await snapshot("a1")).toEqual(live);
  });

  it("decisions younger than the safety margin are left for the live capture", async () => {
    await signal("recent", { decidedAt: NOW - 10 * MIN, publishedAt: NOW - 12 * MIN });
    const r = await run();
    expect(r.scanned).toBe(0);
    expect(await rows()).toHaveLength(0);
  });
});

describe("re-runs", () => {
  it("is idempotent: a second run writes nothing and keeps the first rows", async () => {
    await signal("a1");
    await signal("a2", { market: "SOL-USD" });
    await run();
    const first = await rows();
    expect(first).toHaveLength(2);
    const r = await run();
    expect(r).toMatchObject({ scanned: 0, written: 0 });
    expect(await rows()).toEqual(first);
  });

  it("stops at maxPerRun, pauses between articles, and the next run continues", async () => {
    for (const id of ["a1", "a2", "a3"]) await signal(id);
    const pauses: number[] = [];
    const r = await runContextBackfill({
      db,
      log: silent,
      now: () => NOW,
      options: { maxPerRun: 2, batchSize: 1, pauseMs: 7 },
      sleep: (ms) => {
        pauses.push(ms);
        return Promise.resolve();
      },
    });
    expect(r).toMatchObject({ scanned: 2, written: 2, more: true });
    expect(pauses).toEqual([7, 7]);
    const next = await run();
    expect(next).toMatchObject({ scanned: 1, written: 1, more: false });
    expect((await rows()).map((x) => x.source)).toEqual(["backfilled", "backfilled", "backfilled"]);
  });
});

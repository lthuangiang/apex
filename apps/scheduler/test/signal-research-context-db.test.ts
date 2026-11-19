import {
  candles1m,
  createDb,
  fundingRates,
  leaderboardRuns,
  leaderEvents,
  leaderStatsDaily,
  runMigrations,
  signalBotVersions,
  signalContexts,
  signalEvents,
  signalPaperTrades,
  signalStories,
  type Db,
} from "@drift/db";
import { dec, SIGNAL_CONTEXT_VERSION, TradeDirection, type Quote } from "@drift/shared";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { asc, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  emptyUsage,
  type Classification,
  type NewsClassifier,
} from "../src/signal-research/classifier";
import { captureSignalContext } from "../src/signal-research/context";
import { runNewsCycle, type PipelineDeps } from "../src/signal-research/pipeline";
import type { SosoClient, SosoNewsItem } from "../src/signal-research/soso";

// Bước 4 · Context (#329; #330 snapshot + H3, #331 H1, #332 H2) trên Postgres thật: giá trị chụp đúng lúc quyết định, không
// nhìn trước (dữ liệu có timestamp ≥ lúc quyết định không đổi snapshot), không bao giờ tính lại, và không đổi quyết định nào
// của Filter / Decide. SoSoValue / Claude / báo giá là mock; không có SoDEX hay Hyperliquid.

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const T0 = Date.parse("2026-11-18T12:00:00Z");

let container: StartedPostgreSqlContainer;
let db: Db;
let pool: ReturnType<typeof createDb>["pool"];

const quote = (mid: string): Quote => ({
  bid: dec(mid).sub("0.05"),
  ask: dec(mid).add("0.05"),
  source: "book",
});

/** Nến giờ 31 ngày trước T0: BTC xen kẽ 100 / 101 mỗi giờ (biến động 1 giờ ≈ 1%), SOL xen kẽ 100 / 102 mỗi ngày. */
async function seedCandles() {
  const rows: (typeof candles1m.$inferInsert)[] = [];
  for (let h = 31 * 24; h >= 1; h -= 1) {
    const ts = T0 - h * HOUR;
    const btc = h % 2 === 0 ? "100" : "101";
    rows.push({
      market: "BTC-USD",
      ts: new Date(ts),
      open: btc,
      high: btc,
      low: btc,
      close: btc,
      volume: "10",
    });
    const sol = Math.floor(ts / DAY) % 2 === 0 ? "100" : "102";
    rows.push({
      market: "SOL-USD",
      ts: new Date(ts),
      open: sol,
      high: sol,
      low: sol,
      close: sol,
      volume: "1",
    });
  }
  // Nến phút quanh giờ đăng bài BTC (T0 − 5 phút): giá trước đăng 100; giờ cuối khối lượng cao hơn.
  for (let m = 30; m >= 2; m -= 1) {
    const ts = T0 - m * MIN;
    if (ts % HOUR === 0) continue;
    rows.push({
      market: "BTC-USD",
      ts: new Date(ts),
      open: "100",
      high: "100.2",
      low: "99.9",
      close: "100",
      volume: "1",
    });
  }
  await db.insert(candles1m).values(rows);
}

const stats = { winRate: "0.6", medianEntryNotional: "1000" };

/** Một lần xếp hạng `ok` xong lúc `finishedAt` với các ví. */
async function leaderboardRun(date: string, finishedAt: number, wallets: string[]) {
  await db.insert(leaderboardRuns).values({
    date,
    status: "ok",
    candidates: wallets.length,
    computed: wallets.length,
    finishedAt: new Date(finishedAt),
  });
  if (wallets.length > 0)
    await db.insert(leaderStatsDaily).values(
      wallets.map((address) => ({
        source: "hyperliquid" as const,
        address,
        date,
        stats,
        hidden: [],
        tabs: ["all"],
        steadyScore: 1,
        profit: "1000",
        typicalHoldMs: HOUR,
        computedAt: new Date(finishedAt),
      })),
    );
}

let tid = 0;
async function whale(
  address: string,
  market: string | null,
  after: string,
  at: number,
  seenAt: number,
  kind: "open" | "add" | "reduce" | "flip" = "open",
  notional = "1000",
) {
  tid += 1;
  await db.insert(leaderEvents).values({
    source: "hyperliquid",
    address,
    coin: market?.split("-")[0] ?? "XYZ",
    market,
    kind,
    positionBefore: "0",
    positionAfter: after,
    notional,
    price: "100",
    at: new Date(at),
    seenAt: new Date(seenAt),
    lastTid: String(tid),
  });
}

/** 90 kỳ funding 8 giờ trước T0; kỳ cuối có `last`. */
async function seedFunding(market: string, last: string) {
  const rows: (typeof fundingRates.$inferInsert)[] = [];
  for (let i = 90; i >= 1; i -= 1)
    rows.push({
      market,
      fundingTime: new Date(T0 - i * 8 * HOUR + HOUR),
      rate: i === 1 ? last : ((i % 10) * 0.00001).toFixed(6),
    });
  await db.insert(fundingRates).values(rows);
}

/** Thị trường BTC chuẩn: 2 ví trong leaderboard trước T0 (A, B), ví C chỉ vào leaderboard SAU T0. */
async function seedWhales() {
  await leaderboardRun("2026-11-16", T0 - 2 * DAY, ["0xaaa", "0xbbb"]);
  await leaderboardRun("2026-11-18", T0 + HOUR, ["0xaaa", "0xbbb", "0xccc"]);
  await whale("0xAAA", "BTC-USD", "2", T0 - 30 * MIN, T0 - 29 * MIN, "open", "900000");
  await whale("0xaaa", "BTC-USD", "3", T0 - 20 * MIN, T0 - 19 * MIN, "add", "500000");
  await whale("0xbbb", "BTC-USD", "-1", T0 - 10 * MIN, T0 - 9 * MIN);
  // Ví C cùng chiều, thấy trước T0, nhưng chỉ vào leaderboard sau T0: không tính (chống survivorship #263).
  await whale("0xccc", "BTC-USD", "5", T0 - 15 * MIN, T0 - 14 * MIN);
  // Ngoài cửa sổ 60 phút, và giảm vị thế: không tính.
  await whale("0xbbb", "BTC-USD", "4", T0 - 61 * MIN, T0 - 60 * MIN);
  await whale("0xbbb", "BTC-USD", "1", T0 - 5 * MIN, T0 - 4 * MIN, "reduce");
}

const snapshot = async (articleId: string) => {
  const [r] = await db.select().from(signalContexts).where(eq(signalContexts.articleId, articleId));
  if (r === undefined) throw new Error(`no snapshot for ${articleId}`);
  return r;
};
const omit = (o: object, keys: readonly string[]) =>
  Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k)));
/** Giá trị của snapshot, bỏ id / bài / giờ ghi. */
const values = (r: typeof signalContexts.$inferSelect) => omit(r, ["id", "articleId", "createdAt"]);
const h1 = (r: typeof signalContexts.$inferSelect) => ({
  s: r.h1Status,
  w: r.h1WalletsChecked,
  a: r.h1AgreeingWallets,
  o: r.h1OpposingWallets,
  u: r.h1AgreeingUsdc,
  f: r.h1FirstAt,
});
const h2 = (r: typeof signalContexts.$inferSelect) => ({
  s: r.h2Status,
  r: r.h2FundingRate,
  t: r.h2FundingTime,
  p: r.h2Percentile,
  n: r.h2Samples,
  i: r.h2IntervalHours,
});
const h3 = (r: typeof signalContexts.$inferSelect) => ({
  s: r.h3Status,
  m: r.h3MovedPct,
  t: r.h3TypicalMovePct,
  v: r.volumeVs24h,
  b: r.rangeBreakout,
});

const btcLong = (articleId: string) => ({
  articleId,
  market: "BTC-USD",
  direction: TradeDirection.long,
  publishedAt: T0 - 5 * MIN,
});

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
    sql`truncate candles_1m, funding_rates, leader_events, leader_stats_daily, leaderboard_runs, signal_contexts,
        signal_articles, signal_events, signal_stories, signal_paper_trades, signal_research_usage, signal_source_health`,
  );
  await seedCandles();
});

describe("context capture values", () => {
  it("records H1 / H2 / H3 and the exploratory values at the decision time", async () => {
    await seedWhales();
    await seedFunding("BTC-USD", "-0.0001");
    await captureSignalContext(db, btcLong("a1"), T0, quote("102"));
    const r = await snapshot("a1");
    expect(r).toMatchObject({
      market: "BTC-USD",
      direction: "long",
      source: "live",
      contextVersion: SIGNAL_CONTEXT_VERSION,
      h1Status: "yes",
      h1WalletsChecked: 2,
      h1AgreeingWallets: 1,
      h1OpposingWallets: 1,
      h2Status: "yes",
      h2Samples: 90,
      h2Payer: "short",
      h3Status: "yes",
      rangeBreakout: "none",
    });
    expect(r.decidedAt.getTime()).toBe(T0);
    expect(dec(r.h1AgreeingUsdc ?? "0").toFixed()).toBe("1400000");
    expect(r.h1FirstAt?.getTime()).toBe(T0 - 30 * MIN);
    expect(Number(r.h2Percentile)).toBeLessThanOrEqual(20);
    expect(dec(r.h2FundingRate ?? "0").toFixed()).toBe("-0.0001");
    expect(Number(r.h2IntervalHours)).toBe(8);
    // Giá trước giờ đăng 100 → giá giữa lúc quyết định 102: +2% ≥ biến động 1 giờ ≈ 1%.
    expect(dec(r.h3MovedPct ?? "0").toFixed()).toBe("2");
    const typical = dec(r.h3TypicalMovePct ?? "0").toNumber();
    expect(typical).toBeGreaterThan(0.98);
    expect(typical).toBeLessThanOrEqual(1);
    expect(r.volumeVs24h).not.toBeNull();
  });

  it("H1: against with only opposite wallets, no with quiet wallets, na without whale data for the asset", async () => {
    await leaderboardRun("2026-11-16", T0 - 2 * DAY, ["0xaaa", "0xbbb"]);
    await whale("0xbbb", "BTC-USD", "-1", T0 - 10 * MIN, T0 - 9 * MIN);
    await whale("0xaaa", "SOL-USD", "1", T0 - 3 * DAY, T0 - 3 * DAY);
    await captureSignalContext(db, btcLong("against"), T0, quote("100"));
    await captureSignalContext(db, { ...btcLong("quiet"), market: "SOL-USD" }, T0, quote("100"));
    await captureSignalContext(db, { ...btcLong("meta"), market: "META-USD" }, T0, null);
    expect(h1(await snapshot("against"))).toMatchObject({ s: "against", a: 0, o: 1 });
    expect(h1(await snapshot("quiet"))).toMatchObject({ s: "no", w: 2, a: 0, o: 0 });
    expect(await snapshot("meta")).toMatchObject({
      h1Status: "na",
      h2Status: "na",
      h3Status: "na",
      h3MovedPct: null,
      volumeVs24h: null,
      rangeBreakout: null,
    });
  });
});

describe("no lookahead: data stamped at or after the decision never changes the snapshot", () => {
  beforeEach(async () => {
    await seedWhales();
    await seedFunding("BTC-USD", "-0.0001");
  });

  it("H1: events seen after the decision and wallets that joined the leaderboard later are ignored", async () => {
    await captureSignalContext(db, btcLong("before"), T0, quote("102"));
    // Ví B (trong leaderboard) quay sang cùng chiều nhưng DeskLabs thấy sau quyết định; ví D thấy trước nhưng chỉ có trong
    // lần xếp hạng xong sau; một lần xếp hạng xong đúng lúc quyết định (không tính, phải < quyết định).
    await whale("0xbbb", "BTC-USD", "7", T0 - 2 * MIN, T0 + 30_000, "flip");
    await leaderboardRun("2026-11-17", T0, ["0xddd"]);
    await whale("0xddd", "BTC-USD", "9", T0 - 8 * MIN, T0 - 7 * MIN);
    await whale("0xaaa", "BTC-USD", "9", T0 + MIN, T0 + 2 * MIN, "add");
    await captureSignalContext(db, btcLong("after"), T0, quote("102"));
    expect(h1(await snapshot("after"))).toEqual(h1(await snapshot("before")));
    expect(values(await snapshot("after"))).toEqual(values(await snapshot("before")));
  });

  it("H2: funding at or after the decision time is ignored", async () => {
    await captureSignalContext(db, btcLong("before"), T0, quote("102"));
    await db.insert(fundingRates).values([
      { market: "BTC-USD", fundingTime: new Date(T0), rate: "0.05" },
      { market: "BTC-USD", fundingTime: new Date(T0 + 8 * HOUR), rate: "0.05" },
    ]);
    await captureSignalContext(db, btcLong("after"), T0, quote("102"));
    expect(h2(await snapshot("after"))).toEqual(h2(await snapshot("before")));
    expect(values(await snapshot("after"))).toEqual(values(await snapshot("before")));
  });

  it("H3: candles that are not closed before the decision are ignored", async () => {
    await captureSignalContext(db, btcLong("before"), T0, quote("102"));
    const rows = [];
    for (let m = -1; m <= 120; m += 1) {
      const ts = T0 + m * MIN;
      rows.push({
        market: "BTC-USD",
        ts: new Date(ts),
        open: "150",
        high: "200",
        low: "50",
        close: m % 2 === 0 ? "150" : "60",
        volume: "100000",
      });
    }
    // Nến bắt đầu lúc T0 − 1 phút đóng đúng lúc quyết định (không phải TRƯỚC): không được dùng.
    await db.insert(candles1m).values(rows).onConflictDoNothing();
    await captureSignalContext(db, btcLong("after"), T0, quote("102"));
    expect(h3(await snapshot("after"))).toEqual(h3(await snapshot("before")));
    expect(values(await snapshot("after"))).toEqual(values(await snapshot("before")));
  });
});

describe("snapshot is never recomputed", () => {
  it("keeps the first capture and the DB rejects updates", async () => {
    await seedWhales();
    await captureSignalContext(db, btcLong("a1"), T0, quote("102"));
    const first = await snapshot("a1");
    await seedFunding("BTC-USD", "0.01");
    await captureSignalContext(db, btcLong("a1"), T0 + HOUR, quote("90"));
    expect(await snapshot("a1")).toEqual(first);
    await expect(
      db.update(signalContexts).set({ h1Status: "no" }).where(eq(signalContexts.articleId, "a1")),
    ).rejects.toThrow();
    expect((await snapshot("a1")).h1Status).toBe("yes");
  });
});

// ── Pipeline: bước 4 chạy lúc quyết định và không đổi quyết định nào ────────────────────────────────────────────────

const hack: Classification = {
  catalyst: "hack_exploit",
  market: "SOL-USD",
  relevance: "direct",
  promotional: false,
  eventDate: "2026-11-18",
};

function item(
  id: string,
  at: number,
  title: string,
  symbol = "SOL",
  name = "Solana",
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
    matched_currencies: [{ symbol, name }],
  };
}

const ITEMS: SosoNewsItem[] = [
  item("n1", T0 - 2 * MIN, "Solana DeFi protocol exploited, Solana drained"),
  item("n2", T0 - 3 * MIN, "Bitcoin listing on a new venue", "BTC", "Bitcoin"),
  item("n3", T0 - 4 * MIN, "Solana unrelated promo"),
];
const BY_TITLE: Record<string, Classification> = {
  "Solana DeFi protocol exploited, Solana drained": hack,
  "Bitcoin listing on a new venue": { ...hack, catalyst: "listing", market: "BTC-USD" },
};

function deps(capture: PipelineDeps["captureContext"]): PipelineDeps {
  const soso: SosoClient = {
    newsPage: (page) =>
      Promise.resolve({
        items: page === 1 ? [...ITEMS].sort((a, b) => b.release_time - a.release_time) : [],
        invalid: 0,
      }),
  };
  const classifier: NewsClassifier = {
    classify: (input) =>
      Promise.resolve({
        ok: true as const,
        value: BY_TITLE[input.title ?? ""] ?? { ...hack, catalyst: "none" as const },
        usage: { ...emptyUsage(), calls: 1, input: 1500, output: 40 },
      }),
  };
  return {
    db,
    soso,
    classifier,
    quotes: {
      quotes: (ms) =>
        Promise.resolve(
          new Map(ms.map((m) => [m, quote(m === "SOL-USD" ? "101" : "102")] as const)),
        ),
    },
    markets: () => [
      { name: "SOL-USD", tickSize: "0.01", takerFee: "0.0004" },
      { name: "BTC-USD", tickSize: "0.1", takerFee: "0.0004" },
    ],
    now: () => T0,
    log: { info: () => undefined, warn: () => undefined },
    config: {
      claudeDailyInputBudget: 2_000_000,
      claudeMaxCallsPerCycle: 50,
      sosoMaxPages: 2,
      sosoMonthlyLimit: 9500,
      startLookbackMinutes: 15,
      maxCatchUpMinutes: 30,
    },
    ...(capture === undefined ? {} : { captureContext: capture }),
  };
}

/** Quyết định của chu kỳ, bỏ id / giờ ghi (khác nhau giữa hai lần chạy). */
async function decisions() {
  const dropIds = (d: unknown) =>
    d === null || typeof d !== "object"
      ? d
      : Object.fromEntries(Object.entries(d).filter(([k]) => !/Ids?$/.test(k)));
  const trades = (
    await db.select().from(signalPaperTrades).orderBy(asc(signalPaperTrades.market))
  ).map((t) => omit(t, ["id", "storyId", "createdAt", "updatedAt"]));
  const stories = (await db.select().from(signalStories).orderBy(asc(signalStories.storyKey))).map(
    (s) => omit(s, ["id", "tradeId", "createdAt", "updatedAt"]),
  );
  const events = (
    await db
      .select()
      .from(signalEvents)
      .orderBy(asc(signalEvents.articleId), asc(signalEvents.stage), asc(signalEvents.outcome))
  ).map((e) => ({ ...omit(e, ["id", "storyId", "tradeId", "detail"]), detail: dropIds(e.detail) }));
  return { trades, stories, events };
}

describe("pipeline step 4", () => {
  it("captures one snapshot per signal at the decision time, before Filter, without changing any decision", async () => {
    await seedWhales();
    await seedFunding("SOL-USD", "0.002");
    await db
      .update(signalBotVersions)
      .set({ status: "running" })
      .where(eq(signalBotVersions.isBaseline, true));

    const without = await runNewsCycle(deps(null));
    expect(without.contexts).toBe(0);
    expect(await db.select().from(signalContexts)).toHaveLength(0);
    const a = await decisions();
    expect(a.trades.length).toBeGreaterThan(0);

    await db.execute(
      sql`truncate signal_articles, signal_events, signal_stories, signal_paper_trades, signal_research_usage, signal_source_health`,
    );
    const withCtx = await runNewsCycle(deps(undefined));
    expect(withCtx.contexts).toBe(2);
    const b = await decisions();
    expect(b).toEqual(a);
    expect({ ...withCtx, contexts: 0 }).toEqual(without);

    const rows = await db.select().from(signalContexts).orderBy(asc(signalContexts.articleId));
    // Chỉ tín hiệu qua Score (n1 hack SOL short, n2 listing BTC long); n3 bị loại ở Score nên không tới bước 4.
    expect(rows.map((r) => [r.articleId, r.market, r.direction, r.decidedAt.getTime()])).toEqual([
      ["n1", "SOL-USD", "short", T0],
      ["n2", "BTC-USD", "long", T0],
    ]);
    // SOL: funding cao nhất 30 ngày → Short ngược đám đông.
    expect(rows[0]?.h2Status).toBe("yes");
    expect(rows[1]?.h1Status).toBe("yes");
  });

  it("a failing capture is only logged and the cycle still decides", async () => {
    const warns: string[] = [];
    const d = deps(() => Promise.reject(new Error("boom")));
    const out = await runNewsCycle({
      ...d,
      log: { info: () => undefined, warn: (_o, m) => warns.push(m) },
    });
    expect(out.contexts).toBe(0);
    expect(warns).toContain("signal research: context capture failed");
    expect((await db.select().from(signalPaperTrades)).length).toBeGreaterThan(0);
  });
});

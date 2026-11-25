import {
  candles1m,
  createDb,
  createSignalBotVersion,
  loadSignalResearchArticles,
  newsSignals,
  runMigrations,
  setSignalBotVersionStatus,
  signalArticles,
  signalBotVersions,
  signalContexts,
  signalEvents,
  signalPaperTrades,
  signalStories,
  type Db,
} from "@drift/db";
import {
  baselineVersionConfig,
  researchArticlesQuerySchema,
  type BotVersionConfig,
} from "@drift/shared";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { and, asc, eq, sql } from "drizzle-orm";
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

// #530 PR2 (news-v6, DEC-393) trên Postgres thật: một bài nêu nhiều coin của MỘT sự kiện ra một tín hiệu
// mỗi coin (cùng event key, k = số coin qua Understand), cỡ lệnh giấy chia k, bài đăng lại trong 24 giờ có coin trùng là
// SAME_EVENT (trừ lần thử lại của câu chuyện đã có), tín hiệu mainnet mang event_key / event_coins. SoSoValue / Claude là
// mock; không có SoDEX.

const MIN = 60_000;
const HOUR = 60 * MIN;
/** Bài gốc của #530: 24/11 15:35 UTC, ChainCatcher, AAVE / LINK / UNI. */
const T = Date.parse("2026-11-24T15:35:00Z");
const COINS = ["AAVE", "LINK", "UNI", "COMP", "SOL"] as const;
const NAMES: Record<string, string> = {
  AAVE: "Aave",
  LINK: "Chainlink",
  UNI: "Uniswap",
  COMP: "Compound",
  SOL: "Solana",
  BTC: "Bitcoin",
  ETH: "Ethereum",
  CRV: "Curve",
  SNX: "Synthetix",
  MKR: "Maker",
};

let container: StartedPostgreSqlContainer;
let db: Db;
let pool: ReturnType<typeof createDb>["pool"];
let baselineId: string;

beforeAll(async () => {
  container = await new PostgreSqlContainer("timescale/timescaledb:2.16.1-pg16").start();
  await runMigrations(container.getConnectionUri());
  ({ db, pool } = createDb(container.getConnectionUri()));
  // 31 ngày nến theo giờ (tới sau chu kỳ cuối của bài test) cho mọi coin: ngày chẵn 100, ngày lẻ 102 → biến động ≈ 2 %.
  const rows = [];
  for (const coin of COINS)
    for (let h = 31 * 24; h >= -12; h -= 1) {
      const ts = T - h * HOUR;
      const close = Math.floor(ts / (24 * HOUR)) % 2 === 0 ? "100" : "102";
      rows.push({
        market: `${coin}-USD`,
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
  // `news_signals` bất biến (trigger chặn DELETE); TRUNCATE không qua trigger dòng.
  await db.execute(
    sql`truncate news_signals cascade; truncate signal_articles, signal_events, signal_stories, signal_paper_trades, signal_research_usage, signal_source_health, signal_contexts`,
  );
  await db.delete(signalBotVersions).where(eq(signalBotVersions.isBaseline, false));
  await db
    .update(signalBotVersions)
    .set({ status: "running" })
    .where(eq(signalBotVersions.id, baselineId));
});

function item(id: string, at: number, title: string, coins: readonly string[]): SosoNewsItem {
  return {
    id,
    release_time: at,
    title,
    content: `<p>${title}</p>`,
    author: "Odaily",
    category: 1,
    source_link: `https://sosovalue.com/${id}`,
    original_link: null,
    matched_currencies: coins.map((symbol) => ({ symbol, name: NAMES[symbol] ?? symbol })),
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

/** Câu trả lời reader v7: market đầu bài nêu + `markets` (market rồi other_markets). */
const listingOf = (coins: readonly string[]): Classification => ({
  catalyst: "listing",
  market: `${coins[0] ?? ""}-USD`,
  markets: coins.map((c) => `${c}-USD`),
  relevance: "direct",
  promotional: false,
  eventDate: "2026-11-24",
});

function fakeClaude(byTitle: Record<string, Classification>): NewsClassifier {
  return {
    classify: (input) =>
      Promise.resolve({
        ok: true as const,
        value: byTitle[input.title ?? ""] ?? {
          catalyst: "none" as const,
          market: null,
          relevance: "passing_mention" as const,
          promotional: false,
          eventDate: null,
        },
        usage: { ...emptyUsage(), calls: 1, input: 1500, output: 40 },
      }),
  };
}

const quiet: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => quiet,
};

const ALL = ["AAVE", "LINK", "UNI", "COMP", "SOL", "BTC", "ETH", "CRV", "SNX", "MKR"];
/** Perps SoDEX giả: lot 0.01, min 0.01, min notional 10 USDC. */
const PERPS = ALL.map((c) => ({
  name: `${c}-USD`,
  status: "TRADING",
  tickSize: "0.01",
  takerFee: "0.0004",
  stepSize: "0.01",
  minQuantity: "0.01",
  minNotional: "10",
}));

/**
 * Một chu kỳ tin ở `now` với các bài `items` (cùng câu trả lời của reader); `books` = market có sổ lệnh live ở `now`
 * (market không có trong danh sách: không có giá → bỏ ở Filter, câu chuyện đã tạo).
 */
async function cycle(input: {
  now: number;
  items: SosoNewsItem[];
  claude: Record<string, Classification>;
  books: readonly string[];
  /** `SIGNAL_NEWS_EVENT_SPLIT_ENABLED`: mặc định bật trong file này (đường mainnet mới); tắt ở các test "flag off". */
  split?: boolean;
}) {
  const sr = createSignalResearch({
    db,
    redis: { mget: (...keys: string[]) => Promise.resolve(keys.map(() => null)) },
    log: quiet,
    env: signalResearchEnvSchema.parse({
      SIGNAL_RESEARCH_ENABLED: "true",
      SOSO_API_KEY: "k",
      DESK_AI_API_KEY: "c",
      SIGNAL_NEWS_PUBLISH_ENABLED: "true",
      SIGNAL_NEWS_EVENT_SPLIT_ENABLED: input.split === false ? "false" : "true",
    }),
    perps: () => PERPS,
    now: () => input.now,
    soso: fakeSoso(input.items),
    classifier: fakeClaude(input.claude),
  });
  for (const m of input.books)
    sr.books.onMessage(
      `md.${m.toLowerCase()}.book`,
      JSON.stringify({ s: m, b: "99.99", a: "100.01", E: input.now, at: input.now }),
      input.now,
    );
  await sr.runCycle();
}

const cfgWith = (over: Partial<BotVersionConfig>): BotVersionConfig => ({
  ...baselineVersionConfig(),
  ...over,
});

async function onlyVersion(name: string, over: Partial<BotVersionConfig>) {
  await setSignalBotVersionStatus(db, { id: baselineId, status: "paused", userId: null });
  return createSignalBotVersion(db, {
    name,
    config: cfgWith(over),
    createdBy: null,
    savedFromVersionId: baselineId,
    start: true,
    hypothesis: "One change gives a better result after fees.",
    now: new Date(T - HOUR),
  });
}

const trades = () =>
  db
    .select()
    .from(signalPaperTrades)
    .orderBy(asc(signalPaperTrades.openedAt), asc(signalPaperTrades.market));

/** Event Filter / Decide của một bài, theo thứ tự ghi. */
const filterEvents = (articleId: string) =>
  db
    .select({
      outcome: signalEvents.outcome,
      reason: signalEvents.reason,
      storyId: signalEvents.storyId,
      detail: signalEvents.detail,
    })
    .from(signalEvents)
    .where(and(eq(signalEvents.articleId, articleId), eq(signalEvents.stage, "filter")))
    .orderBy(asc(signalEvents.id));

const understandOf = async (articleId: string) => {
  const [e] = await db
    .select({
      outcome: signalEvents.outcome,
      reason: signalEvents.reason,
      detail: signalEvents.detail,
    })
    .from(signalEvents)
    .where(and(eq(signalEvents.articleId, articleId), eq(signalEvents.stage, "understand")));
  return e;
};

const signalsOf = (articleId: string) =>
  db
    .select()
    .from(newsSignals)
    .where(eq(newsSignals.articleId, articleId))
    .orderBy(asc(newsSignals.market));

const storyOf = async (market: string) => {
  const [s] = await db.select().from(signalStories).where(eq(signalStories.market, market));
  return s;
};

const ORIGIN_TITLE = "Major broker to list AAVE, LINK and UNI";
const origin = (at = T) => item("c1", at, ORIGIN_TITLE, ["AAVE", "LINK", "UNI"]);
const originAnswer = { [ORIGIN_TITLE]: listingOf(["AAVE", "LINK", "UNI"]) };
const NO_PRICE = ["NO_SODEX_PRICE", "NO_BOOK_DATA"];

describe("event split: one signal per coin (#530 PR2)", () => {
  it("the three real #530 articles: 15:35 opens 3 signals at size ÷ 3; 20:24 UNI and 23:22 AAVE / LINK open nothing", async () => {
    // 15:35 ChainCatcher AAVE / LINK / UNI. UNI không có giá lúc đó: bỏ ở Filter (câu chuyện đã tạo, vẫn tính vào k).
    await cycle({
      now: T + 2 * MIN,
      items: [origin()],
      claude: originAnswer,
      books: ["AAVE-USD", "LINK-USD"],
    });
    const u = await understandOf("c1");
    expect(u).toMatchObject({ outcome: "pass", reason: null });
    expect(u?.detail).toMatchObject({
      eventKey: "evt:c1",
      eventCoins: 3,
      eventMarkets: ["AAVE-USD", "LINK-USD", "UNI-USD"],
      event: { key: "evt:c1", catalyst: "listing", markets: ["AAVE-USD", "LINK-USD", "UNI-USD"] },
    });
    // Mainnet: một dòng mỗi coin, cùng event_key, event_coins = 3.
    const sig = await signalsOf("c1");
    expect(sig.map((s) => [s.market, s.eventKey, s.eventCoins])).toEqual([
      ["AAVE-USD", "evt:c1", 3],
      ["LINK-USD", "evt:c1", 3],
      ["UNI-USD", "evt:c1", 3],
    ]);
    // Paper: AAVE và LINK mỗi lệnh 500 ÷ 3 = 166.66; UNI bỏ ở Filter, không dồn phần sang coin khác.
    const t1 = await trades();
    expect(t1.map((t) => [t.market, Number(t.sizeUsdc), t.articleId])).toEqual([
      ["AAVE-USD", 166.66, "c1"],
      ["LINK-USD", 166.66, "c1"],
    ]);
    const f1 = await filterEvents("c1");
    const uniDrop = f1.find((e) => e.outcome === "drop");
    expect(NO_PRICE).toContain(uniDrop?.reason);
    expect(uniDrop?.storyId).not.toBeNull();
    // Mỗi coin một câu chuyện (market × loại tin) và một snapshot ngữ cảnh.
    expect((await db.select().from(signalStories)).map((s) => s.storyKey).sort()).toEqual([
      "AAVE-USD|listing",
      "LINK-USD|listing",
      "UNI-USD|listing",
    ]);
    const ctx = await db
      .select({ market: signalContexts.market })
      .from(signalContexts)
      .where(eq(signalContexts.articleId, "c1"));
    expect(ctx.map((c) => c.market).sort()).toEqual(["AAVE-USD", "LINK-USD", "UNI-USD"]);

    // 20:24 Odaily (UNI), ~5 giờ sau: UNI đã có câu chuyện (bỏ ở Filter) → luật thử lại hiện có: quá 120 phút → STORY_TOO_OLD.
    const at2 = Date.parse("2026-11-24T20:24:00Z");
    const uniTitle = "Major broker adds UNI trading";
    await cycle({
      now: at2 + 2 * MIN,
      items: [origin(), item("o1", at2, uniTitle, ["UNI"])],
      claude: { ...originAnswer, [uniTitle]: listingOf(["UNI"]) },
      books: ["AAVE-USD", "LINK-USD", "UNI-USD"],
    });
    expect((await understandOf("o1"))?.detail).toMatchObject({ sameEventOf: "evt:c1" });
    expect(await filterEvents("o1")).toEqual([
      expect.objectContaining({ outcome: "merge", reason: "STORY_TOO_OLD" }),
    ]);
    // Không lệnh mới, không tín hiệu mainnet (ngoài cửa sổ thử lại).
    expect(await trades()).toHaveLength(2);
    expect(await signalsOf("o1")).toEqual([]);

    // 23:22 Odaily (AAVE, LINK): cả hai câu chuyện đã khoá (đã vào lệnh) → SAME_STORY.
    const at3 = Date.parse("2026-11-24T23:22:00Z");
    const pairTitle = "Major broker lists AAVE and LINK";
    await cycle({
      now: at3 + 2 * MIN,
      items: [
        origin(),
        item("o1", at2, uniTitle, ["UNI"]),
        item("o2", at3, pairTitle, ["AAVE", "LINK"]),
      ],
      claude: { ...originAnswer, [pairTitle]: listingOf(["AAVE", "LINK"]) },
      books: ["AAVE-USD", "LINK-USD", "UNI-USD"],
    });
    expect((await filterEvents("o2")).map((e) => `${e.outcome}:${e.reason ?? ""}`)).toEqual([
      "merge:SAME_STORY",
      "merge:SAME_STORY",
    ]);
    expect(await trades()).toHaveLength(2);
    expect(await signalsOf("o2")).toEqual([]);
  });

  it("BTC, ETH, AAVE listing: BTC / ETH fail at Understand and do not count, so k = 1 and AAVE takes the full size", async () => {
    const title = "Exchange lists BTC, ETH and AAVE perpetuals";
    await cycle({
      now: T + 2 * MIN,
      items: [item("m1", T, title, ["BTC", "ETH", "AAVE"])],
      claude: { [title]: listingOf(["BTC", "ETH", "AAVE"]) },
      books: ["AAVE-USD"],
    });
    const u = await understandOf("m1");
    expect(u).toMatchObject({ outcome: "pass" });
    expect(u?.detail).toMatchObject({
      eventCoins: 1,
      eventMarkets: ["AAVE-USD"],
      eventDropped: [
        { market: "BTC-USD", reason: "LISTING_MAJOR_ASSET" },
        { market: "ETH-USD", reason: "LISTING_MAJOR_ASSET" },
      ],
    });
    // k = 1: không có event key (một coin), cỡ đủ như trước.
    expect(u?.detail).not.toHaveProperty("eventKey");
    expect((await trades()).map((t) => [t.market, Number(t.sizeUsdc)])).toEqual([
      ["AAVE-USD", 500],
    ]);
    expect((await signalsOf("m1")).map((s) => [s.market, s.eventKey, s.eventCoins])).toEqual([
      ["AAVE-USD", null, 1],
    ]);
  });

  it("an article that names more than 5 coins is a passing mention for the whole article", async () => {
    const coins = ["AAVE", "LINK", "UNI", "COMP", "CRV", "SNX"];
    const title = "Major broker adds AAVE, LINK, UNI, COMP, CRV and SNX";
    await cycle({
      now: T + 2 * MIN,
      items: [item("six", T, title, coins)],
      claude: { [title]: listingOf(coins) },
      books: coins.map((c) => `${c}-USD`),
    });
    const u = await understandOf("six");
    expect(u).toMatchObject({ outcome: "drop", reason: "PASSING_MENTION" });
    expect(u?.detail).toMatchObject({ eventCoinsListed: 6 });
    expect(await db.select().from(signalStories)).toEqual([]);
    expect(await signalsOf("six")).toEqual([]);
  });

  it("a limit hit mid-event: coins are checked in the order the article names them, the later one goes to shadow", async () => {
    const v = await onlyVersion("Two open", { maxOpenTrades: 2 });
    // Reader trả AAVE, LINK, UNI nhưng bài nêu UNI trước: thứ tự xét giới hạn = thứ tự trong bài.
    const title = "Major broker lists UNI, AAVE and LINK";
    await cycle({
      now: T + 2 * MIN,
      items: [item("lim", T, title, ["AAVE", "LINK", "UNI"])],
      claude: { [title]: { ...listingOf(["AAVE", "LINK", "UNI"]), market: "AAVE-USD" } },
      books: ["AAVE-USD", "LINK-USD", "UNI-USD"],
    });
    expect((await understandOf("lim"))?.detail).toMatchObject({
      eventMarkets: ["UNI-USD", "AAVE-USD", "LINK-USD"],
    });
    const all = await db
      .select()
      .from(signalPaperTrades)
      .where(eq(signalPaperTrades.versionId, v.id));
    const by = new Map(all.map((t) => [t.market, t]));
    expect(by.get("UNI-USD")?.label).toBe("live");
    expect(by.get("AAVE-USD")?.label).toBe("live");
    expect(Number(by.get("UNI-USD")?.sizeUsdc)).toBe(166.66);
    expect(by.get("LINK-USD")).toMatchObject({ label: "shadow", shadowReason: "LIMIT_OPEN" });
  });

  it("paper: a share below the SoDEX minimum is dropped with BELOW_MIN_ORDER_SIZE, still counted in k, no reallocation", async () => {
    // 20 USDC ÷ 3 = 6.66 < min notional 10.
    const v = await onlyVersion("Small", { sizeUsdc: "20" });
    await cycle({
      now: T + 2 * MIN,
      items: [origin()],
      claude: originAnswer,
      books: ["AAVE-USD", "LINK-USD", "UNI-USD"],
    });
    const f = await filterEvents("c1");
    expect(f.map((e) => `${e.outcome}:${e.reason ?? ""}`)).toEqual([
      "drop:BELOW_MIN_ORDER_SIZE",
      "drop:BELOW_MIN_ORDER_SIZE",
      "drop:BELOW_MIN_ORDER_SIZE",
    ]);
    expect(f[0]?.detail).toMatchObject({ sizeUsdc: "6.66", eventCoins: 3 });
    expect(f.every((e) => e.storyId !== null)).toBe(true);
    expect(
      await db.select().from(signalPaperTrades).where(eq(signalPaperTrades.versionId, v.id)),
    ).toEqual([]);
    // Lý do API mới trong feed bài.
    const page = await loadSignalResearchArticles(
      db,
      researchArticlesQuerySchema.parse({ range: "1d", versionId: v.id }),
      new Date(T + 3 * MIN),
    );
    expect(page.items.find((a) => a.id === "c1")).toMatchObject({
      stage: "filter",
      outcome: "dropped",
      reason: "belowMinSize",
    });
  });
});

describe("SIGNAL_NEWS_EVENT_SPLIT_ENABLED off (default): mainnet one row per article (#530 PR2)", () => {
  it("the multi-coin article writes one row for the main coin (event_coins 1, no event key, no other coins); paper still splits", async () => {
    await cycle({
      now: T + 2 * MIN,
      items: [origin()],
      claude: originAnswer,
      books: ["AAVE-USD", "LINK-USD", "UNI-USD"],
      split: false,
    });
    expect((await signalsOf("c1")).map((s) => [s.market, s.eventKey, s.eventCoins])).toEqual([
      ["AAVE-USD", null, 1],
    ]);
    // Paper / research không đọc cờ: ba lệnh, mỗi lệnh 500 ÷ 3.
    expect((await trades()).map((t) => [t.market, Number(t.sizeUsdc)])).toEqual([
      ["AAVE-USD", 166.66],
      ["LINK-USD", 166.66],
      ["UNI-USD", 166.66],
    ]);
    expect((await understandOf("c1"))?.detail).toMatchObject({ eventKey: "evt:c1", eventCoins: 3 });
  });

  it("a retry inside the window: mainnet writes only the repost's main coin with event_coins 1; SAME_EVENT still blocks new coins", async () => {
    // Bài gốc, LINK không có giá (paper: câu chuyện LINK chưa khoá).
    await cycle({
      now: T + 2 * MIN,
      items: [origin()],
      claude: originAnswer,
      books: ["AAVE-USD", "UNI-USD"],
      split: false,
    });
    const at = T + 60 * MIN;
    const title = "Major broker lists LINK, AAVE and COMP";
    await cycle({
      now: at + 2 * MIN,
      items: [origin(), item("off-r", at, title, ["LINK", "AAVE", "COMP"])],
      claude: { ...originAnswer, [title]: listingOf(["LINK", "AAVE", "COMP"]) },
      books: ["AAVE-USD", "LINK-USD", "UNI-USD", "COMP-USD"],
      split: false,
    });
    // Coin chính của bài đăng lại là LINK (thử lại trong cửa sổ): một dòng, event_coins 1, không event key; không AAVE, không COMP.
    expect((await signalsOf("off-r")).map((s) => [s.market, s.eventKey, s.eventCoins])).toEqual([
      ["LINK-USD", null, 1],
    ]);
    // Paper: LINK thử lại với k = 3 của bài gốc, AAVE SAME_STORY, COMP SAME_EVENT.
    expect((await filterEvents("off-r")).map((e) => `${e.outcome}:${e.reason ?? ""}`)).toEqual([
      "pass:",
      "merge:SAME_STORY",
      "drop:SAME_EVENT",
    ]);
    const link = (await trades()).find((t) => t.market === "LINK-USD");
    expect(Number(link?.sizeUsdc)).toBe(166.66);
  });

  it("a repost outside the window writes nothing on mainnet, like with the flag on", async () => {
    await cycle({
      now: T + 2 * MIN,
      items: [origin()],
      claude: originAnswer,
      books: ["AAVE-USD", "LINK-USD", "UNI-USD"],
      split: false,
    });
    const at = T + 3 * HOUR;
    const title = "Major broker lists UNI and COMP";
    await cycle({
      now: at + 2 * MIN,
      items: [origin(), item("off-late", at, title, ["UNI", "COMP"])],
      claude: { ...originAnswer, [title]: listingOf(["UNI", "COMP"]) },
      books: ["UNI-USD", "COMP-USD"],
      split: false,
    });
    expect(await signalsOf("off-late")).toEqual([]);
  });
});

describe("SIGNAL_NEWS_EVENT_SPLIT_ENABLED on: mainnet one row per coin (#530 PR2)", () => {
  it("k rows with one event key and event_coins = k", async () => {
    await cycle({
      now: T + 2 * MIN,
      items: [origin()],
      claude: originAnswer,
      books: ["AAVE-USD", "LINK-USD", "UNI-USD"],
      split: true,
    });
    expect((await signalsOf("c1")).map((s) => [s.market, s.eventKey, s.eventCoins])).toEqual([
      ["AAVE-USD", "evt:c1", 3],
      ["LINK-USD", "evt:c1", 3],
      ["UNI-USD", "evt:c1", 3],
    ]);
  });
});

describe("single-coin articles keep the old path (#530 PR2)", () => {
  it("one coin: no event fields, full size, story key market x type, one mainnet row with event_coins 1; a repost is SAME_STORY, never SAME_EVENT", async () => {
    const title = "Major broker lists SOL perpetuals";
    // Reader v6 trả lời không có `markets` (bài trước v7): coi như chỉ `market`.
    const answer: Classification = {
      catalyst: "listing",
      market: "SOL-USD",
      relevance: "direct",
      promotional: false,
      eventDate: "2026-11-24",
    };
    await cycle({
      now: T + 2 * MIN,
      items: [item("one", T, title, ["SOL"])],
      claude: { [title]: answer },
      books: ["SOL-USD"],
    });
    const u = await understandOf("one");
    expect(u).toMatchObject({ outcome: "pass", reason: null });
    for (const k of [
      "event",
      "eventKey",
      "eventCoins",
      "eventMarkets",
      "eventDropped",
      "sameEventOf",
    ])
      expect(u?.detail).not.toHaveProperty(k);
    const [a] = await db.select().from(signalArticles).where(eq(signalArticles.id, "one"));
    expect(a?.classification).not.toHaveProperty("event");
    const t = await trades();
    expect(t.map((x) => [x.market, Number(x.sizeUsdc)])).toEqual([["SOL-USD", 500]]);
    expect((await db.select().from(signalStories)).map((s) => s.storyKey)).toEqual([
      "SOL-USD|listing",
    ]);
    expect((await signalsOf("one")).map((s) => [s.market, s.eventKey, s.eventCoins])).toEqual([
      ["SOL-USD", null, 1],
    ]);

    // Bài đăng lại một coin 30 phút sau: SAME_STORY như trước (bài một coin không ghi sự kiện, nên không bao giờ SAME_EVENT).
    const again = "SOL perpetuals go live on a major broker";
    await cycle({
      now: T + 32 * MIN,
      items: [item("one", T, title, ["SOL"]), item("one-b", T + 30 * MIN, again, ["SOL"])],
      claude: { [title]: answer, [again]: answer },
      books: ["SOL-USD"],
    });
    expect((await filterEvents("one-b")).map((e) => `${e.outcome}:${e.reason ?? ""}`)).toEqual([
      "merge:SAME_STORY",
    ]);
    expect((await understandOf("one-b"))?.detail).not.toHaveProperty("sameEventOf");
    expect(await trades()).toHaveLength(1);
  });
});

describe("reposts of an event (#530 PR2)", () => {
  /** Bài gốc AAVE / LINK / UNI; LINK không có giá → bỏ ở Filter (câu chuyện chưa khoá). */
  async function originWithLinkDropped() {
    await cycle({
      now: T + 2 * MIN,
      items: [origin()],
      claude: originAnswer,
      books: ["AAVE-USD", "UNI-USD"],
    });
    expect((await trades()).map((t) => t.market)).toEqual(["AAVE-USD", "UNI-USD"]);
    expect(await storyOf("LINK-USD")).toMatchObject({ locked: false, outcome: "skipped" });
  }
  const pairTitle = "Major broker lists AAVE and LINK";
  const pair = (at: number) => item("r1", at, pairTitle, ["AAVE", "LINK"]);

  it("a coin dropped at Filter, repost inside the retry window: retried with the first article's k (paper and mainnet)", async () => {
    await originWithLinkDropped();
    const at = T + 60 * MIN;
    await cycle({
      now: at + 2 * MIN,
      items: [origin(), pair(at)],
      claude: { ...originAnswer, [pairTitle]: listingOf(["AAVE", "LINK"]) },
      books: ["AAVE-USD", "LINK-USD", "UNI-USD"],
    });
    // AAVE đã vào lệnh → SAME_STORY; LINK thử lại (luật thử lại hiện có) với k = 3 của bài gốc: 166.66, không phải 250 / 500.
    const f = await filterEvents("r1");
    expect(f.map((e) => `${e.outcome}:${e.reason ?? ""}`)).toEqual(["merge:SAME_STORY", "pass:"]);
    const link = (await trades()).find((t) => t.market === "LINK-USD");
    expect(link).toMatchObject({ articleId: "r1", retry: true });
    expect(Number(link?.sizeUsdc)).toBe(166.66);
    // Mainnet: lần thử lại mang event_key và event_coins của bài gốc.
    const sig = await signalsOf("r1");
    expect(sig.find((s) => s.market === "LINK-USD")).toMatchObject({
      eventKey: "evt:c1",
      eventCoins: 3,
    });
  });

  it("a coin dropped at Filter, repost outside the retry window: STORY_TOO_OLD, no mainnet signal", async () => {
    await originWithLinkDropped();
    const at = T + 3 * HOUR;
    await cycle({
      now: at + 2 * MIN,
      items: [origin(), pair(at)],
      claude: { ...originAnswer, [pairTitle]: listingOf(["AAVE", "LINK"]) },
      books: ["AAVE-USD", "LINK-USD", "UNI-USD"],
    });
    expect((await filterEvents("r1")).map((e) => `${e.outcome}:${e.reason ?? ""}`)).toEqual([
      "merge:SAME_STORY",
      "merge:STORY_TOO_OLD",
    ]);
    expect((await trades()).map((t) => t.market)).toEqual(["AAVE-USD", "UNI-USD"]);
    expect(await signalsOf("r1")).toEqual([]);
  });

  it("B3: a repost with a traded coin and a new coin: AAVE merges SAME_STORY, COMP drops SAME_EVENT with no story; the article follows the existing state rule", async () => {
    await originWithLinkDropped();
    const at = T + 60 * MIN;
    const title = "Major broker adds AAVE and COMP";
    await cycle({
      now: at + 2 * MIN,
      items: [origin(), item("b3", at, title, ["AAVE", "COMP"])],
      claude: { ...originAnswer, [title]: listingOf(["AAVE", "COMP"]) },
      books: ["AAVE-USD", "COMP-USD", "UNI-USD", "LINK-USD"],
    });
    const f = await filterEvents("b3");
    expect(f.map((e) => `${e.outcome}:${e.reason ?? ""}`)).toEqual([
      "merge:SAME_STORY",
      "drop:SAME_EVENT",
    ]);
    // SAME_EVENT: không story, không lệnh, không tín hiệu mainnet cho coin mới.
    expect(f[1]?.storyId).toBeNull();
    expect(f[1]?.detail).toMatchObject({ eventKey: "evt:c1" });
    expect(await storyOf("COMP-USD")).toBeUndefined();
    expect((await trades()).some((t) => t.market === "COMP-USD")).toBe(false);
    // Mainnet: COMP (coin mới) không có tín hiệu; AAVE (coin của bài gốc, trong cửa sổ thử lại) vẫn ghi như mọi bài đăng
    // lại của một câu chuyện, engine bỏ bằng SAME_STORY của chính nó.
    expect((await signalsOf("b3")).map((s) => [s.market, s.eventKey, s.eventCoins])).toEqual([
      ["AAVE-USD", "evt:c1", 3],
    ]);
    // Trạng thái bài theo SQL hiện có (DEC-327): không có lệnh → event Filter cuối theo giờ, cùng giờ thì event ghi trước
    // (coin bài nêu trước, AAVE) → merged · sameStory.
    const page = await loadSignalResearchArticles(
      db,
      researchArticlesQuerySchema.parse({ range: "1d" }),
      new Date(at + 3 * MIN),
    );
    expect(page.items.find((a) => a.id === "b3")).toMatchObject({
      stage: "filter",
      outcome: "merged",
      mergeReason: "sameStory",
      reason: null,
    });
  });

  it("a repost with no overlapping coin is a new event: its own key and k", async () => {
    await originWithLinkDropped();
    const at = T + 60 * MIN;
    const title = "Major broker lists SOL and COMP";
    await cycle({
      now: at + 2 * MIN,
      items: [origin(), item("n1", at, title, ["SOL", "COMP"])],
      claude: { ...originAnswer, [title]: listingOf(["SOL", "COMP"]) },
      books: ["SOL-USD", "COMP-USD", "AAVE-USD", "UNI-USD"],
    });
    const u = await understandOf("n1");
    expect(u?.detail).toMatchObject({ eventKey: "evt:n1", eventCoins: 2 });
    expect(u?.detail).not.toHaveProperty("sameEventOf");
    const fresh = (await trades()).filter((t) => t.articleId === "n1");
    expect(fresh.map((t) => [t.market, Number(t.sizeUsdc)])).toEqual([
      ["COMP-USD", 250],
      ["SOL-USD", 250],
    ]);
    expect((await signalsOf("n1")).map((s) => [s.market, s.eventKey, s.eventCoins])).toEqual([
      ["COMP-USD", "evt:n1", 2],
      ["SOL-USD", "evt:n1", 2],
    ]);
  });

  it("the article row stores the event for later reposts", async () => {
    await originWithLinkDropped();
    const [a] = await db.select().from(signalArticles).where(eq(signalArticles.id, "c1"));
    expect(a?.classification).toMatchObject({
      event: { key: "evt:c1", catalyst: "listing" },
      eventCoins: 3,
    });
  });
});

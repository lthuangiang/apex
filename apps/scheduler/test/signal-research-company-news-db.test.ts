import {
  candles1m,
  createDb,
  loadSignalResearchArticles,
  newsSignals,
  runMigrations,
  signalArticles,
  signalBotVersions,
  signalContexts,
  signalEvents,
  type Db,
} from "@drift/db";
import { NEWS_RULES, researchArticlesQuerySchema } from "@drift/shared";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  emptyUsage,
  type Classification,
  type ClassifyInput,
  type NewsClassifier,
} from "../src/signal-research/classifier";
import {
  createSignalResearch,
  signalResearchEnvSchema,
  type Logger,
} from "../src/signal-research/index";
import type { RestBookResult } from "../src/signal-research/prices";
import type { SosoClient, SosoNewsItem } from "../src/signal-research/soso";

// #593 (news-v7, DEC-402 mục 6) trên Postgres thật: tin công ty Anthropic → ANT-USD (tag SoSoValue hoặc tên trong bài),
// tin sản phẩm / không rõ bị bỏ trước Claude, market khác không đổi, độ sâu sổ lệnh lúc quyết định nằm trên snapshot
// Context và feed (`market`, `book`). SoSoValue / Claude / marketdata là mock; không có SoDEX. Tiêu đề là câu mẫu tự viết.

const MIN = 60_000;
const HOUR = 60 * MIN;
const T = Date.parse("2026-11-28T09:00:00Z");
const NOW = T + 2 * MIN;
const ANT_TAG = { symbol: "ANT", name: '{"EN":"ANTHROPIC"}' };

let container: StartedPostgreSqlContainer;
let db: Db;
let pool: ReturnType<typeof createDb>["pool"];

beforeAll(async () => {
  container = await new PostgreSqlContainer("timescale/timescaledb:2.16.1-pg16").start();
  await runMigrations(container.getConnectionUri());
  ({ db, pool } = createDb(container.getConnectionUri()));
  const rows = [];
  for (const market of ["ANT-USD", "SOL-USD"])
    for (let h = 31 * 24; h >= 0; h -= 1) {
      const ts = T - h * HOUR;
      const close = Math.floor(ts / (24 * HOUR)) % 2 === 0 ? "100" : "102";
      rows.push({
        market,
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
    sql`truncate news_signals cascade; truncate signal_articles, signal_events, signal_stories, signal_paper_trades, signal_research_usage, signal_source_health, signal_contexts, signal_context_coins`,
  );
  await db
    .update(signalBotVersions)
    .set({ status: "running" })
    .where(eq(signalBotVersions.isBaseline, true));
});

function item(
  id: string,
  title: string,
  tags: SosoNewsItem["matched_currencies"],
  content = `<p>${title}</p>`,
): SosoNewsItem {
  return {
    id,
    release_time: T,
    title,
    content,
    author: "Bloomberg",
    category: 1,
    source_link: `https://sosovalue.com/${id}`,
    original_link: null,
    matched_currencies: tags,
  };
}

const fakeSoso = (items: SosoNewsItem[]): SosoClient => ({
  newsPage: (page: number) => Promise.resolve({ items: page === 1 ? items : [], invalid: 0 }),
});

const NONE: Classification = {
  catalyst: "none",
  market: null,
  relevance: "passing_mention",
  promotional: false,
  eventDate: null,
};

function fakeClaude(byTitle: Record<string, Classification>) {
  const seen: ClassifyInput[] = [];
  const classifier: NewsClassifier = {
    classify: (input) => {
      seen.push(input);
      return Promise.resolve({
        ok: true as const,
        value: byTitle[input.title ?? ""] ?? NONE,
        usage: { ...emptyUsage(), calls: 1, input: 1500, output: 40 },
      });
    },
  };
  return { classifier, seen };
}

const quiet: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => quiet,
};

const PERPS = ["ANT-USD", "SOL-USD"].map((name) => ({
  name,
  status: "TRADING",
  tickSize: "0.01",
  takerFee: "0.0004",
  stepSize: "0.01",
  minQuantity: "0.01",
  minNotional: "10",
}));

async function cycle(input: {
  items: SosoNewsItem[];
  claude: Record<string, Classification>;
  book?: (market: string) => Promise<RestBookResult>;
}) {
  const claude = fakeClaude(input.claude);
  const sr = createSignalResearch({
    db,
    redis: { mget: (...keys: string[]) => Promise.resolve(keys.map(() => null)) },
    log: quiet,
    env: signalResearchEnvSchema.parse({
      SIGNAL_RESEARCH_ENABLED: "true",
      SOSO_API_KEY: "k",
      DESK_AI_API_KEY: "c",
      SIGNAL_NEWS_PUBLISH_ENABLED: "true",
    }),
    perps: () => PERPS,
    now: () => NOW,
    soso: fakeSoso(input.items),
    classifier: claude.classifier,
    ...(input.book === undefined ? {} : { requestBook: input.book }),
  });
  for (const m of ["ANT-USD", "SOL-USD"])
    sr.books.onMessage(
      `md.${m.toLowerCase()}.book`,
      JSON.stringify({ s: m, b: "99.99", a: "100.01", E: NOW, at: NOW }),
      NOW,
    );
  await sr.runCycle();
  return claude.seen;
}

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

const regulator = (market: string): Classification => ({
  catalyst: "regulatory_action",
  market,
  markets: [market],
  relevance: "direct",
  promotional: false,
  eventDate: "2026-11-28",
});

const COMPANY = "Regulator opens inquiry into Anthropic";
const PRODUCT = "Anthropic releases a new Claude model";
const UNCLEAR = "Anthropic CEO speaks at a conference";
const TEXT_ONLY = "Authors sue Anthropic over training data";
const MIXED = "Solana protocol drained; Anthropic tool found the bug";

const depthBook = (): ((market: string) => Promise<RestBookResult>) => (market) =>
  Promise.resolve(
    market === "ANT-USD"
      ? {
          ok: true,
          bid: "99.99",
          ask: "100.01",
          at: NOW,
          depth: { bidsUsd: "2610", asksUsd: "2180" },
        }
      : { ok: false, reason: "unknown_market" },
  );

describe("company news → ANT-USD (#593)", () => {
  it("company news is read by Claude on ANT-USD; product and unclear news are dropped before Claude", async () => {
    const seen = await cycle({
      items: [
        item("co", COMPANY, [ANT_TAG]),
        item("pr", PRODUCT, [ANT_TAG]),
        item("un", UNCLEAR, [ANT_TAG]),
      ],
      claude: { [COMPANY]: regulator("ANT-USD") },
      book: depthBook(),
    });
    expect(seen.map((x) => x.title)).toEqual([COMPANY]);
    expect(seen[0]?.candidates).toEqual([{ symbol: "ANT", market: "ANT-USD", kind: "stock" }]);

    expect(await understandOf("co")).toMatchObject({ outcome: "pass", reason: null });
    expect((await understandOf("co"))?.detail).toMatchObject({ market: "ANT-USD" });
    const pr = await understandOf("pr");
    expect(pr).toMatchObject({ outcome: "drop", reason: "PRODUCT_NEWS" });
    expect(pr?.detail).toMatchObject({ companyNews: [{ market: "ANT-USD", kind: "product" }] });
    expect(await understandOf("un")).toMatchObject({ outcome: "drop", reason: "NOT_COMPANY_NEWS" });

    const arts = new Map((await db.select().from(signalArticles)).map((a) => [a.id, a]));
    expect(arts.get("pr")).toMatchObject({ status: "dropped", claudeCalls: null });
    expect(arts.get("co")?.ruleVersion).toBe(NEWS_RULES.version);

    // Bot `news_signal` mainnet: chỉ tin công ty ra tín hiệu (cap theo sổ của #590 nằm ở engine).
    const sig = await db.select().from(newsSignals);
    expect(sig.map((x) => [x.articleId, x.market, x.side])).toEqual([["co", "ANT-USD", "short"]]);

    // Book at the time: snapshot Context của tin công ty mang độ sâu 10 mức mỗi phía.
    const [ctx] = await db.select().from(signalContexts).where(eq(signalContexts.articleId, "co"));
    expect(ctx?.bookBidsUsd).not.toBeNull();
    expect(Number(ctx?.bookBidsUsd)).toBe(2610);
    expect(Number(ctx?.bookAsksUsd)).toBe(2180);
  });

  it("an article naming Anthropic without a tag gets ANT-USD from its text", async () => {
    const seen = await cycle({
      items: [item("tx", TEXT_ONLY, [])],
      claude: { [TEXT_ONLY]: regulator("ANT-USD") },
    });
    expect(seen[0]?.candidates).toEqual([{ symbol: "ANT", market: "ANT-USD", kind: "stock" }]);
    expect(await understandOf("tx")).toMatchObject({ outcome: "pass" });
    // Không có marketdata (requestBook): không chụp độ sâu, cột null ("–").
    const [ctx] = await db.select().from(signalContexts).where(eq(signalContexts.articleId, "tx"));
    expect(ctx?.bookBidsUsd ?? null).toBeNull();
  });

  it("other markets do not change: ANT-USD product mention leaves the list, SOL-USD still goes to Claude", async () => {
    const seen = await cycle({
      items: [item("mx", MIXED, [{ symbol: "SOL", name: "Solana" }])],
      claude: {},
    });
    expect(seen[0]?.candidates).toEqual([{ symbol: "SOL", market: "SOL-USD", kind: "crypto" }]);
    const arts = await db.select().from(signalArticles).where(eq(signalArticles.id, "mx"));
    // Ứng viên sau Normalize vẫn ghi cả ANT-USD (tab market); chỉ danh sách gửi Claude bỏ nó.
    expect((arts[0]?.candidates as { market: string }[]).map((c) => c.market)).toEqual([
      "ANT-USD",
      "SOL-USD",
    ]);
  });

  it("a coin tagged ANT and lowercase 'anthropic' never reach ANT-USD", async () => {
    const seen = await cycle({
      items: [
        item("ar", "ANT token holders vote on treasury", [{ symbol: "ANT", name: "Aragon" }]),
        item("lw", "The anthropic principle explained", [], "<p>the anthropic principle</p>"),
      ],
      claude: {},
    });
    expect(seen).toEqual([]);
    const arts = new Map((await db.select().from(signalArticles)).map((a) => [a.id, a]));
    expect(arts.get("ar")).toMatchObject({ status: "dropped", candidates: [] });
    expect(arts.get("lw")).toMatchObject({ status: "dropped", candidates: [] });
  });

  it("feed: market=ANT-USD lists only ANT-USD articles, with productNews and the book at the time", async () => {
    await cycle({
      items: [
        item("co", COMPANY, [ANT_TAG]),
        item("pr", PRODUCT, [ANT_TAG]),
        item("so", "Solana recap", [{ symbol: "SOL", name: "Solana" }]),
      ],
      claude: { [COMPANY]: regulator("ANT-USD") },
      book: depthBook(),
    });
    const q = researchArticlesQuerySchema.parse({ market: "ANT-USD", limit: "50" });
    const page = await loadSignalResearchArticles(db, q, new Date(NOW + MIN));
    const by = new Map(page.items.map((x) => [x.id, x]));
    expect([...by.keys()].sort()).toEqual(["co", "pr"]);
    expect(page.total).toBe(2);
    expect(by.get("pr")).toMatchObject({ outcome: "dropped", reason: "productNews", book: null });
    expect(by.get("co")).toMatchObject({
      asset: "ANT-USD",
      side: "short",
      book: { bidsUsd: "2610", asksUsd: "2180" },
    });
    const all = await loadSignalResearchArticles(
      db,
      researchArticlesQuerySchema.parse({ limit: "50" }),
      new Date(NOW + MIN),
    );
    expect(all.items.map((x) => x.id).sort()).toEqual(["co", "pr", "so"]);
  });
});

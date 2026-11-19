import type {
  ResearchArticle,
  ResearchArticleTrace,
  ResearchClaudeUsage,
  ResearchFunnel,
  ResearchSummary,
  ResearchTraceStep,
} from "@drift/shared";

import { RESEARCH_SUMMARY } from "./research-fixtures";

// Dữ liệu giả của News feed và funnel trace (#292), theo số mẫu của docs/mockups/signal-research/news-trace.html. Giờ ở
// UTC; trong múi giờ Asia/Ho_Chi_Minh (UTC+7) chúng khớp giờ trên mockup (10:16 → 03:16Z).

const BASE = RESEARCH_SUMMARY.funnel;
if (BASE === null) throw new Error("fixture");

/** Phễu 1 ngày như thiết kế: 58 bài, 25 câu chuyện, 3 tín hiệu, 1 còn lại, Long 1. */
export const FUNNEL_1D: ResearchFunnel = {
  ...BASE,
  days: 1,
  delayMedianSecs: 260,
  claudeCostPerDay: "0.03",
  articlesRead: 58,
  collected: 58,
  stories: 25,
  signals: 3,
  passed: 1,
  long: 1,
  short: 0,
  articleStops: [
    { stage: "collect", outcome: "dropped", reason: "noTaggedCurrency", mergeReason: null, n: 3 },
    { stage: "normalize", outcome: "dropped", reason: "notOnSodex", mergeReason: null, n: 31 },
    { stage: "normalize", outcome: "dropped", reason: "duplicate", mergeReason: null, n: 2 },
    { stage: "score", outcome: "dropped", reason: "notCatalyst", mergeReason: null, n: 15 },
    { stage: "score", outcome: "dropped", reason: "promotional", mergeReason: null, n: 4 },
    { stage: "filter", outcome: "dropped", reason: "tpUnderCost", mergeReason: null, n: 1 },
    { stage: "filter", outcome: "merged", reason: null, mergeReason: "sameStory", n: 1 },
    { stage: "decide", outcome: "traded", reason: null, mergeReason: null, n: 1 },
  ],
};

export const SUMMARY_1D: ResearchSummary = { ...RESEARCH_SUMMARY, funnel: FUNNEL_1D };
export const SUMMARY_7D: ResearchSummary = RESEARCH_SUMMARY;

const TRADE_ID = "3f0c2a8e-5b7d-4c1e-9a2b-1d2e3f4a5b6c";
const STORY_ID = "7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";

const usage = (cost: string, input: number, output: number): ResearchClaudeUsage => ({
  calls: 1,
  tokens: { input, cacheWrite: 0, cacheRead: 4635, output },
  costUsd: cost,
  model: "claude-haiku-4-5",
  promptVersion: "v1",
});

function article(p: Partial<ResearchArticle> & Pick<ResearchArticle, "id">): ResearchArticle {
  return {
    title: null,
    excerpt: null,
    url: null,
    source: "Reuters",
    tier: "top",
    publishedAt: "2026-11-19T03:16:02.000Z",
    collectedAt: "2026-11-19T03:20:11.000Z",
    delaySecs: 249,
    tagged: [],
    candidates: [],
    asset: null,
    side: null,
    stage: "collect",
    outcome: "dropped",
    reason: null,
    mergeReason: null,
    sentToClaude: false,
    claude: null,
    tradeId: null,
    ...p,
  };
}

export const ETH = article({
  id: "art-eth",
  title: "SEC approves in-kind creations for spot ETH ETFs",
  url: "https://example.com/eth-etf",
  tagged: ["ETH"],
  candidates: ["ETH-USD"],
  asset: "ETH",
  side: "long",
  stage: "decide",
  outcome: "traded",
  sentToClaude: true,
  claude: usage("0.00213", 512, 118),
  tradeId: TRADE_ID,
});

export const HYPE = article({
  id: "art-hype",
  title: "Hyperliquid: six whales liquidated for about $38.73M in BTC",
  source: "on-chain data",
  tier: "low",
  publishedAt: "2026-11-19T03:29:40.000Z",
  collectedAt: "2026-11-19T03:33:52.000Z",
  delaySecs: 252,
  tagged: ["BTC", "HYPE"],
  candidates: ["BTC-USD", "HYPE-USD"],
  stage: "score",
  reason: "notCatalyst",
  sentToClaude: true,
  // Bài cũ trước khi lưu usage: đã gửi Claude mà không có chi phí → "Not available".
  claude: null,
});

export const SOL = article({
  id: "art-sol",
  title: "Solana Foundation flags exploit in a lending protocol",
  source: "project account",
  tier: "mid",
  publishedAt: "2026-11-19T02:52:30.000Z",
  collectedAt: "2026-11-19T02:58:05.000Z",
  delaySecs: 335,
  tagged: ["SOL"],
  candidates: ["SOL-USD"],
  asset: "SOL",
  side: "short",
  stage: "filter",
  reason: "tpUnderCost",
  sentToClaude: true,
  claude: usage("0.0022", 498, 120),
});

export const KNTQ = article({
  id: "art-kntq",
  title: "Bithumb will list the KNTQ/KRW trading pair",
  source: "exchange notice",
  publishedAt: "2026-11-19T03:01:12.000Z",
  collectedAt: "2026-11-19T03:04:30.000Z",
  delaySecs: 198,
  tagged: ["KNTQ"],
  stage: "normalize",
  reason: "notOnSodex",
});

export const MERGED = article({
  id: "art-merged",
  title: null,
  excerpt: "Spot ETH ETF approval confirmed by a second outlet",
  source: "CoinDesk",
  tier: "mid",
  tagged: ["ETH"],
  candidates: ["ETH-USD"],
  asset: "ETH",
  side: "long",
  stage: "filter",
  outcome: "merged",
  mergeReason: "sameStory",
  sentToClaude: true,
  claude: usage("0.0019", 420, 90),
});

export const ARTICLES: ResearchArticle[] = [ETH, HYPE, SOL, KNTQ, MERGED];
export const PAGE_SIZE = 4;

const none = { reason: null, mergeReason: null, code: null } as const;
const notReached = <K extends ResearchTraceStep["key"]>(key: K) =>
  ({ key, status: "notReached", at: null, ...none, detail: null }) as const;

function collect(a: ResearchArticle, names: Record<string, string>): ResearchTraceStep {
  return {
    key: "collect",
    status: "pass",
    at: a.collectedAt,
    ...none,
    detail: {
      publishedAt: a.publishedAt,
      collectedAt: a.collectedAt,
      delaySecs: a.delaySecs,
      source: a.source,
      tier: a.tier,
      url: a.url,
      tagged: a.tagged.map((symbol) => ({ symbol, name: names[symbol] ?? null })),
    },
  };
}

const check = (
  key: "sourceLive" | "priceAvailable" | "noOpenTrade" | "tpVsCost",
  p: Partial<{
    ok: boolean;
    code: string | null;
    value: number | null;
    limit: number | null;
    costPct: number | null;
    spreadPct: number | null;
  }> = {},
) => ({
  key,
  ok: true,
  code: null,
  value: null,
  limit: null,
  costPct: null,
  spreadPct: null,
  openTradeId: null,
  ...p,
});

export const ETH_TRACE: ResearchArticleTrace = {
  article: ETH,
  steps: [
    collect(ETH, { ETH: "ETHEREUM" }),
    {
      key: "normalize",
      status: "pass",
      at: ETH.collectedAt,
      ...none,
      detail: {
        candidates: [{ symbol: "ETH", market: "ETH-USD", kind: "crypto" }],
        duplicateOf: null,
        story: {
          id: STORY_ID,
          key: "ETH-USD|etfApproved",
          market: "ETH-USD",
          newsType: "etfApproved",
          isNew: true,
          sources: 1,
          levelAtEntry: "medium",
          laterLevel: "medium",
          outcome: "entered",
          tradeId: TRADE_ID,
        },
      },
    },
    {
      key: "score",
      status: "pass",
      at: ETH.collectedAt,
      ...none,
      detail: {
        sentToClaude: true,
        signalType: true,
        newsType: "etfApproved",
        side: "long",
        maxHoldHours: 72,
        asset: "ETH",
        relevance: "direct",
        promotional: false,
        eventDate: "2026-11-19",
        error: null,
        level: "medium",
        laterLevel: "medium",
        levelSources: [{ name: "Reuters", tier: "top" }],
        claude: ETH.claude,
        labelable: true,
        label: null,
      },
    },
    {
      key: "filter",
      status: "pass",
      at: ETH.collectedAt,
      ...none,
      detail: {
        level: "medium",
        checks: [
          check("sourceLive", { value: 4.15, limit: 30 }),
          check("priceAvailable", { spreadPct: 0.011 }),
          check("noOpenTrade"),
          check("tpVsCost", { value: 1.6, limit: 0.2, costPct: 0.1 }),
        ],
        laterLevel: null,
        storyStartedAt: null,
      },
    },
    {
      key: "decide",
      status: "pass",
      at: "2026-11-19T03:20:14.000Z",
      ...none,
      detail: {
        tradeId: TRADE_ID,
        side: "long",
        sizeUsdc: "500",
        entry: "3412.50",
        openedAt: "2026-11-19T03:20:14.000Z",
        tp: "3467.10",
        tpPct: 1.6,
        sl: "3385.20",
        slPct: -0.8,
        maxHoldHours: 72,
        maxHoldUntil: "2026-11-22T03:20:14.000Z",
        priceSource: "book",
        retry: false,
        movedBeforePct: null,
        status: "open",
        random: null,
      },
    },
  ],
};

export const SOL_TRACE: ResearchArticleTrace = {
  article: SOL,
  steps: [
    collect(SOL, {}),
    {
      key: "normalize",
      status: "pass",
      at: SOL.collectedAt,
      ...none,
      detail: {
        candidates: [{ symbol: "SOL", market: "SOL-USD", kind: "crypto" }],
        duplicateOf: null,
        story: null,
      },
    },
    {
      key: "score",
      status: "pass",
      at: SOL.collectedAt,
      ...none,
      detail: {
        sentToClaude: true,
        signalType: true,
        newsType: "hack",
        side: "short",
        maxHoldHours: 24,
        asset: "SOL",
        relevance: "direct",
        promotional: false,
        eventDate: null,
        error: null,
        level: "low",
        laterLevel: null,
        levelSources: null,
        claude: SOL.claude,
        labelable: true,
        label: null,
      },
    },
    {
      key: "filter",
      status: "drop",
      at: SOL.collectedAt,
      reason: "tpUnderCost",
      mergeReason: null,
      code: "MOVE_TOO_SMALL_FOR_COST",
      detail: {
        level: "low",
        checks: [
          check("sourceLive", { value: 5.6, limit: 30 }),
          check("priceAvailable"),
          check("noOpenTrade"),
          check("tpVsCost", {
            ok: false,
            code: "MOVE_TOO_SMALL_FOR_COST",
            value: 0.15,
            limit: 0.2,
            costPct: 0.1,
          }),
        ],
        laterLevel: null,
        storyStartedAt: null,
      },
    },
    notReached("decide"),
  ],
};

export const KNTQ_TRACE: ResearchArticleTrace = {
  article: KNTQ,
  steps: [
    collect(KNTQ, {}),
    {
      key: "normalize",
      status: "drop",
      at: KNTQ.collectedAt,
      reason: "notOnSodex",
      mergeReason: null,
      code: "NO_SODEX_MARKET",
      detail: { candidates: [], duplicateOf: null, story: null },
    },
    notReached("score"),
    notReached("filter"),
    notReached("decide"),
  ],
};

export const HYPE_TRACE: ResearchArticleTrace = {
  article: HYPE,
  steps: [
    collect(HYPE, { BTC: "BITCOIN", HYPE: "HYPERLIQUID" }),
    {
      key: "normalize",
      status: "pass",
      at: HYPE.collectedAt,
      ...none,
      detail: {
        candidates: [
          { symbol: "BTC", market: "BTC-USD", kind: "crypto" },
          { symbol: "HYPE", market: "HYPE-USD", kind: "crypto" },
        ],
        duplicateOf: null,
        story: null,
      },
    },
    {
      key: "score",
      status: "drop",
      at: HYPE.collectedAt,
      reason: "notCatalyst",
      mergeReason: null,
      code: "NOT_A_SIGNAL_TYPE",
      detail: {
        sentToClaude: true,
        signalType: false,
        newsType: null,
        side: null,
        maxHoldHours: null,
        asset: null,
        relevance: "passingMention",
        promotional: false,
        eventDate: null,
        error: null,
        level: null,
        laterLevel: null,
        levelSources: null,
        claude: null,
        labelable: false,
        label: null,
      },
    },
    notReached("filter"),
    notReached("decide"),
  ],
};

export const TRACES: Record<string, ResearchArticleTrace> = {
  [ETH.id]: ETH_TRACE,
  [SOL.id]: SOL_TRACE,
  [KNTQ.id]: KNTQ_TRACE,
  [HYPE.id]: HYPE_TRACE,
};

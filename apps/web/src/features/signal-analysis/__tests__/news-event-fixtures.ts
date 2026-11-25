import type {
  ResearchArticle,
  ResearchArticleTrace,
  ResearchTraceCheck,
  ResearchTraceEvent,
  ResearchTraceStep,
} from "@drift/shared";

import { CTX_ETH } from "./context-fixtures";
import { ETH, ETH_TRACE } from "./news-trace-fixtures";

// #530 (news-v6): sự kiện tin nêu nhiều coin, theo docs/mockups/signal-research/news-event-coins.html. Bài đầu 15:35 nêu
// AAVE, LINK, UNI (k = 3, 500 USDC → 166.66 mỗi coin; UNI rớt Filter vì take profit dưới 2× cost, phần không dồn). Bài đăng
// lại 25/11 01:30 nêu COMP trước AAVE: COMP không có story → Same event; AAVE có story khoá → gộp sameStory.

const AAVE_TRADE = "0b1c2d3e-4f50-4a61-8b72-9c8d7e6f5a41";
const LINK_TRADE = "0b1c2d3e-4f50-4a61-8b72-9c8d7e6f5a42";
const AAVE_STORY = "1c2d3e4f-5061-4b72-8c83-ad9e8f7a6b51";

const check = (
  key: ResearchTraceCheck["key"],
  p: Partial<ResearchTraceCheck> = {},
): ResearchTraceCheck => ({
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

const passChecks = (tp: number): ResearchTraceCheck[] => [
  check("sourceLive", { value: 6, limit: 30 }),
  check("priceAvailable", { spreadPct: 0.02 }),
  check("noOpenTrade"),
  check("tpVsCost", { value: tp, limit: 0.2, costPct: 0.1 }),
];

const story = (market: string, isNew: boolean) => ({
  id: AAVE_STORY,
  key: `${market}|listing`,
  market,
  newsType: "listing" as const,
  isNew,
  sources: 1,
  levelAtEntry: "medium" as const,
  laterLevel: "medium" as const,
  outcome: "entered" as const,
  tradeId: AAVE_TRADE,
});

export const EVENT_FIRST: ResearchArticle = {
  ...ETH,
  id: "art-event-first",
  title: "A major broker adds AAVE, LINK and UNI trading",
  url: null,
  source: "ChainCatcher",
  tier: null,
  publishedAt: "2026-11-24T15:35:00.000Z",
  collectedAt: "2026-11-24T15:38:00.000Z",
  delaySecs: 180,
  tagged: ["AAVE", "LINK", "UNI"],
  candidates: ["AAVE-USD", "LINK-USD", "UNI-USD"],
  asset: "AAVE-USD",
  side: "long",
  stage: "decide",
  outcome: "traded",
  tradeId: AAVE_TRADE,
  tradedAssets: ["AAVE-USD", "LINK-USD"],
};

export const EVENT_REPOST: ResearchArticle = {
  ...ETH,
  id: "art-event-repost",
  title: "Major broker adds COMP and AAVE trading",
  url: null,
  source: "Odaily",
  tier: null,
  publishedAt: "2026-11-25T01:30:00.000Z",
  collectedAt: "2026-11-25T01:33:00.000Z",
  delaySecs: 180,
  tagged: ["COMP", "AAVE"],
  candidates: ["COMP-USD", "AAVE-USD"],
  asset: "COMP-USD",
  side: "long",
  stage: "filter",
  outcome: "dropped",
  reason: "sameEvent",
  tradeId: null,
};

const FIRST_EVENT: ResearchTraceEvent = {
  coins: 3,
  firstArticle: null,
  items: [
    {
      market: "AAVE-USD",
      outcome: "traded",
      reason: null,
      mergeReason: null,
      code: null,
      checks: passChecks(1.4),
      storyStartedAt: null,
      story: story("AAVE-USD", true),
      trade: { tradeId: AAVE_TRADE, side: "long", sizeUsdc: "166.66" },
      context: CTX_ETH,
    },
    {
      market: "LINK-USD",
      outcome: "traded",
      reason: null,
      mergeReason: null,
      code: null,
      checks: passChecks(1.2),
      storyStartedAt: null,
      story: story("LINK-USD", true),
      trade: { tradeId: LINK_TRADE, side: "long", sizeUsdc: "166.66" },
      context: CTX_ETH,
    },
    {
      market: "UNI-USD",
      outcome: "dropped",
      reason: "tpUnderCost",
      mergeReason: null,
      code: "MOVE_TOO_SMALL_FOR_COST",
      checks: [
        check("sourceLive", { value: 6, limit: 30 }),
        check("priceAvailable", { spreadPct: 0.05 }),
        check("noOpenTrade"),
        check("tpVsCost", {
          ok: false,
          code: "MOVE_TOO_SMALL_FOR_COST",
          value: 0.15,
          limit: 0.2,
          costPct: 0.1,
        }),
      ],
      storyStartedAt: null,
      story: { ...story("UNI-USD", true), outcome: "skipped", tradeId: null },
      trade: null,
      context: null,
    },
  ],
};

const withStep = (
  steps: readonly ResearchTraceStep[],
  map: (s: ResearchTraceStep) => ResearchTraceStep,
): ResearchTraceStep[] => steps.map(map);

export const EVENT_FIRST_TRACE: ResearchArticleTrace = {
  ...ETH_TRACE,
  article: EVENT_FIRST,
  event: FIRST_EVENT,
  steps: withStep(ETH_TRACE.steps, (s) => {
    if (s.key === "collect")
      return {
        ...s,
        detail: {
          ...s.detail,
          publishedAt: EVENT_FIRST.publishedAt,
          collectedAt: EVENT_FIRST.collectedAt,
          delaySecs: 180,
          source: "ChainCatcher",
          tier: null,
          url: null,
          tagged: EVENT_FIRST.tagged.map((symbol) => ({ symbol, name: null })),
        },
      };
    if (s.key === "normalize")
      return {
        ...s,
        detail: {
          candidates: EVENT_FIRST.candidates.map((market) => ({
            symbol: market.replace("-USD", ""),
            market,
            kind: "crypto" as const,
          })),
          duplicateOf: null,
          story: story("AAVE-USD", true),
        },
      };
    if (s.key === "score" && s.detail !== null)
      return { ...s, detail: { ...s.detail, newsType: "listing", asset: "AAVE-USD" } };
    if (s.key === "decide" && s.detail !== null)
      return { ...s, detail: { ...s.detail, tradeId: AAVE_TRADE, sizeUsdc: "166.66" } };
    return s;
  }),
};

const REPOST_EVENT: ResearchTraceEvent = {
  coins: 3,
  firstArticle: {
    id: EVENT_FIRST.id,
    title: EVENT_FIRST.title,
    excerpt: null,
    publishedAt: EVENT_FIRST.publishedAt,
  },
  items: [
    {
      market: "COMP-USD",
      outcome: "dropped",
      reason: "sameEvent",
      mergeReason: null,
      code: "SAME_EVENT",
      checks: [],
      storyStartedAt: null,
      story: null,
      trade: null,
      context: CTX_ETH,
    },
    {
      market: "AAVE-USD",
      outcome: "merged",
      reason: null,
      mergeReason: "sameStory",
      code: "SAME_STORY",
      checks: [],
      storyStartedAt: null,
      story: story("AAVE-USD", false),
      trade: null,
      context: CTX_ETH,
    },
  ],
};

export const EVENT_REPOST_TRACE: ResearchArticleTrace = {
  ...ETH_TRACE,
  article: EVENT_REPOST,
  event: REPOST_EVENT,
  latency: { ...ETH_TRACE.latency, decision: "noTrade", openedAt: null },
  steps: withStep(ETH_TRACE.steps, (s) => {
    if (s.key === "normalize")
      return {
        ...s,
        detail: {
          candidates: EVENT_REPOST.candidates.map((market) => ({
            symbol: market.replace("-USD", ""),
            market,
            kind: "crypto" as const,
          })),
          duplicateOf: null,
          story: story("AAVE-USD", false),
        },
      };
    if (s.key === "score" && s.detail !== null)
      return { ...s, detail: { ...s.detail, newsType: "listing", asset: "COMP-USD" } };
    if (s.key === "filter")
      return {
        ...s,
        status: "drop",
        reason: "sameEvent",
        code: "SAME_EVENT",
        detail: {
          level: null,
          checks: [],
          laterLevel: null,
          reasonLimit: null,
          shadowTradeId: null,
          opposite: null,
          storyStartedAt: null,
        },
      };
    if (s.key === "decide")
      return {
        key: "decide",
        status: "notReached",
        at: null,
        reason: null,
        mergeReason: null,
        code: null,
        detail: null,
      };
    return s;
  }),
};

/** Bài đăng lại một coin, cùng ngày với bài đầu: "First article … (15:35)" không có ngày. */
export const SAME_DAY_REPOST_TRACE: ResearchArticleTrace = {
  ...EVENT_REPOST_TRACE,
  article: {
    ...EVENT_REPOST,
    id: "art-event-sameday",
    publishedAt: "2026-11-24T20:24:00.000Z",
    collectedAt: "2026-11-24T20:27:00.000Z",
    tagged: ["COMP"],
    candidates: ["COMP-USD"],
  },
  event: { ...REPOST_EVENT, items: REPOST_EVENT.items.slice(0, 1) },
};

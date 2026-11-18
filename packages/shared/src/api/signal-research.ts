import { z } from "zod";

import { isoDateTimeSchema } from "../schemas";

// Hợp đồng API của Signal research (#271; UI #273). Endpoint team (role team, chỉ đọc, transaction READ ONLY):
//   GET /api/v1/admin/signal-research/summary?tz=
//   GET /api/v1/admin/signal-research/trades?type=&label=&asset=&show=&cursor=&limit=&tz=
//   GET /api/v1/admin/signal-research/trades/:id?tz=
// CLI `signals:report` của scheduler in cùng dữ liệu. Tên export giữ đúng như bản sao tạm của web (#273) để web chỉ đổi
// import. Quy ước: phần trăm là số theo đơn vị % (0.21 = +0.21%); tiền / giá là chuỗi thập phân; thời điểm là ISO UTC.
// Giá trị không biết là null (web hiện "Not available" / "Not enough trades", không bao giờ 0, quy tắc 1.8). API không
// trả câu chữ tiếng Anh: mọi bước / lý do là khoá cố định, web dịch.
// Hiện chỉ lane News (live paper) có dữ liệu; Whales / Funding / Price (replay, #274) để trống tới khi được ghi vào.

export const RESEARCH_TYPES = ["news", "whales", "funding", "price"] as const;
export const RESEARCH_LABELS = ["live", "replay"] as const;
export const RESEARCH_SOURCE_STATUSES = ["live", "delayed", "down"] as const;
export const RESEARCH_LEVELS = ["high", "medium", "low"] as const;
export const RESEARCH_STATUSES = ["collecting", "failing", "passing"] as const;
export const RESEARCH_SHOWS = ["entered", "skipped", "all"] as const;
export const RESEARCH_SOURCES = [
  "sosoNews",
  "macroCalendar",
  "sodexPrices",
  "whaleEvents",
  "fundingRates",
  "candles",
] as const;
export const RESEARCH_DROP_REASONS = [
  "notCatalyst",
  "notOnSodex",
  "promotional",
  "notUnderstood",
  "eventTooOld",
  "tpUnderCost",
  "alreadyOpen",
  "sourceLate",
  "noPrice",
  "tooThin",
  "riskWindow",
] as const;
export const RESEARCH_NEWS_TYPES = [
  "hack",
  "listing",
  "delisting",
  "etfApproved",
  "etfDelayed",
  "regulatorAgainst",
  "regulatorFavour",
  "treasuryBuy",
  "treasurySell",
  "earningsBeat",
  "earningsMiss",
  "unlock",
] as const;

const iso = isoDateTimeSchema;
const dec = z.string().regex(/^-?\d+(\.\d+)?$/);
const int = z.number().int().nonnegative();
const type = z.enum(RESEARCH_TYPES);
const label = z.enum(RESEARCH_LABELS);
const side = z.enum(["long", "short"]);
const level = z.enum(RESEARCH_LEVELS);
const status = z.enum(RESEARCH_STATUSES);
const sourceStatus = z.enum(RESEARCH_SOURCE_STATUSES);

export const researchSourceSchema = z.object({
  key: z.enum(RESEARCH_SOURCES),
  mode: label,
  status: sourceStatus,
  /** live: lần cuối nhận được dữ liệu (null = không hiện "… ago"); replay: lần chạy lại gần nhất. */
  lastAt: iso.nullable(),
  /** Khoảng mất dữ liệu bị loại khỏi thống kê. */
  gap: z.object({ from: iso, to: iso }).nullable(),
});

export const researchPaperBotSchema = z.object({
  type,
  mode: label,
  state: z.enum(["running", "paused"]),
  balance: dec.nullable(),
  openTrades: int.nullable(),
  rulesVersion: int.nullable(),
  lastRun: z.object({ at: iso, trades: int }).nullable(),
});

const dropSchema = z.object({
  n: int,
  reasons: z.array(z.object({ reason: z.enum(RESEARCH_DROP_REASONS), n: int })),
});

export const researchFunnelSchema = z.object({
  days: int,
  delayMedianSecs: int.nullable(),
  pollSecs: int,
  claudeCostPerDay: dec.nullable(),
  articlesRead: int.nullable(),
  soso: z.object({ used: int, limit: int }).nullable(),
  collected: int,
  stories: int,
  /** Bài gộp vào một story đã có (không phải bị loại). */
  merged: int,
  signals: int,
  levels: z.object({ high: int, medium: int, low: int }),
  passed: int,
  long: int,
  short: int,
  sizeUsdc: dec,
  drops: z.object({ score: dropSchema, filter: dropSchema }),
  outcomes: z.object({ closed: int, tp: int, sl: int, maxHold: int, open: int }),
});

export const researchLevelRowSchema = z.object({
  level,
  signals: int,
  trades: int,
  closed: int,
  long: int,
  short: int,
  /** Số story sau đó lên High (null cho chính mức High). */
  laterHigh: int.nullable(),
  avgPct: z.number().nullable(),
  randomPct: z.number().nullable(),
  diffPct: z.number().nullable(),
  status,
  needMore: int.nullable(),
});

export const researchNeedsSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("pooled"), more: int, weeks: int.nullable() }),
  z.object({ kind: z.literal("rangeBelowZero"), needed: int }),
  z.object({ kind: z.literal("moreTrades"), more: int, fundingDays: int.nullable() }),
  z.object({ kind: z.literal("losesAfterFees") }),
  z.object({ kind: z.literal("passed") }),
]);

export const researchSummaryRowSchema = z.object({
  type,
  label,
  rulesVersion: int,
  closed: int,
  opened: int.nullable(),
  avgPct: z.number().nullable(),
  randomPct: z.number().nullable(),
  diffPct: z.number().nullable(),
  /** Khoảng 95% của kết quả sau phí: block bootstrap theo ngày vào lệnh (UTC), như DEC-321; < 2 ngày → null. */
  range: z.object({ lo: z.number(), hi: z.number() }).nullable(),
  /** Số cụm (ngày UTC có lệnh đóng) dùng cho khoảng tin cậy. */
  clusters: int,
  status,
  needs: researchNeedsSchema,
});

/** Tách theo chiều (#269 v3.4 điểm 5): một tuần thị trường tăng không được trông như có edge. */
export const researchDirectionRowSchema = z.object({
  side,
  closed: int,
  avgPct: z.number().nullable(),
  randomPct: z.number().nullable(),
  diffPct: z.number().nullable(),
  range: z.object({ lo: z.number(), hi: z.number() }).nullable(),
  clusters: int,
});

export const researchRiskSchema = z.object({
  windows: int,
  days: int,
  costChangePct: z.number().nullable(),
  volumeChangePct: z.number().nullable(),
  next: z.object({ event: z.string().min(1), from: iso, to: iso }).nullable(),
});

export const researchSummarySchema = z.object({
  computedAt: iso,
  sources: z.array(researchSourceSchema),
  bots: z.array(researchPaperBotSchema),
  funnel: researchFunnelSchema.nullable(),
  newsRulesVersion: int.nullable(),
  levels: z.array(researchLevelRowSchema),
  /** Chi phí khứ hồi một lệnh, % (taker + builder hai chiều + spread). */
  costPct: z.number().nullable(),
  rows: z.array(researchSummaryRowSchema),
  /** Long / Short của lane News · live (kết quả sau phí, ngẫu nhiên, chênh lệch, khoảng 95%). */
  directions: z.array(researchDirectionRowSchema),
  risk: researchRiskSchema.nullable(),
  assets: z.array(z.string()),
});

export const researchWhatSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("news"),
    headline: z.string(),
    newsType: z.enum(RESEARCH_NEWS_TYPES),
    levelAtEntry: level.nullable(),
    sources: int.nullable(),
    topTier: int.nullable(),
    later: z.object({ level, sources: int }).nullable(),
  }),
  z.object({
    type: z.literal("whales"),
    walletTail: z.string().regex(/^[0-9a-f]{8}$/),
    sizeUsd: dec,
    inLeaderboardSince: iso.nullable(),
    sizeVsUsual: z.number().nullable(),
  }),
  z.object({
    type: z.literal("funding"),
    ratePct: z.number(),
    perHours: int,
    topPct: z.number(),
    days: int,
  }),
  z.object({
    type: z.literal("price"),
    direction: z.enum(["up", "down"]),
    rangeMins: int,
    volumeVsUsual: z.number(),
  }),
]);

export const researchSkipSchema = z.object({
  reason: z.enum(RESEARCH_DROP_REASONS),
  tpPct: z.number().nullable(),
  neededPct: z.number().nullable(),
});

export const researchTradeSchema = z.object({
  id: z.string().min(1),
  type,
  label,
  asset: z.string(),
  side,
  seenAt: iso,
  delayKind: z.enum(["afterRelease", "afterFill", "atCandleClose", "atFundingTime"]),
  delaySecs: int.nullable(),
  what: researchWhatSchema,
  skipped: researchSkipSchema.nullable(),
  movedBeforePct: z.number().nullable(),
  entry: dec.nullable(),
  tp: dec.nullable(),
  tpPct: z.number().nullable(),
  sl: dec.nullable(),
  slPct: z.number().nullable(),
  maxHoldHours: int.nullable(),
  /** null khi tín hiệu bị bỏ qua. */
  result: z
    .object({
      pnl: dec.nullable(),
      outcome: z.enum(["tp", "sl", "maxHold", "open"]),
      leftSecs: int.nullable(),
    })
    .nullable(),
});

export const researchTradesPageSchema = z.object({
  items: z.array(researchTradeSchema),
  nextCursor: z.string().nullable(),
});

export const RESEARCH_FACTS = [
  "whaleFill",
  "seen",
  "published",
  "collected",
  "source",
  "sourceHealth",
  "action",
  "whaleSize",
  "market",
  "walletQuality",
  "newsType",
  "direction",
  "eventDate",
  "levelAtEntry",
  "laterLevel",
  "fundingRate",
  "entry",
  "size",
  "tp",
  "sl",
  "maxHold",
  "exit",
  /** Bước result: giá đã chạy từ lúc vào tới lúc ra theo chiều lệnh (`pct`) và kết quả tiền trước phí (`usd`). */
  "priceMove",
  /** Bước trade: giá đã chạy từ giờ đăng tin tới lúc vào lệnh (`pct`, có dấu theo giá, không theo chiều lệnh). */
  "movedBeforeEntry",
  "fees",
  "best",
  "worst",
  "random",
  "whaleFillPrice",
] as const;
export const RESEARCH_CHECKS = [
  "sourceLive",
  "newStory",
  "priceAvailable",
  "noOpenTrade",
  "tpVsCost",
  "riskWindow",
  "maxOpen",
] as const;

/**
 * Một ô "nhãn / giá trị" của một bước; chỉ các trường mà nhãn đó cần. Quy ước: `fees.usd` là chi phí DƯƠNG (phí vào + ra);
 * web tự hiện dấu trừ. `best` / `worst` (MFE / MAE, % theo chiều lệnh, `best` ≥ 0, `worst` ≤ 0) luôn có mặt ở bước result,
 * `pct` null khi chưa đo được. `source.text` là tên nguồn; `eventDate.text` là YYYY-MM-DD hoặc null.
 */
export const researchFactSchema = z.object({
  key: z.enum(RESEARCH_FACTS),
  at: iso.nullish(),
  secs: int.nullish(),
  price: dec.nullish(),
  pct: z.number().nullish(),
  usd: dec.nullish(),
  n: int.nullish(),
  x: z.number().nullish(),
  text: z.string().nullish(),
  status: sourceStatus.nullish(),
  side: side.nullish(),
  outcome: z.enum(["tp", "sl", "maxHold"]).nullish(),
  level: level.nullish(),
  source: z.enum(RESEARCH_SOURCES).nullish(),
  newsType: z.enum(RESEARCH_NEWS_TYPES).nullish(),
  hours: int.nullish(),
});

export const researchStepSchema = z.object({
  key: z.enum(["received", "understood", "scored", "checks", "trade", "result"]),
  score: z.number().nullable(),
  level: level.nullable(),
  facts: z.array(researchFactSchema),
  parts: z.array(
    z.object({
      key: z.enum(["sizeVsUsual", "walletQuality", "sameWay"]),
      weight: int,
      value: z.number(),
    }),
  ),
  checks: z.array(
    z.object({
      key: z.enum(RESEARCH_CHECKS),
      ok: z.boolean(),
      pct: z.number().nullish(),
      cost: z.number().nullish(),
      n: int.nullish(),
    }),
  ),
  notes: z.array(
    z.discriminatedUnion("key", [
      z.object({ key: z.literal("leaderboard"), since: iso }),
      z.object({ key: z.literal("weights"), version: int }),
    ]),
  ),
});

export const researchTradeDetailSchema = z.object({
  trade: researchTradeSchema,
  rulesVersion: int,
  sizeUsdc: dec.nullable(),
  heldSecs: int.nullable(),
  steps: z.array(researchStepSchema),
});

export type ResearchType = (typeof RESEARCH_TYPES)[number];
export type ResearchLabel = (typeof RESEARCH_LABELS)[number];
export type ResearchShow = (typeof RESEARCH_SHOWS)[number];
export type ResearchSource = z.infer<typeof researchSourceSchema>;
export type ResearchPaperBot = z.infer<typeof researchPaperBotSchema>;
export type ResearchFunnel = z.infer<typeof researchFunnelSchema>;
export type ResearchLevelRow = z.infer<typeof researchLevelRowSchema>;
export type ResearchSummaryRow = z.infer<typeof researchSummaryRowSchema>;
export type ResearchDirectionRow = z.infer<typeof researchDirectionRowSchema>;
export type ResearchNeeds = z.infer<typeof researchNeedsSchema>;
export type ResearchRisk = z.infer<typeof researchRiskSchema>;
export type ResearchSummary = z.infer<typeof researchSummarySchema>;
export type ResearchTrade = z.infer<typeof researchTradeSchema>;
export type ResearchTradesPage = z.infer<typeof researchTradesPageSchema>;
export type ResearchFact = z.infer<typeof researchFactSchema>;
export type ResearchStep = z.infer<typeof researchStepSchema>;
export type ResearchTradeDetail = z.infer<typeof researchTradeDetailSchema>;

/** Query của danh sách lệnh / tín hiệu. `tz` chỉ để web dùng chung key cache (API trả giờ UTC). */
export const researchTradesQuerySchema = z.object({
  type: z.enum(RESEARCH_TYPES).optional(),
  label: z.enum(RESEARCH_LABELS).optional(),
  asset: z.string().min(1).max(40).optional(),
  show: z.enum(RESEARCH_SHOWS).default("entered"),
  cursor: z.string().max(300).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  tz: z.string().max(64).optional(),
});
export type ResearchTradesQuery = z.infer<typeof researchTradesQuerySchema>;

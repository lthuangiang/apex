import { z } from "zod";

import { isoDateTimeSchema } from "../schemas";

// Hợp đồng API của Signal research (#271; UI #273). Endpoint team (role team, chỉ đọc, transaction READ ONLY):
//   GET /api/v1/admin/signal-research/summary?range=&tz=
//   GET /api/v1/admin/signal-research/trades?type=&label=&asset=&show=&cursor=&limit=&tz=
//   GET /api/v1/admin/signal-research/trades/:id?tz=
//   GET /api/v1/admin/signal-research/articles?range=&show=&stage=&reason=&cursor=&limit=&tz=   (#291)
//   GET /api/v1/admin/signal-research/articles/:id/trace?tz=                                   (#291)
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
  /** #291: SoSoValue không gắn coin nào (mã nội bộ `NO_SODEX_MARKET` với `matched_currencies` rỗng); dừng ở Collect. */
  "noTaggedCurrency",
  /** #291: trùng nội dung y hệt một bài đã lưu (`DUPLICATE`); dừng ở Normalize. */
  "duplicate",
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
  /**
   * #291: số BÀI (không phải event) theo bước dừng + kết quả + lý do, cùng cách tính với feed `/articles` (bấm một lý do
   * thì feed ra đúng chừng ấy bài). Có `range` thì chỉ bài thu trong khoảng đó; không có thì mọi bài của version hiện tại.
   * Không có bài backlog (xem `researchArticleSchema`).
   */
  articleStops: z.array(
    z.object({
      stage: z.enum(["collect", "normalize", "score", "filter", "decide"]),
      outcome: z.enum(["traded", "dropped", "merged", "waiting"]),
      reason: z.enum(RESEARCH_DROP_REASONS).nullable(),
      mergeReason: z.enum(["sameStory", "storyTooOld"]).nullable(),
      n: int,
    }),
  ),
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
  /**
   * #291: bài để mở trace (`/articles/:id/trace`): lệnh → bài đã mở lệnh (bài đầu của lần thử đó); tín hiệu bị bỏ → bài
   * bị bỏ ở Filter. null với replay / dòng thiếu bài.
   */
  articleId: z.string().nullable(),
  type,
  label,
  asset: z.string(),
  side,
  seenAt: iso,
  delayKind: z.enum(["afterRelease", "afterFill", "atCandleClose", "atFundingTime"]),
  /** News: từ giờ đăng bài ĐẦU TIÊN của câu chuyện tới lúc DeskLabs thấy bài làm vào lệnh (lần thử lại thì dài hơn). */
  delaySecs: int.nullable(),
  /**
   * Vào lệnh ở lần thử lại của câu chuyện (bài đầu bị bỏ vì lý do tạm thời, thử lại trong 2 giờ); giá đã chạy trước khi
   * vào lệnh đo từ bài đầu. Luôn false với tín hiệu bị bỏ và với replay.
   */
  retry: z.boolean(),
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

// ── Feed bài và trace từng bài (#291, thiết kế docs/mockups/signal-research/news-trace.html) ─────────────────────────

export const RESEARCH_RANGES = ["1d", "7d"] as const;
/** Năm bước của phễu; `score` = bước `understand` nội bộ (Claude + quy tắc). */
export const RESEARCH_STAGES = ["collect", "normalize", "score", "filter", "decide"] as const;
export const RESEARCH_ARTICLE_SHOWS = ["all", "traded", "dropped", "claude"] as const;
/**
 * `traded` = bài đã mở lệnh giấy; `dropped` = bị loại (có `reason`); `merged` = gộp vào câu chuyện đã có ở Filter
 * (`mergeReason`), không phải bị loại; `waiting` = còn trong phễu (chờ Normalize / Claude).
 */
export const RESEARCH_ARTICLE_OUTCOMES = ["traded", "dropped", "merged", "waiting"] as const;
export const RESEARCH_MERGE_REASONS = ["sameStory", "storyTooOld"] as const;
export const RESEARCH_SOURCE_TIERS = ["top", "mid", "low"] as const;
export const RESEARCH_STEP_STATUSES = ["pass", "drop", "merge", "notReached"] as const;
export const RESEARCH_TRACE_CHECKS = [
  "sourceLive",
  "priceAvailable",
  "noOpenTrade",
  "tpVsCost",
] as const;

const tier = z.enum(RESEARCH_SOURCE_TIERS);
const stage = z.enum(RESEARCH_STAGES);

/** Usage Claude của MỘT bài (DEC-326). null ở trên = bài không qua Claude hoặc bài cũ trước khi lưu usage. */
export const researchClaudeUsageSchema = z.object({
  calls: int,
  /** null khi có lần gọi không nhận được phản hồi (không biết token). */
  tokens: z.object({ input: int, cacheWrite: int, cacheRead: int, output: int }).nullable(),
  /** USD, chuỗi thập phân không làm tròn; null khi thiếu token hoặc model không có trong bảng giá. */
  costUsd: dec.nullable(),
  model: z.string().nullable(),
  promptVersion: z.string().nullable(),
});

/**
 * Một bài trong feed. Chỉ bài của version quy tắc hiện tại, KHÔNG có bài backlog (lưu thô, cũ hơn mốc dưới của Collect,
 * không bao giờ vào phễu; tổng kết đếm riêng). `stage` = bước cuối bài tới được; bài bị loại thì là bước loại nó.
 */
export const researchArticleSchema = z.object({
  id: z.string().min(1),
  /** Tin flash không có tiêu đề: null, web hiện `excerpt`. */
  title: z.string().nullable(),
  /** ≤ 140 ký tự đầu của nội dung (đã bỏ HTML); null khi không có nội dung. */
  excerpt: z.string().nullable(),
  url: z.string().nullable(),
  /** Tên nguồn (tác giả SoSoValue). */
  source: z.string(),
  /** Hạng nguồn theo bảng của version quy tắc hiện tại (`sourceTierOf`); null khi không xác định. */
  tier: tier.nullable(),
  publishedAt: iso,
  collectedAt: iso,
  /** Từ giờ đăng tới lúc DeskLabs thu bài. */
  delaySecs: int,
  /** Coin SoSoValue gắn cho bài (symbol), theo thứ tự SoSoValue. */
  tagged: z.array(z.string()),
  /** Market SoDEX ứng viên sau Normalize (rỗng khi chưa tới / không có). */
  candidates: z.array(z.string()),
  /** Market Claude chọn ở Score; null khi chưa phân loại hoặc không chọn. */
  asset: z.string().nullable(),
  /** Chiều theo loại tin, đã lưu khi bài qua Score; null khi không có. */
  side: side.nullable(),
  stage,
  outcome: z.enum(RESEARCH_ARTICLE_OUTCOMES),
  /** Chỉ khi `outcome = dropped`. */
  reason: z.enum(RESEARCH_DROP_REASONS).nullable(),
  /** Chỉ khi `outcome = merged`. */
  mergeReason: z.enum(RESEARCH_MERGE_REASONS).nullable(),
  /** Bài đã được gửi cho Claude (kể cả bài cũ chưa có usage). */
  sentToClaude: z.boolean(),
  claude: researchClaudeUsageSchema.nullable(),
  /** Lệnh giấy bài này đã mở. */
  tradeId: z.uuid().nullable(),
});

export const researchArticlesPageSchema = z.object({
  items: z.array(researchArticleSchema),
  nextCursor: z.string().nullable(),
  /** Số bài khớp bộ lọc (N trong "N of M articles"). */
  total: int,
  /** Mọi bài trong khoảng thời gian, không lọc (M). */
  totalInRange: int,
});

export const researchArticlesQuerySchema = z.object({
  range: z.enum(RESEARCH_RANGES).default("1d"),
  show: z.enum(RESEARCH_ARTICLE_SHOWS).default("all"),
  stage: stage.optional(),
  reason: z.enum(RESEARCH_DROP_REASONS).optional(),
  cursor: z.string().max(400).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  tz: z.string().max(64).optional(),
});

export const researchSummaryQuerySchema = z.object({
  /** Không có = như trước (#271): phễu tính mọi dữ liệu của version hiện tại. */
  range: z.enum(RESEARCH_RANGES).optional(),
  tz: z.string().max(64).optional(),
});

const sourceRef = z.object({ name: z.string(), tier });
const pct = z.number().nullable();

/** Câu chuyện của bài (tạo / gộp ở bước Filter; web hiện ở thẻ Normalize như thiết kế). */
export const researchTraceStorySchema = z.object({
  id: z.uuid(),
  /** `MARKET|catalyst` nội bộ. */
  key: z.string(),
  market: z.string(),
  newsType: z.enum(RESEARCH_NEWS_TYPES),
  /** true = bài này mở dòng câu chuyện; false = gộp vào câu chuyện đã có. */
  isNew: z.boolean(),
  /** Số nguồn khác nhau của câu chuyện HIỆN TẠI (có thể gồm bài tới sau). */
  sources: int,
  levelAtEntry: level,
  laterLevel: level,
  outcome: z.enum(["entered", "skipped"]),
  tradeId: z.uuid().nullable(),
});

export const researchTraceCheckSchema = z.object({
  key: z.enum(RESEARCH_TRACE_CHECKS),
  ok: z.boolean(),
  /** Mã nội bộ của lần kiểm hỏng (`NO_BOOK_DATA`…); null khi qua. */
  code: z.string().nullable(),
  /** sourceLive: phút trễ; tpVsCost: TP %. null khi không lưu. */
  value: pct,
  /** sourceLive: trần phút; tpVsCost: TP tối thiểu % (= chi phí × bội số). */
  limit: pct,
  costPct: pct,
  spreadPct: pct,
  /** noOpenTrade hỏng: lệnh đang mở. */
  openTradeId: z.uuid().nullable(),
});

const stepBase = {
  status: z.enum(RESEARCH_STEP_STATUSES),
  /** Lúc ghi event của bước; null khi chưa tới. */
  at: iso.nullable(),
  reason: z.enum(RESEARCH_DROP_REASONS).nullable(),
  mergeReason: z.enum(RESEARCH_MERGE_REASONS).nullable(),
  /** Mã nội bộ đã lưu (`NOT_A_SIGNAL_TYPE`…), web hiện nguyên văn như thiết kế. */
  code: z.string().nullable(),
};

export const researchTraceStepSchema = z.discriminatedUnion("key", [
  z.object({
    key: z.literal("collect"),
    ...stepBase,
    detail: z.object({
      publishedAt: iso,
      collectedAt: iso,
      delaySecs: int,
      source: z.string(),
      tier: tier.nullable(),
      url: z.string().nullable(),
      tagged: z.array(z.object({ symbol: z.string(), name: z.string().nullable() })),
    }),
  }),
  z.object({
    key: z.literal("normalize"),
    ...stepBase,
    detail: z
      .object({
        candidates: z.array(
          z.object({ symbol: z.string(), market: z.string(), kind: z.enum(["crypto", "stock"]) }),
        ),
        duplicateOf: z
          .object({
            id: z.string(),
            title: z.string().nullable(),
            excerpt: z.string().nullable(),
            publishedAt: iso,
          })
          .nullable(),
        story: researchTraceStorySchema.nullable(),
      })
      .nullable(),
  }),
  z.object({
    key: z.literal("score"),
    ...stepBase,
    detail: z
      .object({
        sentToClaude: z.boolean(),
        /** false = Claude trả "none" (không phải loại tin trong danh sách); null = chưa phân loại. */
        signalType: z.boolean().nullable(),
        newsType: z.enum(RESEARCH_NEWS_TYPES).nullable(),
        /** Chiều và giữ tối đa theo loại tin (quy tắc, không phải Claude). */
        side: side.nullable(),
        maxHoldHours: int.nullable(),
        asset: z.string().nullable(),
        relevance: z.enum(["direct", "passingMention"]).nullable(),
        promotional: z.boolean().nullable(),
        /** YYYY-MM-DD do Claude đọc ra. */
        eventDate: z.string().nullable(),
        /** Mã lỗi khi Claude không trả lời được ("Not understood"). */
        error: z.string().nullable(),
        /** Mức lúc quyết định (tính ở Filter); null khi bài không tới Filter hoặc bị gộp. */
        level: level.nullable(),
        laterLevel: level.nullable(),
        /** Nguồn dùng để tính mức: lệnh → nguồn lúc vào; còn lại → nguồn HIỆN TẠI của câu chuyện; null khi không có. */
        levelSources: z.array(sourceRef).nullable(),
        claude: researchClaudeUsageSchema.nullable(),
      })
      .nullable(),
  }),
  z.object({
    key: z.literal("filter"),
    ...stepBase,
    detail: z
      .object({
        level: level.nullable(),
        /** Theo thứ tự pipeline; dừng ở lần kiểm hỏng đầu tiên. Rỗng khi bài bị gộp. */
        checks: z.array(researchTraceCheckSchema),
        /** Gộp: mức câu chuyện sau khi thêm bài này. */
        laterLevel: level.nullable(),
        /** Gộp `storyTooOld`: giờ bài đầu tiên được tính của câu chuyện. */
        storyStartedAt: iso.nullable(),
      })
      .nullable(),
  }),
  z.object({
    key: z.literal("decide"),
    ...stepBase,
    detail: z
      .object({
        tradeId: z.uuid(),
        side,
        sizeUsdc: dec,
        entry: dec,
        openedAt: iso,
        tp: dec,
        tpPct: pct,
        sl: dec,
        slPct: pct,
        maxHoldHours: int,
        maxHoldUntil: iso,
        priceSource: z.enum(["book", "lastSpread"]).nullable(),
        /** Lần thử lại của câu chuyện (bài đầu bị bỏ vì lý do tạm thời). */
        retry: z.boolean(),
        movedBeforePct: pct,
        status: z.enum(["open", "closed"]),
        /** Lệnh ngẫu nhiên cùng thời điểm / TP / SL / giữ; null tới khi tính xong (sau cửa sổ giữ). */
        random: z.object({ longPct: pct, shortPct: pct, pct, longShare: pct }).nullable(),
      })
      .nullable(),
  }),
]);

export const researchArticleTraceSchema = z.object({
  article: researchArticleSchema,
  /** Luôn đủ 5 bước theo thứ tự collect → decide. */
  steps: z.array(researchTraceStepSchema).length(5),
});

export type ResearchRange = (typeof RESEARCH_RANGES)[number];
export type ResearchStage = (typeof RESEARCH_STAGES)[number];
export type ResearchDropReason = (typeof RESEARCH_DROP_REASONS)[number];
export type ResearchNewsType = (typeof RESEARCH_NEWS_TYPES)[number];
export type ResearchClaudeUsage = z.infer<typeof researchClaudeUsageSchema>;
export type ResearchArticle = z.infer<typeof researchArticleSchema>;
export type ResearchArticlesPage = z.infer<typeof researchArticlesPageSchema>;
export type ResearchArticlesQuery = z.infer<typeof researchArticlesQuerySchema>;
export type ResearchSummaryQuery = z.infer<typeof researchSummaryQuerySchema>;
export type ResearchTraceStory = z.infer<typeof researchTraceStorySchema>;
export type ResearchTraceCheck = z.infer<typeof researchTraceCheckSchema>;
export type ResearchTraceStep = z.infer<typeof researchTraceStepSchema>;
export type ResearchArticleTrace = z.infer<typeof researchArticleTraceSchema>;

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

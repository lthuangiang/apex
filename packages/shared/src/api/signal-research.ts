import { z } from "zod";

import { isoDateTimeSchema } from "../schemas";
import {
  CONTEXT_COMPARE_STATUSES,
  CONTEXT_SOURCES,
  FUNDING_PAYERS,
  H1_STATUSES,
  H2_STATUSES,
  H3_STATUSES,
  RANGE_BREAKOUTS,
} from "../signal-research/context";
import { EXPERIMENT_VERDICTS, hypothesisSchema } from "../signal-research/experiments";
import {
  CLASSIFICATION_LABEL_SOURCES,
  CLASSIFICATION_VERDICTS,
  CLASSIFICATION_WRONG_REASONS,
  CLASSIFIER_GATE_STATUSES,
  ClassificationVerdict,
  LABEL_NOTE_MAX,
} from "../signal-research/labels";
import { BTC_TRENDS, VOLATILITY_STATES } from "../signal-research/market-state";
import { SIGNAL_CATALYSTS, type SignalCatalyst } from "../signal-research/rules";
import {
  AssetMode,
  botVersionConfigSchema,
  OppositeNewsPolicy,
  SIGNAL_BOT_VERSION_STATUSES,
  VERSION_GATE_STATUSES,
} from "../signal-research/versions";

// Hợp đồng API của Signal research (#271; UI #273). Endpoint team (role team, chỉ đọc, transaction READ ONLY):
//   GET /api/v1/admin/signal-research/summary?range=&tz=
//   GET /api/v1/admin/signal-research/trades?type=&label=&asset=&show=&cursor=&limit=&tz=
//   GET /api/v1/admin/signal-research/trades/:id?tz=
//   GET /api/v1/admin/signal-research/articles?range=&show=&stage=&reason=&cursor=&limit=&tz=   (#291)
//   GET /api/v1/admin/signal-research/articles/:id/trace?tz=                                   (#291)
//   GET /api/v1/admin/signal-research/labels/next                                              (#304)
//   PUT /api/v1/admin/signal-research/articles/:id/label   (Idempotency-Key)                   (#304)
//   GET /api/v1/admin/signal-research/classifiers                                              (#304)
//   GET /api/v1/admin/signal-research/versions                                                 (#305)
//   POST /api/v1/admin/signal-research/versions             (Idempotency-Key)                  (#305)
//   POST /api/v1/admin/signal-research/versions/:id/status  (Idempotency-Key)                  (#305)
//   GET /api/v1/admin/signal-research/markets                                                  (#305)
// #305: summary / trades / articles / articles/:id/trace nhận `versionId` (News bot version; không có = Baseline, gồm cả
// dòng trước khi có version). versionId không tồn tại → 404.
// CLI `signals:report` của scheduler in cùng dữ liệu. Tên export giữ đúng như bản sao tạm của web (#273) để web chỉ đổi
// import. Quy ước: phần trăm là số theo đơn vị % (0.21 = +0.21%); tiền / giá là chuỗi thập phân; thời điểm là ISO UTC.
// Giá trị không biết là null (web hiện "Not available" / "Not enough trades", không bao giờ 0, quy tắc 1.8). API không
// trả câu chữ tiếng Anh: mọi bước / lý do là khoá cố định, web dịch.
// Hiện chỉ lane News (live paper) có dữ liệu; Whales / Funding / Price (replay, #274) để trống tới khi được ghi vào.
// #329 (Signal context): bước 4 · Context giữa Score và Filter. Trace có `context` (thẻ bước 4, giá trị đã lưu lúc quyết
// định), mỗi bài trong feed có `context` (cờ gọn H1 / H2 / H3), tổng kết có `context` (so có / không theo từng giả thuyết,
// độ phủ). `steps` của trace giữ 5 bước (collect → decide) để web cũ không vỡ; web mới chèn thẻ Context sau Score.

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
  /** #297: Claude (bước Score), từ `signal_source_health` `claude`. */
  "claude",
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
  /** #298 (news-v3): tài sản Claude chọn không có trong tiêu đề / nội dung bài (`ASSET_NOT_IN_TEXT`). */
  "assetNotInText",
  /** #298 (news-v3): tin treasury trên BTC / ETH không giao dịch (`TREASURY_MAJOR_ASSET`). */
  "treasuryMajorAsset",
  /** #303 (DEC-331), riêng từng News bot version: loại tin bị tắt trong version (`NEWS_TYPE_OFF`). */
  "newsTypeOff",
  /** Tài sản không thuộc danh sách / loại tài sản của version (`ASSET_NOT_IN_VERSION`). */
  "assetNotInVersion",
  /** Level của câu chuyện dưới mức tối thiểu của version (`LEVEL_TOO_LOW`). */
  "levelTooLow",
  /** Bị chặn bởi Max open trades (`LIMIT_OPEN`): không vào lệnh, chỉ theo dõi giả định (shadow). */
  "limitOpen",
  /** Bị chặn bởi Max new trades per day, ngày UTC (`LIMIT_DAY`): shadow. */
  "limitDay",
  /** Không đủ số dư giả (`NO_BALANCE`): shadow. */
  "noBalance",
  /** Tin ngược chiều trên lệnh đang mở của version (`OPPOSITE_NEWS`): không mở lệnh mới, không đảo chiều. */
  "oppositeNews",
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
  /**
   * #297: số dư = 10 000 USDC (`RESEARCH_BOT_START_USDC`) + `realized` (tổng `result_usdc` của lệnh ĐÃ ĐÓNG, sau phí).
   * null khi bot chưa có dữ liệu (lane replay).
   */
  balance: dec.nullable(),
  realized: dec.nullable(),
  /**
   * Lãi / lỗ chưa chốt của mọi lệnh đang mở, theo giá SoDEX gần nhất (`unrealizedUsdc`). null khi không có lệnh mở hoặc
   * thiếu giá của ít nhất một lệnh (không cộng một phần).
   */
  unrealized: dec.nullable(),
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
  /**
   * #343: chi phí Claude trong ĐÚNG cửa sổ của phễu (1d = 24 giờ, 7d = 7 ngày, tính theo `collected_at` như
   * `articlesRead`), cộng từ chi phí đã lưu của từng bài (DEC-326), cùng tập bài với `articlesRead`. `articles` = số bài
   * trong cửa sổ đã gọi Claude; `unknown` = trong số đó, bài không biết chi phí (bài trước khi lưu usage, lần gọi không
   * có phản hồi, model không có bảng giá): `usd` chỉ cộng bài biết chi phí. Không bài nào gọi Claude → `usd` = "0" (số
   * thật). null khi cửa sổ không có bài nào.
   */
  claudeCost: z.object({ usd: dec, articles: int, unknown: int }).nullable(),
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
  outcomes: z.object({
    closed: int,
    tp: int,
    sl: int,
    maxHold: int,
    /** #303: đóng vì tin ngược chiều (version chọn Close at market). */
    opposite: int,
    open: int,
  }),
  /**
   * #358: tầng 4 · Context ở chế độ tổng: số bài (cùng cửa sổ với `articleStops`: bài THU trong khoảng) có snapshot `live`
   * tới bước 4, và số có H1 / H2 / H3 = `yes` ("Whales agree N · Funding vs crowd N · Ran early N"). Không trộn
   * `backfilled`; #353: chỉ snapshot của context version hiện tại. null khi trong khoảng không có snapshot nào như vậy (web
   * giữ "records only").
   */
  context: z.object({ reached: int, h1Yes: int, h2Yes: int, h3Yes: int }).nullable(),
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

/**
 * #304: trạng thái cổng precision của classifier đã tạo ra một lệnh (`classifier_version` của lệnh). `unknown` = lệnh
 * không ghi classifier (bài trước migration 0045).
 */
export const researchClassifierStatusSchema = z.enum(CLASSIFIER_GATE_STATUSES);

/**
 * #304 (DEC-328 mục 2): lệnh chỉ tính cổng khi classifier tạo ra nó đã qua (≥ 50 nhãn, precision ≥ 80%). `counted` = số
 * lệnh đã đóng được tính; `notCounted` = lệnh đã đóng KHÔNG được tính, gom theo classifier, để web ghi "Not counted ·
 * classifier vX under 80%" / "waits for labels (N to go)".
 */
export const researchGateClassifiersSchema = z.object({
  counted: int,
  notCounted: z.array(
    z.object({
      /** `claude_prompt_version` (vd `news-classifier-v2`); null = không biết. */
      classifierVersion: z.string().nullable(),
      closed: int,
      /** Không bao giờ `passed` (lệnh của classifier đã qua thì được tính). */
      status: researchClassifierStatusSchema,
      labeled: int,
      precisionPct: z.number().nullable(),
      /** Số nhãn còn thiếu để đủ 50; null khi `unknown`. */
      labelsToGo: int.nullable(),
    }),
  ),
});

export const researchSummaryRowSchema = z.object({
  type,
  label,
  rulesVersion: int,
  /**
   * Mọi lệnh đã đóng. Từ #304 các số thống kê của dòng (`avgPct`, `range`, `status`, `needs`…) chỉ tính lệnh có
   * classifier đã qua cổng (`classifiers.counted`).
   */
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
  /** null với lane không dùng classifier (replay). */
  classifiers: researchGateClassifiersSchema.nullable(),
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

// ── Signal context (#329) ────────────────────────────────────────────────────────────────────────────────────────────

const contextSource = z.enum(CONTEXT_SOURCES);
const h1Status = z.enum(H1_STATUSES);
const h2Status = z.enum(H2_STATUSES);
const h3Status = z.enum(H3_STATUSES);

/**
 * Cờ ngữ cảnh gọn của một bài trong feed (tag H1 / H2 / H3). null ở trên = bài không có snapshot (bị loại trước bước 4,
 * hoặc bài trước khi có bước này).
 */
export const researchContextFlagsSchema = z.object({
  /** `live` = chụp lúc chạy ("Recorded"); `backfilled` = dựng lại sau, chỉ từ dữ liệu trước quyết định. */
  source: contextSource,
  h1: h1Status,
  h2: h2Status,
  h3: h3Status,
});

/**
 * Thẻ bước 4 · Context của trace: giá trị lưu đúng lúc quyết định, không bao giờ tính lại; chỉ ghi, không đổi lệnh.
 * Phần trăm theo đơn vị % (0.6 = 0.6%); funding là tỷ lệ thô mỗi kỳ (chuỗi thập phân, 0.0001 = 0.01%).
 */
/**
 * Trạng thái thị trường lúc quyết định (Catalyst P0, #376): chỉ để tách kết quả, không đổi quyết định. Trên một lệnh / thẻ:
 * null = snapshot ghi trước #376 hoặc không có snapshot ("Not recorded (before Phase 0)"); có object mà trường null = thiếu
 * dữ liệu lúc đó ("Not available"). Phần trăm theo đơn vị % (2.4 = 2.4%).
 */
export const researchMarketStateSchema = z.object({
  /** % đổi giá BTC-USD trong 24 h trước quyết định (có dấu). */
  btcChange24hPct: z.number().nullable(),
  /** > +1.5% up, < −1.5% down, còn lại flat. */
  btcTrend: z.enum(BTC_TRENDS).nullable(),
  /** Biến động 4 h của chính tài sản (%, trị tuyệt đối). */
  volMovePct: z.number().nonnegative().nullable(),
  /** Phân vị (0–100) của biến động đó trong 30 ngày. */
  volPercentile: z.number().min(0).max(100).nullable(),
  /** < 33 low, > 67 high, còn lại normal. */
  volatility: z.enum(VOLATILITY_STATES).nullable(),
});

const marketGroup = <T extends readonly [string, ...string[]]>(keys: T) =>
  z.object({
    key: z.enum(keys),
    closed: int,
    /** Trung bình sau phí mỗi lệnh (% của size); null khi nhóm < `minClosedPerGroup` lệnh đóng. */
    avgPct: z.number().nullable(),
    /** Còn thiếu bao nhiêu lệnh đóng ("needs 23 more"); 0 khi đủ. */
    need: int,
  });

/**
 * "Is it working? › By market" (#376): cùng tập lệnh đóng được tính như cổng chính, tách theo trạng thái thị trường lúc quyết
 * định. Nhóm < 30 lệnh đóng không hiện trung bình. `notRecorded` = lệnh không có trạng thái của nguồn này (mở trước #376,
 * hoặc chỉ có snapshot của nguồn kia); `notAvailable` = có ghi nhưng thiếu dữ liệu lúc đó.
 */
export const researchMarketSplitSchema = z.object({
  /** Nguồn snapshot của khối (review #381): `live` và `backfilled` không bao giờ trộn, như "Does context help?". */
  source: contextSource,
  minClosedPerGroup: int,
  btcTrend: z.array(marketGroup(BTC_TRENDS)),
  volatility: z.array(marketGroup(VOLATILITY_STATES)),
  notRecorded: int,
  btcNotAvailable: int,
  volNotAvailable: int,
});

/** Một ví Hyperliquid trong Signal research: địa chỉ (chữ thường) và có trang `/traders/[address]` hay không. */
export const researchWalletRefSchema = z.object({
  address: z.string().regex(/^0x[0-9a-f]{40}$/),
  /** Có thống kê leaderboard (`leader_stats_daily`) nên trang trader mở được; false thì web chỉ hiện địa chỉ. */
  hasProfile: z.boolean(),
});

export const researchSignalContextSchema = z.object({
  decidedAt: iso,
  source: contextSource,
  /** Version của cách tính (ngưỡng cố định của version đó). */
  contextVersion: z.string().min(1),
  market: z.string(),
  side,
  /**
   * H1 · Whales agree. `context-v2` (#353): ít nhất 1 ví trong research set (top K của leaderboard, đã có trong leaderboard
   * trước thời điểm đó) mở / tăng vị thế cùng chiều trong `windowMinutes` trước quyết định. `context-v1` (#349, snapshot cũ):
   * ví DeskLabs đang theo dõi (được follow). `na`: tài sản không có trên Hyperliquid, hoặc N = 0.
   */
  h1: z.object({
    status: h1Status,
    /**
     * N = số ví thật sự được kiểm lúc quyết định (đọc thành công trong 60 phút trước; "N wallets checked"; không phải số ví
     * của cả leaderboard); null với dòng không lưu.
     */
    walletsChecked: int.nullable(),
    /** context-v2: version tập ví nghiên cứu đã dùng; null ở v1 hoặc khi chưa có tập. */
    walletSetVersion: int.nullable(),
    /** context-v2: số ví của tập ("top {K} of the leaderboard"); null ở v1 hoặc khi chưa có tập. */
    walletSetSize: int.nullable(),
    /** Tài sản có trên Hyperliquid (false → "Not available" vì không có trên Hyperliquid); null với dòng không lưu. */
    assetOnHyperliquid: z.boolean().nullable(),
    agreeingWallets: int.nullable(),
    /**
     * Ví cùng chiều / ngược chiều lúc chụp (theo địa chỉ). null ở snapshot ghi trước khi lưu địa chỉ (chỉ có số lượng) hoặc khi
     * H1 không tính; web hiện tối đa 3 ví và "+N more".
     */
    agreeing: z.array(researchWalletRefSchema).nullable(),
    opposing: z.array(researchWalletRefSchema).nullable(),
    opposingWallets: int.nullable(),
    /** Tổng notional (USD) của ví cùng chiều; null khi không có ví cùng chiều. */
    agreeingUsdc: dec.nullable(),
    /** Fill đầu tiên của ví cùng chiều ("first at 09:41"). */
    firstAt: iso.nullable(),
    windowMinutes: int,
  }),
  /** H2 · Funding against the crowd: Long khi percentile ≤ 20, Short khi ≥ 80 (30 ngày, funding SoDEX). */
  h2: z.object({
    status: h2Status,
    /** Funding kỳ gần nhất trước quyết định, tỷ lệ thô mỗi kỳ; null khi không có. */
    fundingRate: dec.nullable(),
    fundingTime: iso.nullable(),
    /** Kỳ funding (giờ), suy từ dữ liệu; null khi không biết. */
    intervalHours: z.number().nonnegative().nullable(),
    /** Percentile 0–100 trong 30 ngày; null khi `na`. */
    percentile: z.number().min(0).max(100).nullable(),
    samples: int.nullable(),
    /** Bên trả funding. */
    payer: z.enum(FUNDING_PAYERS).nullable(),
    /** Ngưỡng percentile của chiều này ("Long needs ≤ 20th" / "Short needs ≥ 80th"). */
    thresholdPercentile: z.number().min(0).max(100),
    lookbackDays: int,
  }),
  /** H3 · Price already moved: giá đã chạy theo chiều tín hiệu ≥ 1 × biến động 1 giờ thường gặp. */
  h3: z.object({
    status: h3Status,
    /**
     * Giá đã chạy từ giờ đăng của bài ĐẦU TIÊN của story tới lúc quyết định (%, có dấu: dương = tăng); cùng con số với
     * `movedBeforeEntryPct` của lệnh mở từ tín hiệu này (#312). null khi thiếu giá.
     */
    movedPct: z.number().nullable(),
    typicalMovePct: z.number().nullable(),
    /** Ngưỡng (%) = bội số × biến động thường gặp. */
    thresholdPct: z.number().nullable(),
  }),
  /** Chỉ số khám phá: không dùng để mở tuỳ chọn version. Open interest: SoDEX không có, không lưu. */
  exploratory: z.object({
    /** Khối lượng giờ cuối ÷ trung bình mỗi giờ của 24 giờ ("1.8×"); null khi không có. */
    volumeVs24h: z.number().nonnegative().nullable(),
    rangeBreakout: z.enum(RANGE_BREAKOUTS).nullable(),
  }),
  /** #376: trạng thái thị trường lúc quyết định (chip trên thẻ Decide); null = snapshot ghi trước #376. */
  marketState: researchMarketStateSchema.nullable(),
});

const contextGroup = z.object({
  closed: int,
  /** Trung bình sau phí mỗi lệnh (% của size); null khi đang `collecting` (không cho nhìn trộm trước khi đủ mẫu). */
  avgPct: z.number().nullable(),
});

/**
 * So có / không một giả thuyết trên lệnh thật đã đóng của version (chỉ lệnh có classifier đã qua cổng precision, như cổng
 * chính; chỉ snapshot `live`). `na` bị loại khỏi cả hai nhóm (H1 "against" tính vào "without").
 */
export const researchContextQuestionSchema = z.object({
  key: z.enum(["h1", "h2", "h3"]),
  with: contextGroup,
  without: contextGroup,
  /** Chênh (có − không), % ; null khi `collecting`. */
  diffPct: z.number().nullable(),
  /** Khoảng 95% theo block bootstrap ngày ghép cặp; null khi `collecting` hoặc < 2 ngày. */
  range: z.object({ lo: z.number(), hi: z.number() }).nullable(),
  clusters: int,
  status: z.enum(CONTEXT_COMPARE_STATUSES),
  /** Còn thiếu bao nhiêu lệnh đóng ở mỗi nhóm ("Collecting 18 more with · 9 more without"); 0 khi đủ. */
  needWith: int,
  needWithout: int,
});

/**
 * Danh sách research wallets (#353, khu "Bots & labels"): tập ví nghiên cứu mới nhất, chỉ đọc từ DB (không gọi Hyperliquid).
 * `set` null = chưa có tập nào (leaderboard chưa chạy).
 */
export const researchWalletsSchema = z.object({
  set: z
    .object({
      version: int,
      /** Ngày của lần xếp hạng leaderboard đã dùng. */
      runDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      /** K cấu hình lúc chụp. */
      k: int,
      /** Số ví thật sự có trong tập ("Research wallets (top {K})"). */
      size: int,
      createdAt: iso,
    })
    .nullable(),
  /** Cửa sổ "đọc được gần đây" của H1 (phút). */
  windowMinutes: int,
  items: z.array(
    researchWalletRefSchema.extend({
      /** Hạng trong tab Top lúc chụp (1 = cao nhất). */
      rank: int,
      /** Lần marketdata đọc ví thành công gần nhất; null = chưa đọc được lần nào. */
      lastReadAt: iso.nullable(),
      /** Đọc được trong `windowMinutes` phút trước lúc trả về (tính được bởi H1 lúc này). */
      readRecently: z.boolean(),
    }),
  ),
});

export const researchContextSummarySchema = z.object({
  /**
   * #353: version hiện tại. H1 (so sánh và `coverage.whale`) chỉ tính snapshot của version này; H2 / H3 gộp các version có
   * cùng hàm tính (`H23_SAME_AS_CURRENT`, review #365).
   */
  contextVersion: z.string().min(1),
  /** #353: số ví của tập ví nghiên cứu mới nhất ("top {K} of the leaderboard"); null khi chưa có tập. */
  researchWalletsTop: int.nullable(),
  /**
   * Nguồn snapshot của khối này (#344): `live` (chụp lúc chạy) và `backfilled` (dựng lại sau) không bao giờ trộn vào một
   * nhóm; tổng kết trả hai khối riêng (`context`, `contextBackfilled`).
   */
  source: contextSource,
  /** Mỗi nhóm cần ≥ ngần này lệnh đóng mới có kết luận. */
  minClosedPerGroup: int,
  questions: z.array(researchContextQuestionSchema).length(3),
  /**
   * Lệnh đóng được tính nhưng không có snapshot của nguồn này (mở trước khi có bước Context, hoặc chỉ có nguồn kia).
   */
  closedWithoutSnapshot: int,
  /**
   * Độ phủ trên mọi tín hiệu có snapshot của nguồn này (từ lúc version được lưu; Baseline: mọi lúc). `backfilled` luôn là
   * số snapshot dựng lại, dù khối là nguồn nào.
   */
  coverage: z.object({
    signals: int,
    whale: int,
    funding: int,
    priceRun: int,
    backfilled: int,
    /** SoDEX không có lịch sử open interest trong dữ liệu của DeskLabs: không dùng, không lấy của sàn khác. */
    openInterest: z.literal("notAvailable"),
  }),
});

export const researchSummarySchema = z.object({
  computedAt: iso,
  /** #305: News bot version của tổng kết (mặc định Baseline); null khi không có version nào (dữ liệu trước version). */
  version: z
    .object({ id: z.uuid(), number: int, name: z.string(), isBaseline: z.boolean() })
    .nullable(),
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
  /** #329: Does context help? (theo version của tổng kết), snapshot `live`; null khi lane chưa chạy. */
  context: researchContextSummarySchema.nullable(),
  /** #344: như `context` nhưng chỉ snapshot `backfilled` (nút "Backfilled"); null khi lane chưa chạy. */
  contextBackfilled: researchContextSummarySchema.nullable(),
  /** #376: tách kết quả theo trạng thái thị trường lúc quyết định, snapshot `live`; null khi lane chưa chạy. */
  marketSplit: researchMarketSplitSchema.nullable(),
  /** Như `marketSplit` nhưng chỉ snapshot `backfilled`; null khi lane chưa chạy. */
  marketSplitBackfilled: researchMarketSplitSchema.nullable(),
  /**
   * #321: lúc quy tắc News hiện tại (`newsRulesVersion`) bắt đầu (bài đầu tiên thu theo quy tắc đó); phễu theo khoảng chỉ
   * đếm từ mốc này ("since rules v3 started …"). null khi lane chưa chạy.
   */
  newsRulesSince: iso.nullable(),
  /**
   * #321 / #344: lệnh News · live của các quy tắc cũ (ví dụ v2) còn trong danh sách của version này (chỉ Baseline có); không
   * bao giờ tính cổng. `versions` = số version quy tắc cũ có lệnh, tăng dần. Danh sách lệnh chỉ hiện chúng khi
   * `olderRules=true`.
   */
  olderRules: z.object({ trades: int, versions: z.array(int) }),
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
  /** #304: N của "Limit: N open" / "Limit: N per day" (lý do `limitOpen` / `limitDay`); null với lý do khác hoặc dòng cũ không lưu. */
  limit: z.number().int().positive().nullable(),
  /**
   * #305: tín hiệu bị giới hạn / số dư chặn (`limitOpen` / `limitDay` / `noBalance`) vẫn được theo dõi giả định bằng
   * một lệnh shadow (ngoài balance): id lệnh đó (mở `/trades/:id`) và kết quả giả định. null với lý do khác hoặc khi
   * đã có lệnh shadow mở trên tài sản đó (chỉ ghi event).
   */
  shadow: z
    .object({
      tradeId: z.uuid(),
      outcome: z.enum(["tp", "sl", "maxHold", "opposite", "open"]),
      /** Kết quả sau phí khi đã đóng; null khi còn mở. */
      pnl: dec.nullable(),
    })
    .nullable(),
});

/**
 * #305: tin ngược chiều đầu tiên lúc lệnh đang mở (story mới cùng tài sản, chiều ngược, đạt level của version).
 * `action` = `closed` khi version chọn Close at market và lệnh đã đóng vì tin đó, `kept` khi giữ lệnh. Kết quả là kết
 * quả giả định nếu đóng ở giá thị trường lúc đó (sau phí), ghi cho mọi version để so Keep và Close.
 */
export const researchTradeOppositeSchema = z.object({
  at: iso,
  storyId: z.uuid().nullable(),
  action: z.enum(["closed", "kept"]),
  exitPrice: dec,
  resultUsdc: dec,
  resultPct: z.number(),
});

/** #305: lệnh shadow (bị giới hạn chặn, chỉ theo dõi giả định, ngoài balance, không bao giờ tính cổng). */
export const researchTradeShadowSchema = z.object({
  reason: z.enum(["limitOpen", "limitDay", "noBalance"]),
  /** N của "Limit: N open" / "Limit: N per day" (từ config bất biến của version); null với `noBalance`. */
  limit: z.number().int().positive().nullable(),
});

export const researchTradeSchema = z.object({
  id: z.string().min(1),
  /** #305: News bot version của lệnh / tín hiệu; null = dòng trước khi có version (lịch sử news-v2) hoặc replay. */
  versionId: z.uuid().nullable(),
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
  /**
   * #304: classifier đã tạo ra lệnh và trạng thái cổng của nó (lệnh chỉ tính cổng khi `passed`). null với tín hiệu bị bỏ.
   */
  classifier: z
    .object({ version: z.string().nullable(), status: researchClassifierStatusSchema })
    .nullable(),
  /** null khi tín hiệu bị bỏ qua. */
  result: z
    .object({
      pnl: dec.nullable(),
      /** #297: lệnh đang mở: lãi / lỗ nếu đóng ngay ở giá SoDEX gần nhất (sau phí); null khi đã đóng hoặc chưa có giá. */
      unrealized: dec.nullable(),
      outcome: z.enum(["tp", "sl", "maxHold", "opposite", "open"]),
      leftSecs: int.nullable(),
    })
    .nullable(),
  /** #305: chỉ khi chính mục này là lệnh shadow (mở bằng `/trades/:id`); danh sách chỉ có lệnh thật. */
  shadow: researchTradeShadowSchema.nullable(),
  /** #305: tin ngược chiều trên lệnh này; null khi chưa có (hoặc với tín hiệu bị bỏ). */
  opposite: researchTradeOppositeSchema.nullable(),
  /**
   * #321: số version quy tắc của lệnh / tín hiệu (3 = news-v3). Khác `newsRulesVersion` của tổng kết → lệnh quy tắc cũ, web
   * gắn nhãn "Rules v2 · not counted" (không bao giờ tính cổng).
   */
  rulesVersion: int,
  /**
   * #376: trạng thái thị trường lúc quyết định của bài đã mở lệnh / bị bỏ (cột "Market at entry"); null = không có (lệnh
   * trước #376, replay). Mặc định null để dữ liệu cũ vẫn parse.
   */
  marketState: researchMarketStateSchema.nullable().default(null),
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
  outcome: z.enum(["tp", "sl", "maxHold", "opposite"]).nullish(),
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
  /** #304: N của "Limit: N open" / "Limit: N per day" (lý do `limitOpen` / `limitDay`); null với lý do khác hoặc dòng cũ không lưu. */
  reasonLimit: z.number().int().positive().nullable(),
  /** Chỉ khi `outcome = merged`. */
  mergeReason: z.enum(RESEARCH_MERGE_REASONS).nullable(),
  /** Bài đã được gửi cho Claude (kể cả bài cũ chưa có usage). */
  sentToClaude: z.boolean(),
  claude: researchClaudeUsageSchema.nullable(),
  /** Lệnh giấy bài này đã mở. */
  tradeId: z.uuid().nullable(),
  /** #305: version mà bước dừng / kết quả mô tả (bước Filter / Decide riêng từng version); null = dòng trước version. */
  versionId: z.uuid().nullable(),
  /** #305: lệnh shadow (theo dõi giả định) khi bài bị giới hạn chặn; null khi không có. */
  shadowTradeId: z.uuid().nullable(),
  /** #305: bài là tin ngược chiều trên lệnh đang mở của version: đóng lệnh đó (`closed`) hay giữ (`kept`). */
  opposite: z
    .object({ action: z.enum(["closed", "kept"]), tradeId: z.uuid().nullable() })
    .nullable(),
  /** #329: cờ ngữ cảnh lúc quyết định (dùng chung mọi version); null khi bài không có snapshot. */
  context: researchContextFlagsSchema.nullable(),
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
  /** #305: News bot version; không có = Baseline. */
  versionId: z.uuid().optional(),
});

/**
 * #345: bài mới cho hiệu ứng "bài rơi xuống phễu" (web hỏi mỗi 15 s). `since` là con trỏ mờ của lần trước; không có =
 * lần đầu: API trả `items` rỗng và con trỏ ở bài mới nhất hiện có (bài đã có trước khi mở trang không rơi).
 */
export const researchNewArticlesQuerySchema = z.object({
  since: z.string().max(400).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  /** News bot version; không có = Baseline. */
  versionId: z.uuid().optional(),
});

/**
 * Bài thu sau con trỏ, cũ trước mới (theo giờ DeskLabs thu bài), CHỈ bài đã xong phễu (`outcome` khác `waiting`), để bài
 * rơi xuống đúng bước nó dừng thật. Bài còn chờ (thu trong 15 phút gần nhất) giữ con trỏ lại tới khi xong, nên một bài có
 * thể trả lại ở lần sau: web bỏ bài đã thấy theo `id`.
 */
export const researchNewArticlesSchema = z.object({
  items: z.array(researchArticleSchema),
  /** Con trỏ gửi lại ở lần hỏi sau. */
  since: z.string().min(1),
});

export const researchSummaryQuerySchema = z.object({
  /** Không có = như trước (#271): phễu tính mọi dữ liệu của version hiện tại. */
  range: z.enum(RESEARCH_RANGES).optional(),
  tz: z.string().max(64).optional(),
  /** #305: News bot version; không có = Baseline. */
  versionId: z.uuid().optional(),
});

/** #305: query của trace một bài. */
// ── Độ trễ theo chặng (#375, DEC-348 mục 4) ──────────────────────────────────────────────────────────

/**
 * Các chặng từ tin gốc tới lệnh, theo thứ tự. `sourceToSoso` (nguồn gốc → SoSoValue) không đo được: SoSoValue chỉ trả
 * `release_time`, nên luôn null ("Not provided").
 */
export const RESEARCH_LATENCY_STAGES = [
  "sourceToSoso",
  "publishedToCollected",
  "collectedToClaudeDone",
  "claudeDoneToDecided",
  "decidedToOpened",
] as const;

export const researchLatencyQuerySchema = z.object({
  range: z.enum(RESEARCH_RANGES).default("1d"),
  tz: z.string().max(64).optional(),
  /** News bot version của chặng decided / opened; không có = Baseline. */
  versionId: z.uuid().optional(),
});

export const researchLatencyStageSchema = z.object({
  key: z.enum(RESEARCH_LATENCY_STAGES),
  /** Median (ms, làm tròn); null = chưa đo được bài nào ("Not measured yet") hoặc không có nguồn ("Not provided"). */
  medianMs: int.nullable(),
  /** Số bài đo được ở chặng này; null khi chặng không có nguồn (`sourceToSoso`). */
  n: int.nullable(),
});

/**
 * Median từng chặng trong cửa sổ (bài thu trong 1 ngày / 7 ngày theo `collected_at`, version quy tắc hiện tại). Mỗi chặng
 * đo trên các bài có đủ hai mốc, nên `n` khác nhau giữa các chặng.
 */
export const researchLatencySchema = z.object({
  range: z.enum(RESEARCH_RANGES),
  computedAt: iso,
  stages: z.array(researchLatencyStageSchema).length(RESEARCH_LATENCY_STAGES.length),
});

export const researchTraceQuerySchema = z.object({
  tz: z.string().max(64).optional(),
  versionId: z.uuid().optional(),
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

// ── Nhãn phân loại và cổng precision của classifier (#304, DEC-328 mục 2) ─────────────────────────────────────────

/** Nhãn của người đang xem cho một bài. */
export const researchMyLabelSchema = z.object({
  classifierVersion: z.string(),
  /** #306: 4 ký tự hex cuối id người gắn ("··a91f" của thiết kế, như `createdBy` của version); không lộ gì thêm. */
  labeledBy: z.string().regex(/^[0-9a-f]{4}$/),
  verdict: z.enum(CLASSIFICATION_VERDICTS),
  /** Chỉ khi `verdict = wrong`. */
  reason: z.enum(CLASSIFICATION_WRONG_REASONS).nullable(),
  note: z.string().nullable(),
  /**
   * #348: `random` = lưu từ luồng gắn nhãn ngẫu nhiên với token hợp lệ của `labels/next` (chỉ nhãn này tính cổng);
   * `trace` = mọi cách khác.
   */
  source: z.enum(CLASSIFICATION_LABEL_SOURCES),
  createdAt: iso,
  updatedAt: iso,
});

/** Token gắn nhãn ngẫu nhiên do `GET /labels/next` cấp (32 byte ngẫu nhiên, base64url). */
export const researchLabelTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

/** Body của `PUT /articles/:id/label`. Wrong bắt buộc `reason`; Right không được có `reason`. */
export const researchLabelBodySchema = z
  .strictObject({
    verdict: z.enum(CLASSIFICATION_VERDICTS),
    reason: z.enum(CLASSIFICATION_WRONG_REASONS).nullish(),
    note: z.string().trim().max(LABEL_NOTE_MAX).nullish(),
    /**
     * #348: token của `GET /labels/next` cho đúng bài này. Hợp lệ (đúng người, đúng bài, chưa hết hạn, chưa dùng) và
     * người gọi chưa có nhãn cho bài → nhãn `random`; thiếu / sai / hết hạn / đã dùng → nhãn vẫn được lưu nhưng là
     * `trace` (không lỗi). Client không thể tự nhận `random`.
     */
    labelToken: researchLabelTokenSchema.nullish(),
  })
  .superRefine((b, ctx) => {
    const hasReason = b.reason !== undefined && b.reason !== null;
    if (b.verdict === ClassificationVerdict.wrong && !hasReason)
      ctx.addIssue({ code: "custom", path: ["reason"], message: "required" });
    if (b.verdict === ClassificationVerdict.right && hasReason)
      ctx.addIssue({ code: "custom", path: ["reason"], message: "not_allowed" });
  });

/**
 * Bài để gắn nhãn (`GET /labels/next`): chỉ nội dung bài và điều Claude nói. KHÔNG có bất kỳ trường kết quả nào (bước
 * dừng, kết quả, lệnh, level, lý do bị loại) để kết quả không ảnh hưởng nhãn.
 */
export const researchLabelArticleSchema = z.strictObject({
  id: z.string().min(1),
  title: z.string().nullable(),
  /** Nội dung đã bỏ HTML (đã cắt ≤ 6 000 ký tự khi thu). */
  content: z.string().nullable(),
  url: z.string().nullable(),
  source: z.string(),
  tier: tier.nullable(),
  publishedAt: iso,
  tagged: z.array(z.string()),
});

/** Điều classifier nói về bài (như thẻ Score của thiết kế), không có level hay kết quả. */
export const researchLabelClassificationSchema = z.strictObject({
  classifierVersion: z.string(),
  newsType: z.enum(RESEARCH_NEWS_TYPES),
  asset: z.string().nullable(),
  relevance: z.enum(["direct", "passingMention"]).nullable(),
  promotional: z.boolean().nullable(),
  eventDate: z.string().nullable(),
  claude: researchClaudeUsageSchema.nullable(),
});

export const researchLabelNextSchema = z.strictObject({
  /** null = không còn bài nào của classifier hiện tại mà người này chưa gắn nhãn. */
  item: z
    .strictObject({
      article: researchLabelArticleSchema,
      classification: researchLabelClassificationSchema,
    })
    .nullable(),
  /** Số bài tín hiệu của classifier hiện tại người này chưa gắn nhãn (gồm cả `item`). */
  remaining: int,
  /**
   * #348: token dùng một lần, hết hạn sau `LABEL_TOKEN_TTL_MIN` phút, gắn với người gọi và `item.article.id`; gửi lại
   * trong `PUT /articles/:id/label` để nhãn được tính là `random`. null khi `item` null.
   */
  labelToken: researchLabelTokenSchema.nullable(),
});

/** Kết quả của các lệnh bài này đã mở (mọi News bot version), chỉ trả SAU khi đã lưu nhãn. */
export const researchLabelTradeResultSchema = z.object({
  tradeId: z.uuid(),
  versionId: z.uuid().nullable(),
  side,
  status: z.enum(["open", "closed"]),
  outcome: z.enum(["tp", "sl", "maxHold", "opposite", "open"]),
  resultPct: z.number().nullable(),
  resultUsdc: dec.nullable(),
});

export const researchLabelSavedSchema = z.object({
  articleId: z.string().min(1),
  label: researchMyLabelSchema,
  trades: z.array(researchLabelTradeResultSchema),
});

export const researchClassifierRowSchema = z.object({
  classifierVersion: z.string(),
  /** Classifier đang chạy (`NEWS_CLASSIFIER.promptVersion`). */
  current: z.boolean(),
  /** Lần đầu chạy (`signal_classifier_versions.started_at`); null khi không ghi. */
  startedAt: iso.nullable(),
  /** Số bài classifier này gọi là tín hiệu (tổng thể của precision). */
  signals: int,
  /** Số bài có ít nhất một nhãn `random` (#348: chỉ nhãn random tính precision, khoảng Wilson và cổng). */
  labeled: int,
  /** Số bài kết luận Right theo nhãn `random` (đa số nhãn Right; hoà tính Wrong). */
  right: int,
  /** #348: số bài có ít nhất một nhãn `trace` (không tính cổng; hiện riêng "from traces: n"). */
  traceLabeled: int,
  precisionPct: z.number().nullable(),
  /** Khoảng Wilson 95% của precision, đơn vị %; null khi chưa có nhãn. */
  interval: z.object({ lo: z.number(), hi: z.number() }).nullable(),
  passes: z.boolean(),
  status: researchClassifierStatusSchema.exclude(["unknown"]),
  labelsToGo: int,
  /** Lý do Wrong hay gặp nhất (đếm theo nhãn, cả `random` lẫn `trace`), nhiều trước. */
  mostCommonMistakes: z.array(z.object({ reason: z.enum(CLASSIFICATION_WRONG_REASONS), n: int })),
});

export const researchClassifiersSchema = z.object({
  /** Mức sàn của cổng (50 nhãn, 80%). */
  gate: z.object({ minLabels: int, minPrecisionPct: z.number() }),
  /** Classifier hiện tại trước, rồi mới nhất trước. */
  items: z.array(researchClassifierRowSchema),
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
        /**
         * #304: bài này gắn nhãn được (classifier gọi là tín hiệu: catalyst ≠ none và qua Score, có version prompt).
         */
        labelable: z.boolean(),
        /** #304: nhãn của CHÍNH người đang xem (null = chưa gắn). Trace không ẩn kết quả lệnh. */
        label: researchMyLabelSchema.nullable(),
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
        /** #304: N của "Limit: N open" / "Limit: N per day" (lý do `limitOpen` / `limitDay`); null với lý do khác hoặc dòng cũ không lưu. */
        reasonLimit: z.number().int().positive().nullable(),
        /** #305: lệnh shadow khi bị giới hạn chặn. */
        shadowTradeId: z.uuid().nullable(),
        /** #305: bài là tin ngược chiều trên lệnh đang mở của version (đóng hay giữ lệnh đó). */
        opposite: z
          .object({ action: z.enum(["closed", "kept"]), tradeId: z.uuid().nullable() })
          .nullable(),
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
        /** #305: tin ngược chiều trên lệnh này (timeline "Opposite news … kept / closed"). */
        opposite: researchTradeOppositeSchema.nullable(),
      })
      .nullable(),
  }),
]);

export const researchArticleTraceSchema = z.object({
  article: researchArticleSchema,
  /** Luôn đủ 5 bước theo thứ tự collect → decide. */
  steps: z.array(researchTraceStepSchema).length(5),
  /**
   * #329: bước 4 · Context (giữa Score và Filter), dùng chung mọi version. null = bài không có snapshot (dừng trước bước 4,
   * hoặc bài trước khi có bước này): web hiện bước Context "not reached".
   */
  context: researchSignalContextSchema.nullable(),
});

export type ResearchRange = (typeof RESEARCH_RANGES)[number];
export type ResearchStage = (typeof RESEARCH_STAGES)[number];
export type ResearchDropReason = (typeof RESEARCH_DROP_REASONS)[number];
export type ResearchNewsType = (typeof RESEARCH_NEWS_TYPES)[number];
export type ResearchClaudeUsage = z.infer<typeof researchClaudeUsageSchema>;
export type ResearchArticle = z.infer<typeof researchArticleSchema>;
export type ResearchArticlesPage = z.infer<typeof researchArticlesPageSchema>;
export type ResearchArticlesQuery = z.infer<typeof researchArticlesQuerySchema>;
export type ResearchLatencyStageKey = (typeof RESEARCH_LATENCY_STAGES)[number];
export type ResearchLatencyQuery = z.infer<typeof researchLatencyQuerySchema>;
export type ResearchLatency = z.infer<typeof researchLatencySchema>;
export type ResearchNewArticlesQuery = z.infer<typeof researchNewArticlesQuerySchema>;
export type ResearchNewArticles = z.infer<typeof researchNewArticlesSchema>;
export type ResearchSummaryQuery = z.infer<typeof researchSummaryQuerySchema>;
export type ResearchTraceStory = z.infer<typeof researchTraceStorySchema>;
export type ResearchTraceCheck = z.infer<typeof researchTraceCheckSchema>;
export type ResearchTraceStep = z.infer<typeof researchTraceStepSchema>;
export type ResearchArticleTrace = z.infer<typeof researchArticleTraceSchema>;
export type ResearchMyLabel = z.infer<typeof researchMyLabelSchema>;
export type ResearchLabelBody = z.infer<typeof researchLabelBodySchema>;
export type ResearchLabelNext = z.infer<typeof researchLabelNextSchema>;
export type ResearchLabelTradeResult = z.infer<typeof researchLabelTradeResultSchema>;
export type ResearchLabelSaved = z.infer<typeof researchLabelSavedSchema>;
export type ResearchClassifierRow = z.infer<typeof researchClassifierRowSchema>;
export type ResearchClassifiers = z.infer<typeof researchClassifiersSchema>;
export type ResearchGateClassifiers = z.infer<typeof researchGateClassifiersSchema>;

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
  /** #305: News bot version; không có = Baseline (gồm lịch sử trước version, như #298). */
  versionId: z.uuid().optional(),
  /**
   * #344: "true" thì thêm lệnh / tín hiệu của quy tắc cũ (news-v2, chỉ Baseline có); mặc định chỉ quy tắc hiện tại, đúng
   * tập của version đang chọn.
   */
  olderRules: z.enum(["true", "false"]).optional(),
});
export type ResearchTradesQuery = z.infer<typeof researchTradesQuerySchema>;

// ── News bot versions (#305, DEC-328 / DEC-331; thiết kế docs/mockups/signal-research/bot-versions*.html) ──────────────

const catalyst = z.enum(SIGNAL_CATALYSTS as [SignalCatalyst, ...SignalCatalyst[]]);
const newsTypeCfg = z.object({ enabled: z.boolean(), maxHoldHours: int });
const assetMode = z.enum([AssetMode.all, AssetMode.only, AssetMode.except]);
const oppositePolicy = z.enum([OppositeNewsPolicy.keep, OppositeNewsPolicy.close]);
const kinds = z.object({ crypto: z.boolean(), stocks: z.boolean() });

/** Một điểm khác với version đã chép từ (`diffVersionConfig`); web dịch thành câu như "SL 0.75× → 1.0×". */
export const researchVersionChangeSchema = z.discriminatedUnion("field", [
  z.object({
    field: z.literal("newsType"),
    /** Khoá nội bộ như trong config (`etf_approved`…). */
    catalyst,
    from: newsTypeCfg.nullable(),
    to: newsTypeCfg.nullable(),
  }),
  z.object({ field: z.literal("minLevel"), from: level, to: level }),
  z.object({ field: z.literal("maxSourceDelayMinutes"), from: int, to: int }),
  z.object({ field: z.literal("maxOpenTrades"), from: int, to: int }),
  z.object({ field: z.literal("maxNewTradesPerDay"), from: int.nullable(), to: int.nullable() }),
  z.object({ field: z.literal("sizeUsdc"), from: dec, to: dec }),
  z.object({ field: z.literal("tpMultiple"), from: dec, to: dec }),
  z.object({ field: z.literal("slMultiple"), from: dec, to: dec }),
  z.object({ field: z.literal("minTpCostMultiple"), from: dec, to: dec }),
  z.object({ field: z.literal("onOppositeNews"), from: oppositePolicy, to: oppositePolicy }),
  z.object({ field: z.literal("assetMode"), from: assetMode, to: assetMode }),
  z.object({ field: z.literal("assetKinds"), from: kinds, to: kinds }),
  z.object({
    field: z.literal("assets"),
    added: z.array(z.string()),
    removed: z.array(z.string()),
  }),
]);

/** Lệnh đã đóng KHÔNG được tính cổng của version, gom theo classifier (như `researchGateClassifiersSchema`). */
const versionNotCounted = z.object({
  classifierVersion: z.string().nullable(),
  closed: int,
  /** Lệnh của đoạn đếm cũ (classifier khác classifier hiện tại hoặc mở trước mốc đoạn) luôn ở đây. */
  status: researchClassifierStatusSchema,
  labelsToGo: int.nullable(),
});

/**
 * #377 (DEC-351): thí nghiệm của một version so với Baseline CỐ ĐỊNH (không phải version đã chép từ). Cặp =
 * lệnh đã đóng của version (mở từ lúc lưu) và của Baseline trên cùng câu chuyện + market; chênh lệch kết quả sau phí (điểm
 * %), khoảng 95% block bootstrap theo ngày (DEC-321) trên đúng 100 cặp đầu. `finishedAt` / kết quả đóng băng khi version tự
 * dừng lúc đủ 100 cặp (Finished).
 */
export const researchExperimentSchema = z.object({
  control: z.object({ id: z.uuid(), number: int }),
  /** Khác biệt so với Baseline (cùng dạng `changedFromPrevious`); null khi thiếu config để so. */
  changes: z.array(researchVersionChangeSchema).nullable(),
  /** Số "thứ" đã đổi (mỗi loại tin một thứ; Assets là một thứ); null khi thiếu config. */
  changedThings: int.nullable(),
  /** Đổi đúng một thứ; false = "Not a clean test" (chỉ cảnh báo). */
  clean: z.boolean().nullable(),
  pairs: int,
  needed: int,
  meanDiffPct: dec.nullable(),
  ciLow: dec.nullable(),
  ciHigh: dec.nullable(),
  clusters: int,
  verdict: z.enum(EXPERIMENT_VERDICTS),
  /** Lúc tự dừng vì đủ cặp (Finished); null = chưa. */
  finishedAt: iso.nullable(),
});

export const researchVersionSchema = z.object({
  id: z.uuid(),
  /** Số hiển thị ("v4"), tăng dần, không dùng lại. */
  number: int,
  name: z.string(),
  status: z.enum(SIGNAL_BOT_VERSION_STATUSES),
  isBaseline: z.boolean(),
  createdAt: iso,
  statusChangedAt: iso,
  /** 4 ký tự cuối id người lưu ("··a91f"); null với Baseline (seed ở migration). */
  createdBy: z
    .string()
    .regex(/^[0-9a-f]{4}$/)
    .nullable(),
  savedFrom: z.object({ id: z.uuid(), number: int }).nullable(),
  /** Config bất biến; null khi dòng DB không parse được (không bao giờ đoán). */
  config: botVersionConfigSchema.nullable(),
  /** Khác với version đã chép từ; null khi không chép từ version nào (hoặc thiếu config để so). */
  changedFromPrevious: z.array(researchVersionChangeSchema).nullable(),
  classifier: z.object({
    /** Classifier hiện tại (`NEWS_CLASSIFIER.promptVersion`); mọi version dùng chung. */
    current: z.string(),
    /** Mốc đầu đoạn đếm hiện tại = mốc sau của lúc lưu version và lúc classifier hiện tại bắt đầu. */
    segmentStart: iso,
    /** Classifier đã tạo ra lệnh thật của version (cũ trước), để hiện "v1 → v2". */
    used: z.array(z.string()),
  }),
  /** 10 000 + Σ kết quả sau phí của lệnh thật đã đóng. */
  balance: dec,
  /** Số dư còn dùng được = balance − Σ size lệnh thật đang mở (giới hạn `NO_BALANCE`). */
  available: dec,
  openTrades: int,
  maxOpenTrades: int.nullable(),
  /** min(Max open trades, số mã) ở chế độ Only these ("Effectively N"); còn lại = Max open trades. */
  effectiveMaxOpen: int.nullable(),
  /** Lệnh thật mở trong ngày UTC hiện tại. */
  todayTrades: int,
  /** null = Off (không giới hạn) hoặc config hỏng. */
  maxNewTradesPerDay: int.nullable(),
  /** Số lệnh shadow (tín hiệu bị giới hạn / số dư chặn, theo dõi giả định). */
  blockedByLimit: int,
  /** Lệnh thật đã đóng (mọi classifier). */
  closed: int,
  /** Lệnh đã đóng tính cho cổng: đoạn đếm hiện tại, classifier hiện tại đã qua cổng nhãn. */
  counted: int,
  /** Kết quả sau phí trung bình (%) của lệnh `counted`; null khi chưa có. */
  avgPct: z.number().nullable(),
  gate: z.object({
    status: z.enum(VERSION_GATE_STATUSES),
    /** Lệnh đã đóng của đoạn đếm hiện tại (kể cả khi classifier chưa qua). */
    segmentClosed: int,
    /** Trạng thái cổng nhãn của classifier hiện tại. */
    classifierStatus: researchClassifierStatusSchema,
    labelsToGo: int,
    notCounted: z.array(versionNotCounted),
    /** Kiểm tra thêm (> 3 version đã thử): số lệnh lúc qua lần đầu và tiến độ lặp lại; null khi không áp dụng. */
    firstPassAt: int.nullable(),
    repeat: z.object({ closed: int, needed: int }).nullable(),
  }),
  /** #377: giả thuyết (một câu) khi lưu; null với Baseline và version lưu trước #377. */
  hypothesis: z.string().nullable(),
  /** #377: thí nghiệm so ghép cặp với Baseline cố định; null với Baseline (hoặc khi chưa có Baseline). */
  experiment: researchExperimentSchema.nullable(),
});

export const researchVersionsSchema = z.object({
  /** Mới nhất trước. */
  items: z.array(researchVersionSchema),
  running: int,
  maxRunning: int,
  /** Số version đã lưu (Baseline + version team tạo, mọi trạng thái); rules v1 / v2 không tính. */
  versionsTried: int,
  /** > 3 version đã thử: version qua cổng phải lặp lại trên 100 lệnh đóng tiếp theo. */
  extraCheck: z.boolean(),
  repeatTrades: int,
  classifier: z.object({
    current: z.string(),
    startedAt: iso.nullable(),
    labeled: int,
    precisionPct: z.number().nullable(),
    passes: z.boolean(),
    status: researchClassifierStatusSchema.exclude(["unknown"]),
    labelsToGo: int,
  }),
});

/** Body của `POST /versions`. Config bất biến sau khi lưu (không có route sửa). */
export const researchVersionCreateBodySchema = z.strictObject({
  name: z.string().trim().min(1).max(60),
  config: botVersionConfigSchema,
  /** Version đã chép từ ("Edit as new version"); null / không có = tạo mới. */
  savedFromVersionId: z.uuid().nullish(),
  /** true = "Save and start"; false = lưu ở trạng thái paused. */
  start: z.boolean(),
  /** #377: giả thuyết của thí nghiệm, một câu, bắt buộc với mọi version mới. */
  hypothesis: hypothesisSchema,
});

export const researchVersionStatusBodySchema = z.strictObject({
  status: z.enum(SIGNAL_BOT_VERSION_STATUSES),
});

export const researchVersionParamsSchema = z.object({ id: z.uuid() });

/**
 * Market perps SoDEX đang listed cho picker. Đọc bản chụp Redis `sr:markets` do scheduler ghi (module Signal research của
 * api không chạm SoDEX, DEC-322 / DEC-327).
 */
export const researchMarketSchema = z.object({
  market: z.string(),
  base: z.string(),
  displayName: z.string().nullable(),
  /** `stock` theo `STOCK_MARKET_SET` (danh sách viết tay, DEC-330); còn lại `crypto`. */
  kind: z.enum(["crypto", "stock"]),
  /** Trạng thái SoDEX (`TRADING`, `HALT`…). */
  status: z.string(),
});

export const researchMarketsSchema = z.object({
  /**
   * Crypto trước rồi cổ phiếu, mỗi nhóm theo tên market. null = chưa có bản chụp (scheduler chưa ghi / không đọc được):
   * không bao giờ trả danh sách rỗng như thể SoDEX không có market nào.
   */
  items: z.array(researchMarketSchema).nullable(),
  /** Lúc scheduler ghi bản chụp; null khi chưa có. */
  updatedAt: iso.nullable(),
  /** Cũ hơn 15 phút hoặc chưa có: web ghi "Market list may be out of date". */
  stale: z.boolean(),
});

/** Cảnh báo kèm khi lưu version thành công (không chặn lưu). */
export const RESEARCH_VERSION_WARNINGS = ["market_list_stale"] as const;

/** Kết quả `POST /versions`: version vừa lưu + cảnh báo (vd danh sách market đã cũ lúc kiểm tài sản). */
export const researchVersionCreatedSchema = researchVersionSchema.extend({
  warnings: z.array(z.enum(RESEARCH_VERSION_WARNINGS)),
});

export type ResearchVersionCreated = z.infer<typeof researchVersionCreatedSchema>;
export type ResearchVersionChange = z.infer<typeof researchVersionChangeSchema>;
export type ResearchVersion = z.infer<typeof researchVersionSchema>;
export type ResearchExperiment = z.infer<typeof researchExperimentSchema>;
export type ResearchVersions = z.infer<typeof researchVersionsSchema>;
export type ResearchVersionCreateBody = z.infer<typeof researchVersionCreateBodySchema>;
export type ResearchVersionStatusBody = z.infer<typeof researchVersionStatusBodySchema>;
export type ResearchMarket = z.infer<typeof researchMarketSchema>;
export type ResearchMarkets = z.infer<typeof researchMarketsSchema>;
export type ResearchTradeOpposite = z.infer<typeof researchTradeOppositeSchema>;
export type ResearchTradeShadow = z.infer<typeof researchTradeShadowSchema>;
export type ResearchTraceQuery = z.infer<typeof researchTraceQuerySchema>;
export type ResearchContextFlags = z.infer<typeof researchContextFlagsSchema>;
export type ResearchSignalContext = z.infer<typeof researchSignalContextSchema>;
export type ResearchMarketState = z.infer<typeof researchMarketStateSchema>;
export type ResearchMarketSplit = z.infer<typeof researchMarketSplitSchema>;
export type ResearchWalletRef = z.infer<typeof researchWalletRefSchema>;
export type ResearchWallets = z.infer<typeof researchWalletsSchema>;
export type ResearchContextQuestion = z.infer<typeof researchContextQuestionSchema>;
export type ResearchContextSummary = z.infer<typeof researchContextSummarySchema>;

// Signal research: news lane (#263 D, #271; flow #269 v3.4). Paper trading của team, không bao giờ chạm SoDEX.
// Mọi quy tắc của lane tin tức nằm ở đây, có version: đổi bảng quy tắc, hạng nguồn hay bảng map = tăng `version`
// (cổng của #263 chỉ đếm một version).

/** Loại tin được tính là tín hiệu (rules v2, #269 Design v3.3 mục 1). `none` = không thuộc danh sách. */
export const NewsCatalyst = {
  hackExploit: "hack_exploit",
  listing: "listing",
  delisting: "delisting",
  etfApproved: "etf_approved",
  etfDelayedOrRejected: "etf_delayed_or_rejected",
  regulatoryAction: "regulatory_action",
  favorableRuling: "favorable_ruling",
  treasuryBuy: "treasury_buy",
  treasurySell: "treasury_sell",
  earningsBeat: "earnings_beat",
  earningsMiss: "earnings_miss",
  tokenUnlock: "token_unlock",
  none: "none",
} as const;
export type NewsCatalyst = (typeof NewsCatalyst)[keyof typeof NewsCatalyst];
export type SignalCatalyst = Exclude<NewsCatalyst, "none">;

export const TradeDirection = { long: "long", short: "short" } as const;
export type TradeDirection = (typeof TradeDirection)[keyof typeof TradeDirection];

export const AssetKind = { crypto: "crypto", stock: "stock" } as const;
export type AssetKind = (typeof AssetKind)[keyof typeof AssetKind];

export const SourceTier = { top: "top", mid: "mid", low: "low" } as const;
export type SourceTier = (typeof SourceTier)[keyof typeof SourceTier];

export const SignalLevel = { high: "high", medium: "medium", low: "low" } as const;
export type SignalLevel = (typeof SignalLevel)[keyof typeof SignalLevel];

export interface CatalystRule {
  direction: TradeDirection;
  /** Thời gian giữ tối đa (giờ thực, kể cả cuối tuần). */
  maxHoldHours: number;
  /** Loại tài sản mà loại tin này áp dụng (earnings chỉ cho cổ phiếu). */
  kinds: readonly AssetKind[];
}

const BOTH = [AssetKind.crypto, AssetKind.stock] as const;
const DAY = 24;

/** Bước trong pipeline (#269 v3.4) và kết quả của bước đó; mỗi dòng `signal_events` là một cặp. */
export const SignalStage = {
  collect: "collect",
  normalize: "normalize",
  understand: "understand",
  filter: "filter",
  decide: "decide",
  watch: "watch",
} as const;
export type SignalStage = (typeof SignalStage)[keyof typeof SignalStage];

export const SignalOutcome = {
  pass: "pass",
  /** Lưu thô, không phân loại, không giao dịch (cũ hơn mốc dưới của Collect). Không phải "bị loại". */
  backlog: "backlog",
  drop: "drop",
  merge: "merge",
  open: "open",
  close: "close",
} as const;
export type SignalOutcome = (typeof SignalOutcome)[keyof typeof SignalOutcome];

/** Mã lý do bị loại / gộp / đóng (hiện ở báo cáo; câu chữ UI làm sau cùng #269). */
export const SignalReason = {
  // collect
  backlog: "BACKLOG_NOT_CLASSIFIED",
  /** Chưa có danh sách market SoDEX: chu kỳ chỉ Collect, bài chờ Normalize ở chu kỳ sau. */
  marketsUnknown: "MARKETS_UNKNOWN",
  // normalize
  staleNews: "STALE_NEWS",
  noSodexMarket: "NO_SODEX_MARKET",
  duplicate: "DUPLICATE",
  // understand
  notUnderstood: "NOT_UNDERSTOOD",
  claudeBudget: "CLAUDE_BUDGET_REACHED",
  /** Chờ Claude quá lâu (quá `maxSourceDelayMinutes` sau giờ đăng): bỏ, không gọi Claude. */
  classifierLate: "CLASSIFIER_LATE",
  notSignalType: "NOT_A_SIGNAL_TYPE",
  passingMention: "PASSING_MENTION",
  promotional: "PROMOTIONAL",
  eventTooOld: "EVENT_TOO_OLD",
  wrongAssetKind: "CATALYST_ASSET_MISMATCH",
  /** news-v3 (#298): ký hiệu / tên của tài sản Claude chọn không có trong tiêu đề hay nội dung bài. */
  assetNotInText: "ASSET_NOT_IN_TEXT",
  /** news-v3 (#298): treasury_buy / treasury_sell trên BTC hoặc ETH không bao giờ giao dịch. */
  treasuryMajorAsset: "TREASURY_MAJOR_ASSET",
  // filter
  sameStory: "SAME_STORY",
  /** Câu chuyện chưa vào lệnh nhưng bài đầu tiên đã quá `retryWindowMinutes`: gộp, không vào lệnh. */
  storyTooOld: "STORY_TOO_OLD",
  sourceLate: "SOURCE_LATE",
  noPrice: "NO_SODEX_PRICE",
  noBookData: "NO_BOOK_DATA",
  notEnoughHistory: "NOT_ENOUGH_HISTORY",
  tooThin: "TOO_THIN_TO_TRADE",
  moveTooSmall: "MOVE_TOO_SMALL_FOR_COST",
  tradeOpen: "NEWS_TRADE_ALREADY_OPEN",
  // filter, riêng từng News bot version (#303, DEC-328)
  /** Loại tin bị tắt trong version. */
  newsTypeOff: "NEWS_TYPE_OFF",
  /** Tài sản không thuộc danh sách / loại tài sản của version. */
  assetNotInVersion: "ASSET_NOT_IN_VERSION",
  /** Level của câu chuyện dưới "Lowest level to trade" của version. */
  levelTooLow: "LEVEL_TOO_LOW",
  /** Bị chặn bởi giới hạn hoặc số dư giả: không vào lệnh, chỉ theo dõi giả định (shadow). */
  limitOpen: "LIMIT_OPEN",
  limitDay: "LIMIT_DAY",
  noBalance: "NO_BALANCE",
  // close
  takeProfit: "TAKE_PROFIT",
  stopLoss: "STOP_LOSS",
  maxHold: "MAX_HOLD",
  /** Đóng vì tin ngược chiều (version chọn Close at market). */
  oppositeNews: "OPPOSITE_NEWS",
} as const;
export type SignalReason = (typeof SignalReason)[keyof typeof SignalReason];

export const PaperExitReason = {
  takeProfit: "take_profit",
  stopLoss: "stop_loss",
  maxHold: "max_hold",
  /** Version chọn "Close at market" khi có tin ngược chiều (#303). */
  oppositeNews: "opposite_news",
} as const;
export type PaperExitReason = (typeof PaperExitReason)[keyof typeof PaperExitReason];

/**
 * Quy tắc tin tức v3 (#269 Design v3.3 mục 1 + mục 7, v3.4; #298). Mọi con số là giả thuyết của nghiên cứu, không phải
 * tham số đã kiểm chứng. v3 so với v2: tài sản phải có trong tiêu đề / nội dung bài (`ASSET_NOT_IN_TEXT`), treasury không
 * giao dịch BTC / ETH (`TREASURY_MAJOR_ASSET`), prompt classifier `news-classifier-v2` (sau đó `news-classifier-v3` mà không tăng version này: đổi prompt chỉ tăng
 * `NEWS_CLASSIFIER.promptVersion`, DEC-335). Lệnh của version cũ vẫn hiện ở
 * danh sách lệnh (lịch sử) nhưng không tính vào tổng kết và cổng. Danh sách tài sản (market cổ phiếu, alias) có version
 * riêng `NEWS_ASSET_MAP_VERSION` (#309): đổi danh sách không đổi version này và không reset cổng.
 */
export const NEWS_RULES = {
  version: "news-v3",
  /** Số version (API hiện dạng số). */
  versionNumber: 3,
  lane: "news",
  /** Bảng loại tin → chiều + giữ tối đa. Chiều do loại tin quyết định, Claude chỉ gọi tên loại tin và tài sản. */
  catalysts: {
    hack_exploit: { direction: TradeDirection.short, maxHoldHours: 1 * DAY, kinds: BOTH },
    listing: { direction: TradeDirection.long, maxHoldHours: 1 * DAY, kinds: [AssetKind.crypto] },
    delisting: {
      direction: TradeDirection.short,
      maxHoldHours: 2 * DAY,
      kinds: [AssetKind.crypto],
    },
    etf_approved: {
      direction: TradeDirection.long,
      maxHoldHours: 3 * DAY,
      kinds: [AssetKind.crypto],
    },
    etf_delayed_or_rejected: {
      direction: TradeDirection.short,
      maxHoldHours: 2 * DAY,
      kinds: [AssetKind.crypto],
    },
    regulatory_action: { direction: TradeDirection.short, maxHoldHours: 3 * DAY, kinds: BOTH },
    favorable_ruling: { direction: TradeDirection.long, maxHoldHours: 3 * DAY, kinds: BOTH },
    treasury_buy: {
      direction: TradeDirection.long,
      maxHoldHours: 2 * DAY,
      kinds: [AssetKind.crypto],
    },
    treasury_sell: {
      direction: TradeDirection.short,
      maxHoldHours: 2 * DAY,
      kinds: [AssetKind.crypto],
    },
    earnings_beat: {
      direction: TradeDirection.long,
      maxHoldHours: 3 * DAY,
      kinds: [AssetKind.stock],
    },
    earnings_miss: {
      direction: TradeDirection.short,
      maxHoldHours: 3 * DAY,
      kinds: [AssetKind.stock],
    },
    token_unlock: {
      direction: TradeDirection.short,
      maxHoldHours: 2 * DAY,
      kinds: [AssetKind.crypto],
    },
  } satisfies Record<SignalCatalyst, CatalystRule>,
  /**
   * Treasury buy / sell trên các market này không bao giờ giao dịch (#298): công ty nhỏ mua / bán ít BTC hay ETH không
   * tác động tới giá. Token khác vẫn giữ; Claude không trích được số tiền thì gắn cờ `smallTreasury` để phân tích sau.
   */
  treasuryExcludedMarkets: ["BTC-USD", "ETH-USD"],
  /** Cỡ lệnh paper cố định (USDC). */
  sizeUsdc: "500",
  /** TP / SL = bội số của biến động thường gặp trong khoảng giữ tối đa. */
  tpMultiple: "1.5",
  slMultiple: "0.75",
  /** Biến động thường gặp: trung vị |giá đóng sau H − giá đóng| / giá, mỗi giờ một mẫu, trên ngần này ngày nến 1 phút. */
  volatilityLookbackDays: 30,
  /** Cần ít nhất ngần này mẫu (giờ) để tính biến động; ít hơn → NOT_ENOUGH_HISTORY. */
  volatilityMinSamples: 240,
  /** TP phải ≥ bội số này × chi phí khứ hồi. */
  minTpCostMultiple: "2",
  /** Phí taker SoDEX dự phòng (%) khi chưa có `takerFee` của market; builder fee mỗi chiều (phần mười bp). */
  builderFeeRate: 10,
  /**
   * Câu chuyện chưa từng vào lệnh chỉ được thử lại trong ngần này phút kể từ bài đầu tiên được tính (edge của tin mất
   * nhanh); quá thì bài sau gộp vào với lý do `STORY_TOO_OLD`, không vào lệnh.
   */
  retryWindowMinutes: 120,
  /** Story key (token + loại tin) đã có trong ngần này ngày → gộp, không bao giờ mở lại. */
  storyWindowDays: 7,
  /** Bài tới tay DeskLabs trễ hơn ngần này sau giờ đăng → nguồn không đúng giờ. */
  maxSourceDelayMinutes: 30,
  /** Bài đăng cũ hơn ngần này (so với lúc xử lý) → "Stale news", bỏ trước Claude. */
  maxArticleAgeHours: 24,
  /** Lần chạy đầu: watermark = now − ngần này phút (env `SIGNAL_NEWS_START_LOOKBACK_MIN` ghi đè). */
  startLookbackMinutes: 15,
  /** Không bao giờ bắt kịp quá ngần này phút sau thời gian ngừng (env `SIGNAL_NEWS_MAX_CATCHUP_MIN` ghi đè). */
  maxCatchUpMinutes: 30,
  /**
   * Mốc dưới của Collect tính theo giờ DeskLabs chạy chu kỳ trước (không theo giờ đăng): bài chưa thấy, đăng sau
   * `lastCycleAt − ngần này phút` (và không cũ hơn `maxCatchUpMinutes`), vẫn được phân loại dù SoSoValue đưa lên trễ.
   */
  collectMarginMinutes: 30,
  /** Sự kiện cũ hơn ngần này so với giờ đăng → bỏ. */
  maxEventAgeHours: 24,
  /** Giá / sổ lệnh cũ hơn ngần này thì coi như không có. */
  bookFreshMs: 5_000,
  lastPriceFreshMs: 15_000,
  /** Spread theo giờ (mm_market_hourly): cần ≥ ngần này mẫu (giây) trong 2 giờ gần nhất. */
  hourlySpreadMinSamples: 60,
} as const;

/**
 * Hạng nguồn theo tên tác giả SoSoValue (`author`, viết thường). Danh sách khởi đầu là phỏng đoán từ dữ liệu thật
 * 2026-11-18 (106 bài); tên chưa có ở đây rơi về: category 7 (announcement / official: tài khoản dự án, nhưng SoSoValue
 * cũng xếp cả báo và bot vào đây) → mid, còn lại → low.
 * Top: nguồn gốc (sàn, công ty, cơ quan quản lý, quỹ ETF), Bloomberg, Reuters. Mid: báo crypto uy tín, nhà báo đã
 * xác minh. Low: trang tổng hợp, bot, tài khoản ẩn danh / influencer.
 */
export const SOURCE_TIERS: Readonly<Record<string, SourceTier>> = {
  bloomberg: "top",
  reuters: "top",
  sec: "top",
  "sec.gov": "top",
  binance: "top",
  coinbase: "top",
  upbit: "top",
  okx: "top",
  bybit: "top",
  blackrock: "top",
  techflow: "mid",
  odaily: "mid",
  panews: "mid",
  foresightnews: "mid",
  chaincatcher: "mid",
  "chaincatcher research": "mid",
  wublockchain12: "mid",
  coindesk: "mid",
  cointelegraph: "mid",
  theblock__: "mid",
  "the block": "mid",
  decrypt: "mid",
  blockworks: "mid",
  "crypto.news": "mid",
  defiantnews: "mid",
  bitcoinmagazine: "mid",
  cnbc: "mid",
  wsj: "mid",
  unchained: "mid",
  ericbalchunas: "mid",
  "moomoo news": "low",
  sosovalue: "low",
  "soso price bot": "low",
  zerohedge: "low",
  "financia ljuice": "low",
  financialjuice: "low",
  whalewatchalert: "low",
  unusual_whales: "low",
  whale_alert: "low",
  cryptotimes_io: "low",
  defiprime: "low",
};

/** SoSoValue category của bài "announcement / official" (tài liệu `/news`). */
export const SOSO_OFFICIAL_CATEGORY = 7;

/**
 * Version của danh sách tài sản lane tin tức (#309): `STOCK_MARKET_SET`, `STOCK_SYMBOL_ALIASES`, `STOCK_BRAND_ALIASES`.
 * Đổi một trong ba bảng = đổi chuỗi này (dạng `assets-<ngày><chữ>`), **không** đổi `NEWS_RULES.version`: danh sách tài
 * sản chỉ mở rộng phạm vi, không đổi cách giao dịch một tín hiệu, nên không reset cổng. Ghi vào detail của event
 * normalize / understand và cột `asset_map_version` của lệnh giấy để truy được.
 */
export const NEWS_ASSET_MAP_VERSION = "assets-2026-11-19a";

/**
 * Market cổ phiếu trên SoDEX (cổ phiếu niêm yết, ETF cổ phiếu, cổ phiếu pre-IPO): kind `stock`, nhãn "outside market
 * hours", và tag công ty của SoSoValue chỉ map vào market trong danh sách này (#309). SoDEX `/perps/markets/symbols`
 * không có trường loại tài sản (kiểm 2026-11-19: chỉ có `name`, `baseCoin`, phí, bậc margin, funding…), nên danh sách
 * viết tay và phải bổ sung khi SoDEX mở market cổ phiếu mới (thêm mã = tăng `NEWS_ASSET_MAP_VERSION`). Coin không bao giờ map vào
 * market ở đây (coin "COIN" không phải Coinbase). Market chỉ số / hàng hoá (US500, USTECH100, XAUT, CL, SILVER…)
 * không nằm ở đây. DRAM-USD chưa rõ loại nên chưa thêm.
 */
export const STOCK_MARKET_SET: ReadonlySet<string> = new Set([
  "AAPL-USD",
  "AMD-USD",
  "AMZN-USD",
  "COIN-USD",
  "CRCL-USD",
  "CRWD-USD",
  "CRWV-USD",
  "CXMT-USD",
  "EWY-USD",
  "GOOGL-USD",
  "HOOD-USD",
  "INTC-USD",
  "KIOXIA-USD",
  "KORU-USD",
  "LITE-USD",
  "MCD-USD",
  "META-USD",
  "MINIMAX-USD",
  "MRNA-USD",
  "MRVL-USD",
  "MSFT-USD",
  "MSTR-USD",
  "MU-USD",
  "NBIS-USD",
  "NKE-USD",
  "NVDA-USD",
  "ORCL-USD",
  "PLTR-USD",
  "PONS-USD",
  "SAMSUNG-USD",
  "SKHX-USD",
  "SKHY-USD",
  "SMCI-USD",
  "SNDK-USD",
  "SPCX-USD",
  "TSLA-USD",
  "TSM-USD",
  "UNITREE-USD",
  "ZHIPU-USD",
]);

/**
 * Mã / tên SoSoValue của tag công ty khác mã SoDEX (#309). Tag công ty khác dùng thẳng `<SYMBOL>-USD`; xStock (tên kết
 * thúc bằng "XSTOCK", mã có thêm "X") bỏ chữ "X" cuối trước khi tra.
 */
export const STOCK_SYMBOL_ALIASES: Readonly<Record<string, string>> = {
  GOOG: "GOOGL-USD",
  SPACEX: "SPCX-USD",
};

/**
 * Tên thương hiệu của cổ phiếu khác tên SoSoValue / mã SoDEX (#298): dùng cho kiểm "tài sản có trong bài" của news-v3.
 * Danh sách nhỏ, tường minh; thêm tên = tăng `NEWS_ASSET_MAP_VERSION` (#309, sửa DEC-329). #309 thêm tên của vài market mới (SpaceX,
 * Samsung, Lumentum, Kioxia, MiniMax, Unitree, Zhipu). Market cổ phiếu không có ở đây (SKHX, SKHY, CXMT, EWY, KORU,
 * PONS) chỉ khớp bằng mã ("CXMT") và tên SoSoValue ≥ 2 từ (DEC-329).
 */
export const STOCK_BRAND_ALIASES: Readonly<Record<string, readonly string[]>> = {
  "AAPL-USD": ["Apple"],
  "AMZN-USD": ["Amazon"],
  "COIN-USD": ["Coinbase"],
  "CRWD-USD": ["CrowdStrike"],
  "CRWV-USD": ["CoreWeave"],
  "GOOGL-USD": ["Google", "Alphabet"],
  "HOOD-USD": ["Robinhood"],
  "INTC-USD": ["Intel"],
  "KIOXIA-USD": ["Kioxia"],
  "LITE-USD": ["Lumentum"],
  "MCD-USD": ["McDonald's"],
  "META-USD": ["Meta", "Facebook"],
  "MINIMAX-USD": ["MiniMax"],
  "MRNA-USD": ["Moderna"],
  "MRVL-USD": ["Marvell"],
  "MSFT-USD": ["Microsoft"],
  "MSTR-USD": ["MicroStrategy"],
  "MU-USD": ["Micron"],
  "NBIS-USD": ["Nebius"],
  "NKE-USD": ["Nike"],
  "NVDA-USD": ["Nvidia"],
  "ORCL-USD": ["Oracle"],
  "PLTR-USD": ["Palantir"],
  "SAMSUNG-USD": ["Samsung"],
  "SMCI-USD": ["Supermicro", "Super Micro"],
  "SNDK-USD": ["SanDisk"],
  "SPCX-USD": ["SpaceX"],
  "TSLA-USD": ["Tesla"],
  "TSM-USD": ["TSMC", "Taiwan Semiconductor"],
  "UNITREE-USD": ["Unitree"],
  "ZHIPU-USD": ["Zhipu"],
};

export const SIGNAL_CATALYSTS = Object.keys(NEWS_RULES.catalysts) as SignalCatalyst[];
export const NEWS_CATALYSTS: readonly NewsCatalyst[] = [...SIGNAL_CATALYSTS, NewsCatalyst.none];

export function catalystRule(c: SignalCatalyst): CatalystRule {
  return NEWS_RULES.catalysts[c];
}

/** Claude phân loại tin (#271): model cố định, bảng giá để tính chi phí / ngày (USD trên 1M token, giá 2026-11). */
export const NEWS_CLASSIFIER = {
  model: "claude-haiku-4-5",
  /**
   * TTL của prompt cache: 1 giờ (ghi 2×, đọc 0.1×). Chu kỳ mặc định 5 phút đúng bằng TTL mặc định nên cần 1 giờ; chu kỳ
   * 1 phút (`SIGNAL_NEWS_CYCLE_MINUTES`) vẫn giữ 1 giờ để giờ ít tin không làm cache hết hạn giữa hai lần gọi.
   */
  cacheTtl: "1h",
  promptVersion: "news-classifier-v3",
  maxTokens: 400,
  /** Tối đa ngần này ký tự nội dung bài gửi cho Claude. */
  maxContentChars: 4000,
  pricing: {
    inputPerM: "1",
    outputPerM: "5",
    /** Ghi cache TTL 1 giờ = 2× giá đầu vào (TTL 5 phút là 1.25×). */
    cacheWriteMultiple: "2",
    cacheReadMultiple: "0.1",
  },
} as const;

/**
 * Chu kỳ của lane tin tức (phút, #394): scheduler chạy Collect → Decide mỗi `SIGNAL_NEWS_CYCLE_MINUTES` phút (số nguyên
 * `minMinutes`–`maxMinutes`, mặc định `defaultMinutes`; sai → mặc định kèm cảnh báo). Web không đọc hằng này: số phút thật
 * đến từ API (`cycleMinutes` của tổng kết, scheduler ghi vào Redis `sr:lane`), thiếu thì "Not available".
 */
export const NEWS_CYCLE = {
  defaultMinutes: 5,
  minMinutes: 1,
  maxMinutes: 5,
  /**
   * `SIGNAL_CLAUDE_MAX_CALLS_PER_CYCLE` là trần cho ngần này phút (= một chu kỳ mặc định); chu kỳ ngắn hơn chia theo tỷ lệ
   * (`claudeCallsForCycle`) để tổng lần gọi Claude mỗi giờ không tăng khi chạy 1 phút.
   */
  claudeCallsWindowMinutes: 5,
} as const;

/**
 * Giới hạn của SoSoValue theo từng API key (https://sosovalue-1.gitbook.io/sosovalue-api-doc/rate-limit, đọc 2026-11-21):
 * 20 request / phút. Scheduler không bao giờ gửi quá `perMinute` request trong `windowMs` trượt, kể cả request phân trang.
 * Gặp HTTP 429 hoặc `code` 42901 → dừng chu kỳ đó, nguồn ghi `rate_limited`, chu kỳ sau mới thử lại.
 */
export const SOSO_RATE_LIMIT = { perMinute: 20, windowMs: 60_000, code: 42901 } as const;
/** `last_error` của nguồn `sosovalue` khi bị giới hạn tốc độ (SoSoValue trả 429 / 42901, hoặc DeskLabs tự chặn). */
export const SOSO_RATE_LIMITED_ERROR = "rate_limited";

/** Số lần gọi Claude tối đa của một chu kỳ: trần mỗi 5 phút chia theo độ dài chu kỳ, làm tròn lên, ít nhất 2 (một bài). */
export function claudeCallsForCycle(perWindow: number, cycleMinutes: number): number {
  return Math.max(2, Math.ceil((perWindow * cycleMinutes) / NEWS_CYCLE.claudeCallsWindowMinutes));
}

/** Ngưỡng Live / Delayed / Down của từng nguồn (ms kể từ lần cuối thành công), ở chu kỳ mặc định 5 phút. */
export const SOURCE_HEALTH = {
  sosovalue: { liveMs: 7 * 60_000, delayedMs: 20 * 60_000 },
  claude: { liveMs: 30 * 60_000, delayedMs: 2 * 3_600_000 },
  sodex_prices: { liveMs: 2 * 60_000, delayedMs: 10 * 60_000 },
} as const;
export type SignalSourceKey = keyof typeof SOURCE_HEALTH;

/**
 * Ngưỡng của nguồn theo chu kỳ thật (#394). `sosovalue` được gọi mỗi chu kỳ nên Live = chu kỳ + 2 phút (5 → 7 phút như
 * cũ, 1 → 3 phút); Delayed giữ 20 phút (thời gian thật người xem chịu được, không theo chu kỳ). Nguồn khác không phụ thuộc
 * chu kỳ. `cycleMinutes` null (chưa biết) → ngưỡng của chu kỳ mặc định.
 */
export function sourceHealthOf(
  key: SignalSourceKey,
  cycleMinutes: number | null,
): { liveMs: number; delayedMs: number } {
  const t = SOURCE_HEALTH[key];
  if (key !== "sosovalue" || cycleMinutes === null) return t;
  return { liveMs: (cycleMinutes + 2) * 60_000, delayedMs: t.delayedMs };
}

/**
 * Hạn mức mặc định của lane tin tức (scheduler đọc env ghi đè: `SIGNAL_SOSO_MONTHLY_LIMIT`,
 * `SIGNAL_CLAUDE_DAILY_INPUT_TOKENS`). Gói free SoSoValue: 10 000 request / tháng → chừa 500.
 */
export const NEWS_LIMIT_DEFAULTS = {
  sosoMonthlyLimit: 9_500,
  claudeDailyInputBudget: 2_000_000,
  claudeMaxCallsPerCycle: 50,
  sosoMaxPages: 2,
} as const;

import {
  baselineVersionConfig,
  diffVersionConfig,
  researchClassifiersSchema,
  researchMarketsSchema,
  researchVersionsSchema,
  type BotVersionConfig,
  type ResearchClassifiers,
  type ResearchMarkets,
  type ResearchVersion,
  type ResearchVersions,
} from "@drift/shared";

// Dữ liệu giả của News bot versions (#306), theo số mẫu của mockup bot-versions*.html. Baseline là v3 (v1 / v2 là rules
// lịch sử, không phải version, DEC-331). Giờ UTC; ở Asia/Ho_Chi_Minh (UTC+7) khớp giờ của mockup.

export const BASELINE_ID = "00000000-0000-4000-8000-000000000003";
export const V4_ID = "00000000-0000-4000-8000-000000000004";
export const V5_ID = "00000000-0000-4000-8000-000000000005";
export const V6_ID = "00000000-0000-4000-8000-000000000006";

const CUR = "news-classifier-v2";
const OLD = "news-classifier-v1";

const base = baselineVersionConfig();
const strict: BotVersionConfig = {
  ...base,
  minLevel: "medium",
  news: {
    ...base.news,
    treasury_buy: { enabled: false, maxHoldHours: 48 },
    treasury_sell: { enabled: false, maxHoldHours: 48 },
  },
  maxNewTradesPerDay: 5,
};
const majors: BotVersionConfig = {
  ...strict,
  minLevel: "high",
  assets: { mode: "only", markets: ["BTC-USD", "ETH-USD"], crypto: true, stocks: true },
};
const wider: BotVersionConfig = { ...base, slMultiple: "1.0" };

const gate = (g: Partial<ResearchVersion["gate"]>): ResearchVersion["gate"] => ({
  status: "waits_for_labels",
  segmentClosed: 0,
  classifierStatus: "needsLabels",
  labelsToGo: 13,
  notCounted: [],
  firstPassAt: null,
  repeat: null,
  ...g,
});

const common = {
  statusChangedAt: "2026-11-19T06:05:00.000Z",
  balance: "10000",
  available: "10000",
  openTrades: 0,
  maxOpenTrades: 20,
  effectiveMaxOpen: 20,
  todayTrades: 0,
  maxNewTradesPerDay: null,
  blockedByLimit: 0,
  closed: 0,
  counted: 0,
  avgPct: null,
} as const;

export const BASELINE: ResearchVersion = {
  // #377: thí nghiệm (API mới); UI chưa dùng.
  hypothesis: null,
  experiment: null,
  ...common,
  id: BASELINE_ID,
  number: 3,
  name: "Baseline",
  status: "running",
  isBaseline: true,
  createdAt: "2026-11-18T02:12:00.000Z",
  createdBy: null,
  savedFrom: null,
  config: base,
  changedFromPrevious: null,
  classifier: {
    current: CUR,
    segmentStart: "2026-11-19T06:00:00.000Z",
    used: [OLD, CUR],
  },
  balance: "10024.6",
  available: "6524.6",
  openTrades: 7,
  todayTrades: 3,
  closed: 31,
  gate: gate({
    status: "not_counted",
    notCounted: [{ classifierVersion: OLD, closed: 31, status: "underPrecision", labelsToGo: 26 }],
  }),
};

export const V4: ResearchVersion = {
  // #377: thí nghiệm (API mới); UI chưa dùng.
  hypothesis: null,
  experiment: null,
  ...common,
  id: V4_ID,
  number: 4,
  name: "Strict subject",
  status: "running",
  isBaseline: false,
  createdAt: "2026-11-19T06:05:00.000Z",
  createdBy: "a91f",
  savedFrom: { id: BASELINE_ID, number: 3 },
  config: strict,
  changedFromPrevious: diffVersionConfig(base, strict),
  classifier: { current: CUR, segmentStart: "2026-11-19T06:05:00.000Z", used: [] },
  maxNewTradesPerDay: 5,
  gate: gate({}),
};

/** Kiểm tra thêm: đã qua một lần ở 120 lệnh, đang lặp lại 40 / 100; Only these 2 mã → "Effectively 2". */
export const V5: ResearchVersion = {
  // #377: thí nghiệm (API mới); UI chưa dùng.
  hypothesis: null,
  experiment: null,
  ...common,
  id: V5_ID,
  number: 5,
  name: "Majors only",
  status: "paused",
  isBaseline: false,
  createdAt: "2026-11-19T07:00:00.000Z",
  createdBy: "b7c2",
  savedFrom: { id: V4_ID, number: 4 },
  config: majors,
  changedFromPrevious: diffVersionConfig(strict, majors),
  classifier: { current: CUR, segmentStart: "2026-11-19T07:00:00.000Z", used: [CUR] },
  balance: "10105.2",
  available: "10105.2",
  effectiveMaxOpen: 2,
  maxNewTradesPerDay: 5,
  blockedByLimit: 4,
  closed: 160,
  counted: 160,
  avgPct: 0.21,
  gate: gate({
    status: "needs_repeat",
    segmentClosed: 160,
    classifierStatus: "passed",
    labelsToGo: 0,
    firstPassAt: 120,
    repeat: { closed: 40, needed: 100 },
  }),
};

export const V6: ResearchVersion = {
  // #377: thí nghiệm (API mới); UI chưa dùng.
  hypothesis: null,
  experiment: null,
  ...common,
  id: V6_ID,
  number: 6,
  name: "Wider stops",
  status: "stopped",
  isBaseline: false,
  createdAt: "2026-11-19T08:40:00.000Z",
  createdBy: "a91f",
  savedFrom: { id: BASELINE_ID, number: 3 },
  config: wider,
  changedFromPrevious: diffVersionConfig(base, wider),
  classifier: { current: CUR, segmentStart: "2026-11-19T08:40:00.000Z", used: [CUR] },
  balance: "9990.4",
  available: "9990.4",
  blockedByLimit: 2,
  closed: 6,
  counted: 6,
  gate: gate({ status: "collecting", segmentClosed: 6, classifierStatus: "passed", labelsToGo: 0 }),
};

export const VERSIONS: ResearchVersions = researchVersionsSchema.parse({
  items: [V6, V5, V4, BASELINE],
  running: 2,
  maxRunning: 3,
  versionsTried: 4,
  extraCheck: true,
  repeatTrades: 100,
  classifier: {
    current: CUR,
    startedAt: "2026-11-19T06:00:00.000Z",
    labeled: 37,
    precisionPct: 83.78,
    passes: false,
    status: "needsLabels",
    labelsToGo: 13,
  },
});

/** 3 / 3 version đang chạy: nút Save tắt ("Pause or stop a version first."). */
export const VERSIONS_FULL: ResearchVersions = researchVersionsSchema.parse({
  ...VERSIONS,
  items: [{ ...V5, status: "running" }, V4, BASELINE],
  running: 3,
  versionsTried: 3,
  extraCheck: false,
});

export const CLASSIFIERS: ResearchClassifiers = researchClassifiersSchema.parse({
  gate: { minLabels: 50, minPrecisionPct: 80 },
  items: [
    {
      classifierVersion: CUR,
      current: true,
      startedAt: "2026-11-19T06:00:00.000Z",
      signals: 120,
      labeled: 37,
      right: 31,
      traceLabeled: 9,
      precisionPct: 83.78,
      interval: { lo: 68.86, hi: 92.33 },
      passes: false,
      status: "needsLabels",
      labelsToGo: 13,
      mostCommonMistakes: [
        { reason: "person_not_company", n: 3 },
        { reason: "wrong_asset", n: 2 },
        { reason: "passing_mention", n: 1 },
      ],
    },
    {
      classifierVersion: OLD,
      current: false,
      startedAt: "2026-11-17T19:30:00.000Z",
      signals: 80,
      labeled: 24,
      right: 12,
      traceLabeled: 0,
      precisionPct: 50,
      interval: { lo: 31.43, hi: 68.57 },
      passes: false,
      status: "underPrecision",
      labelsToGo: 26,
      mostCommonMistakes: [{ reason: "wrong_type", n: 7 }],
    },
  ],
});

export const MARKETS: ResearchMarkets = researchMarketsSchema.parse({
  items: [
    { market: "BTC-USD", base: "BTC", displayName: "Bitcoin", kind: "crypto", status: "TRADING" },
    { market: "ETH-USD", base: "ETH", displayName: "Ethereum", kind: "crypto", status: "TRADING" },
    { market: "SOL-USD", base: "SOL", displayName: "Solana", kind: "crypto", status: "TRADING" },
    {
      market: "SOLV-USD",
      base: "SOLV",
      displayName: "Solv Protocol",
      kind: "crypto",
      status: "TRADING",
    },
    { market: "XYZ-USD", base: "XYZ", displayName: null, kind: "crypto", status: "HALT" },
    { market: "AAPL-USD", base: "AAPL", displayName: "Apple", kind: "stock", status: "TRADING" },
    { market: "TSLA-USD", base: "TSLA", displayName: "Tesla", kind: "stock", status: "TRADING" },
  ],
  updatedAt: "2026-11-19T08:55:00.000Z",
  stale: false,
});

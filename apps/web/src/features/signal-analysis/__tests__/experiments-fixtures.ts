import {
  baselineVersionConfig,
  changedThings,
  diffVersionConfig,
  researchVersionsSchema,
  type BotVersionConfig,
  type ResearchExperiment,
  type ResearchVersion,
  type ResearchVersions,
} from "@drift/shared";

import { BASELINE, BASELINE_ID, V4 } from "./versions-fixtures";

// Sổ thí nghiệm (#377), theo số mẫu của mockup catalyst-experiments-1440.png: Baseline v3; Running v4 (sạch) và v5 (đổi 2
// thứ, "Not a clean test"); Finished v8 Worse, v7 Better, v6 No clear difference. Giờ UTC; ở Asia/Ho_Chi_Minh khớp ngày.

const base = baselineVersionConfig();
const id = (n: number) => `00000000-0000-4000-8000-0000000000${String(n).padStart(2, "0")}`;

const strict: BotVersionConfig = { ...base, maxSourceDelayMinutes: 20 };
const majors: BotVersionConfig = {
  ...base,
  minLevel: "high",
  assets: { mode: "only", markets: ["BTC-USD", "ETH-USD"], crypto: true, stocks: true },
};
const wider: BotVersionConfig = { ...base, slMultiple: "1.0" };
const late: BotVersionConfig = { ...base, maxSourceDelayMinutes: 10 };
const tighter: BotVersionConfig = { ...base, tpMultiple: "1.2" };

function exp(
  cfg: BotVersionConfig,
  e: Partial<ResearchExperiment> & Pick<ResearchExperiment, "pairs" | "verdict">,
): ResearchExperiment {
  const changes = diffVersionConfig(base, cfg);
  const things = changedThings(changes).length;
  return {
    control: { id: BASELINE_ID, number: 3 },
    changes,
    changedThings: things,
    clean: things === 1,
    needed: 100,
    meanDiffPct: null,
    ciLow: null,
    ciHigh: null,
    clusters: 0,
    finishedAt: null,
    ...e,
  };
}

function version(
  n: number,
  name: string,
  cfg: BotVersionConfig,
  over: Partial<ResearchVersion>,
): ResearchVersion {
  return {
    ...V4,
    id: id(n),
    number: n,
    name,
    config: cfg,
    savedFrom: { id: BASELINE_ID, number: 3 },
    changedFromPrevious: diffVersionConfig(base, cfg),
    ...over,
  };
}

export const E4 = version(4, "Strict subject", strict, {
  status: "running",
  createdAt: "2026-11-19T03:00:00.000Z",
  hypothesis:
    "Trading only articles whose main subject is the asset gives a better result after fees.",
  experiment: exp(strict, { pairs: 18, verdict: "collecting" }),
});
export const E5 = version(5, "Majors only", majors, {
  status: "running",
  createdAt: "2026-11-19T04:00:00.000Z",
  hypothesis: "Trading only BTC and ETH gives a better result after fees.",
  experiment: exp(majors, { pairs: 31, verdict: "collecting" }),
});
export const E6 = version(6, "Wider stops", wider, {
  status: "stopped",
  createdAt: "2026-11-19T05:00:00.000Z",
  hypothesis: "A wider stop loss loses less to noise and gives a better result after fees.",
  experiment: exp(wider, {
    pairs: 100,
    verdict: "no_clear_difference",
    meanDiffPct: "0.02",
    ciLow: "-0.08",
    ciHigh: "0.11",
    clusters: 6,
    finishedAt: "2026-11-25T05:00:00.000Z",
  }),
});
export const E7 = version(7, "Skip late news", late, {
  status: "stopped",
  createdAt: "2026-11-21T05:00:00.000Z",
  hypothesis:
    "Skipping articles that reach DeskLabs more than 10 min late gives a better result after fees.",
  experiment: exp(late, {
    pairs: 100,
    verdict: "better",
    meanDiffPct: "0.14",
    ciLow: "0.03",
    ciHigh: "0.25",
    clusters: 6,
    finishedAt: "2026-11-27T05:00:00.000Z",
  }),
});
export const E8 = version(8, "Tighter take profit", tighter, {
  status: "stopped",
  createdAt: "2026-11-22T05:00:00.000Z",
  hypothesis: "Taking profit earlier gives a better result after fees.",
  experiment: exp(tighter, {
    pairs: 100,
    verdict: "worse",
    meanDiffPct: "-0.12",
    ciLow: "-0.21",
    ciHigh: "-0.04",
    clusters: 6,
    finishedAt: "2026-11-28T05:00:00.000Z",
  }),
});

const classifier = {
  current: "news-classifier-v3",
  startedAt: "2026-11-19T06:00:00.000Z",
  labeled: 50,
  precisionPct: 86,
  passes: true,
  status: "passed",
  labelsToGo: 0,
} as const;

/** Mockup: 3 / 3 chỗ, 2 thí nghiệm chạy, 1 "Not a clean test", 3 Finished; Claude reader đã qua cổng nhãn. */
export const EXPERIMENT_VERSIONS: ResearchVersions = researchVersionsSchema.parse({
  items: [E8, E7, E6, E5, E4, BASELINE],
  running: 3,
  maxRunning: 3,
  versionsTried: 6,
  extraCheck: true,
  repeatTrades: 100,
  classifier,
});

/** Version lưu trước #377 (không có giả thuyết), đang chạy, kết quả như backend trả; Claude reader chưa qua cổng. */
export const OLD_NO_HYPOTHESIS = version(9, "Old rules", wider, {
  status: "running",
  createdAt: "2026-11-18T05:00:00.000Z",
  hypothesis: null,
  experiment: exp(wider, {
    pairs: 120,
    verdict: "better",
    meanDiffPct: "0.1",
    ciLow: "0.02",
    ciHigh: "0.2",
    clusters: 5,
  }),
});

export const EXPERIMENT_VERSIONS_OLD: ResearchVersions = researchVersionsSchema.parse({
  items: [OLD_NO_HYPOTHESIS, BASELINE],
  running: 2,
  maxRunning: 3,
  versionsTried: 2,
  extraCheck: false,
  repeatTrades: 100,
  classifier: {
    ...classifier,
    labeled: 12,
    precisionPct: 75,
    passes: false,
    status: "needsLabels",
    labelsToGo: 38,
  },
});

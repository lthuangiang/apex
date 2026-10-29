import { SODEX_BASE_FEE_PCT } from "../fees";

// Ngưỡng của engine đề xuất (RECO_ENGINE.md mục 10, PROP-01). Product chỉnh ở đây, không sửa code.
// Mọi giá trị ghi "(chỉnh được)" trong tài liệu nằm ở file này.

export const RECO_INPUTS_VERSION = "reco-1";

export const RECO_CONFIG = {
  /** < số vị thế đã đóng này thì coi là người mới, bỏ qua mọi quy tắc dựa trên lịch sử. */
  newTraderMaxClosed: 30,
  eligibility: {
    gridMinRangeScore: 0.6,
    gridMinLevels: 5,
    dcaSigmaMinPct: 1.5,
    dcaSigmaMaxPct: 6,
    futuresDcaMinDropPct: 10,
    recurringBuyAssets: ["BTC", "ETH"],
    rebalancingMinAssets: 2,
    fundingArbMinAvg7dPct: "0.005",
    fundingArbMinPositiveShare21: 0.7,
    fundingArbMinCapital: "2000",
  },
  exclusions: {
    shortHoldingBucket: "<15m",
    marketLossMaxWinRate: 0.4,
    highLeverageLossShare: 0.5,
  },
  goalFit: {
    automate: { futures_grid: 40, spot_grid: 35, futures_dca: 30, spot_dca: 25 },
    range: { spot_grid: 40, futures_grid: 35, spot_dca: 20 },
    accumulate: { recurring_buy: 40, rebalancing: 30, spot_dca: 25 },
    steady: { rebalancing: 40, recurring_buy: 35, spot_grid: 20 },
  },
  fundingArbGoalFit: 25,
  history: { netPositive: 15, holdingPositive: 10, winRate: 5, winRateMin: 0.5 },
  marketFit: { max: 20, dcaSigmaGoodMaxPct: 4, flat: 10, dcaOutside: 10 },
  costFit: { makerHighTaker: 10, other: 5, takerRatioMin: 0.6 },
  maxAddOns: 1,
  split: { best: "0.6", addOn: "0.4" },
  grid: {
    stepMinPct: "0.5",
    stepFeeMultiple: 10,
    levelsMin: 2,
    levelsMax: 200,
    arithmeticMaxSpan: "0.2",
    stopMinPct: 3,
  },
  futures: { trendLong: 0.5, trendShort: -0.5, maxLeverage: 2 },
  dca: {
    firstMinPct: "1",
    stepMultiplier: "1.2",
    sizeMultiplier: "1.5",
    maxSafety: 20,
    tpMinPct: "1.2",
    tpFeeMultiple: 7,
    stopBufferPct: "2",
  },
  recurring: { buys: 20, dayOfWeek: 1, time: "09:00" },
  rebalancing: {
    stableMinPct: 20,
    thresholdLowPct: "5",
    thresholdHighPct: "8",
    sigmaSplitPct: 3,
    maxTradePct: "25",
  },
  fundingArb: { enterPct: "0.005", exitPct: "0", maxGapPct: "0.5", minMarginRatioPct: "30" },
  /**
   * Maker fee cơ bản của SoDEX (%) khi người dùng chưa có fill maker để đo (DEC-39, chờ duyệt). Nguồn: SoDEX
   * support "Trading Experience" (Spot maker 0.04%, Futures maker 0.015%). Phí thực tế theo tier của từng người.
   */
  baseMakerFeePct: { spot: SODEX_BASE_FEE_PCT.spot.maker, perps: SODEX_BASE_FEE_PCT.perps.maker },
  stablecoins: ["USDC", "USDT", "vUSDC", "vUSDT"],
} as const;

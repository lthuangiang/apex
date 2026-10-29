import type { AccountMetrics } from "../analysis/account";

export const RECO_GOALS = ["automate", "range", "accumulate", "steady"] as const;
export type RecoGoal = (typeof RECO_GOALS)[number];
export const MAX_DROP_OPTIONS = ["5", "10", "20", "unsure"] as const;
export type MaxDropOption = (typeof MAX_DROP_OPTIONS)[number];

export interface RecoGoals {
  goal: RecoGoal;
  /** Vốn cho bot (quote). */
  capital: string;
  maxDrop: MaxDropOption;
  /** Tài sản người dùng chọn, ví dụ ["BTC", "ETH"]. */
  assets: readonly string[];
}

export interface MarketRulesInput {
  tickSize: string;
  stepSize: string;
  minQuantity: string;
  minNotional: string;
}

/** Một market của SoDEX kèm thống kê ngày (market_stats_daily) và 31 giá đóng cửa ngày gần nhất. */
export interface RecoMarket {
  market: string;
  engine: "spot" | "perps";
  /** Tài sản gốc, ví dụ "BTC" cho vBTC_vUSDC và BTC-USD. */
  asset: string;
  quote: string;
  lastPrice: string;
  sigma30: number | null;
  p5: string | null;
  p95: string | null;
  trend: number | null;
  rangeScore: number | null;
  /** Funding trung bình 7 ngày, tính bằng % mỗi kỳ (đã đổi từ tỷ lệ thô của SoDEX). */
  fundingAvg7d: string | null;
  fundingPos21: number | null;
  /** Giá đóng cửa ngày, cũ → mới. */
  closes: readonly string[];
  rules: MarketRulesInput;
  maxLeverage: number | null;
}

export interface RecoInput {
  account: AccountMetrics | null;
  goals: RecoGoals;
  markets: readonly RecoMarket[];
  /** Trần đòn bẩy của account (Risk Center); null thì dùng trần của engine. */
  accountLeverageCap: number | null;
  /** Thời điểm tính (ms), truyền vào để kết quả tất định. */
  now: number;
}

export type RecoStrategy =
  | "spot_grid"
  | "futures_grid"
  | "spot_dca"
  | "futures_dca"
  | "recurring_buy"
  | "rebalancing"
  | "funding_arb";

export interface Suggestion {
  id: string;
  strategy: RecoStrategy;
  market: string;
  /** Config đúng schema của chiến lược trong packages/strategies. */
  values: Record<string, unknown>;
  capital: string;
  score: number;
  reasons: string[];
  /** Một câu về dữ liệu thị trường, mô tả giá, không phải lợi nhuận. */
  basis: string;
  computedAt: string;
  inputsVersion: string;
}

export interface NotSuggested {
  title: string;
  reason: string;
}

export interface RecoPlan {
  best: Suggestion | null;
  addOns: Suggestion[];
  notSuggested: NotSuggested[];
  notes: string[];
  capital: string;
  /** Câu khi không có ứng viên nào. */
  empty: string | null;
}

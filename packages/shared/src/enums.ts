// Enum dùng chung (CODING_STANDARDS C2). Nguồn: docs/DOMAIN.md mục 6 và 7.

export const Strategy = {
  spotGrid: "spot_grid",
  futuresGrid: "futures_grid",
  spotDca: "spot_dca",
  futuresDca: "futures_dca",
  recurringBuy: "recurring_buy",
  rebalancing: "rebalancing",
  fundingArb: "funding_arb",
  twap: "twap",
  volumeMaker: "volume_maker",
} as const;
export type Strategy = (typeof Strategy)[keyof typeof Strategy];

export const Engine = {
  spot: "spot",
  perps: "perps",
  spotPerps: "spot_perps",
} as const;
export type Engine = (typeof Engine)[keyof typeof Engine];

// DOMAIN.md mục 7.1.
export const BotState = {
  draft: "draft",
  starting: "starting",
  running: "running",
  pausing: "pausing",
  paused: "paused",
  resuming: "resuming",
  stopping: "stopping",
  stopped: "stopped",
  archived: "archived",
} as const;
export type BotState = (typeof BotState)[keyof typeof BotState];

/** Trạng thái chuyển tiếp: UI giữ nguyên cho tới khi backend xác nhận (quy tắc 1.6). */
export const TRANSITIONAL_BOT_STATES: readonly BotState[] = [
  BotState.starting,
  BotState.pausing,
  BotState.resuming,
  BotState.stopping,
];

export function isTransitionalBotState(state: BotState): boolean {
  return TRANSITIONAL_BOT_STATES.includes(state);
}

// DOMAIN.md mục 7.2.
export const ReasonCode = {
  builderFeeRevoked: "BUILDER_FEE_REVOKED",
  apiKeyExpired: "API_KEY_EXPIRED",
  /** Key còn active và còn hạn nhưng signer không ký được (UI_REVIEW H1, người dùng duyệt 2026-10-29). */
  apiKeyUnusable: "API_KEY_UNUSABLE",
  apiKeyDeleted: "API_KEY_DELETED",
  riskDailyLoss: "RISK_DAILY_LOSS",
  riskDrawdown: "RISK_DRAWDOWN",
  botMaxLoss: "BOT_MAX_LOSS",
  orderRejected: "ORDER_REJECTED",
  insufficientBalance: "INSUFFICIENT_BALANCE",
  stopLoss: "STOP_LOSS",
  takeProfit: "TAKE_PROFIT",
  emergencyHalt: "EMERGENCY_HALT",
  budgetDone: "BUDGET_DONE",
  maxCycles: "MAX_CYCLES",
} as const;
export type ReasonCode = (typeof ReasonCode)[keyof typeof ReasonCode];

export const ReasonScope = { account: "account", bot: "bot" } as const;
export type ReasonScope = (typeof ReasonScope)[keyof typeof ReasonScope];

export interface ReasonCodeMeta {
  outcome: typeof BotState.paused | typeof BotState.stopped;
  scope: ReasonScope;
}

/** Kết quả và phạm vi của từng reason code, chép từ DOMAIN.md mục 7.2. */
export const REASON_CODE_META: Readonly<Record<ReasonCode, ReasonCodeMeta>> = {
  BUILDER_FEE_REVOKED: { outcome: BotState.paused, scope: ReasonScope.account },
  API_KEY_EXPIRED: { outcome: BotState.paused, scope: ReasonScope.account },
  API_KEY_UNUSABLE: { outcome: BotState.paused, scope: ReasonScope.account },
  API_KEY_DELETED: { outcome: BotState.paused, scope: ReasonScope.account },
  RISK_DAILY_LOSS: { outcome: BotState.paused, scope: ReasonScope.account },
  RISK_DRAWDOWN: { outcome: BotState.paused, scope: ReasonScope.account },
  BOT_MAX_LOSS: { outcome: BotState.paused, scope: ReasonScope.bot },
  ORDER_REJECTED: { outcome: BotState.paused, scope: ReasonScope.bot },
  INSUFFICIENT_BALANCE: { outcome: BotState.paused, scope: ReasonScope.bot },
  STOP_LOSS: { outcome: BotState.stopped, scope: ReasonScope.bot },
  TAKE_PROFIT: { outcome: BotState.stopped, scope: ReasonScope.bot },
  EMERGENCY_HALT: { outcome: BotState.stopped, scope: ReasonScope.account },
  BUDGET_DONE: { outcome: BotState.stopped, scope: ReasonScope.bot },
  MAX_CYCLES: { outcome: BotState.stopped, scope: ReasonScope.bot },
};

// DOMAIN.md mục 7.3.
export const OrderStatus = {
  open: "open",
  partiallyFilled: "partially_filled",
  filled: "filled",
  cancelled: "cancelled",
  rejected: "rejected",
  unknown: "unknown",
  notPlaced: "not_placed",
} as const;
export type OrderStatus = (typeof OrderStatus)[keyof typeof OrderStatus];

export const OrderSide = { buy: "buy", sell: "sell" } as const;
export type OrderSide = (typeof OrderSide)[keyof typeof OrderSide];

// DOMAIN.md mục 7.4 và 7.5.
export const ParamSource = { ai: "ai", aiEdited: "ai_edited", manual: "manual" } as const;
export type ParamSource = (typeof ParamSource)[keyof typeof ParamSource];

export const BotVersionStatus = {
  pending: "pending",
  active: "active",
  superseded: "superseded",
  rejected: "rejected",
} as const;
export type BotVersionStatus = (typeof BotVersionStatus)[keyof typeof BotVersionStatus];

export const ApiKeyStatus = { active: "active", expired: "expired", deleted: "deleted" } as const;
export type ApiKeyStatus = (typeof ApiKeyStatus)[keyof typeof ApiKeyStatus];

export const UserRole = { user: "user", team: "team" } as const;
export type UserRole = (typeof UserRole)[keyof typeof UserRole];

export const SodexNetwork = { mainnet: "mainnet", testnet: "testnet" } as const;
export type SodexNetwork = (typeof SodexNetwork)[keyof typeof SodexNetwork];

export const SuggestionContext = {
  onboarding: "onboarding",
  create: "create",
  retune: "retune",
} as const;
export type SuggestionContext = (typeof SuggestionContext)[keyof typeof SuggestionContext];

export const BuilderRevenueStatus = { matched: "matched", pending: "pending" } as const;
export type BuilderRevenueStatus = (typeof BuilderRevenueStatus)[keyof typeof BuilderRevenueStatus];

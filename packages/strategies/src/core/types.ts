import type { ReasonCode } from "@drift/shared";

// Hợp đồng chung của mọi chiến lược (STRATEGIES.md "Quy ước chung"): hàm thuần
// `step(config, state, event, ctx) → { actions, state }`. Không I/O; tiền và giá là chuỗi thập phân.

export type Side = "buy" | "sell";
export type EngineKind = "spot" | "perps";

/** Quy tắc market đọc từ market info SoDEX (không hard-code). */
export interface MarketRules {
  tickSize: string;
  stepSize: string;
  minQuantity: string;
  minNotional: string;
}

export interface OrderIntent {
  clOrdID: string;
  market: string;
  engine: EngineKind;
  side: Side;
  type: "limit" | "market";
  /** Bắt buộc với limit. */
  price?: string;
  quantity: string;
  timeInForce: "GTC" | "IOC" | "GTX";
  reduceOnly: boolean;
  /** Nhãn để chiến lược nhận ra lệnh khi khớp (ví dụ "grid:3:buy"). */
  tag: string;
}

export type StrategyEvent =
  | { type: "tick"; at: number; market: string; price: string }
  | { type: "fill"; at: number; clOrdID: string; price: string; quantity: string; fee: string }
  | { type: "orderAck"; at: number; clOrdID: string }
  | { type: "orderReject"; at: number; clOrdID: string; code: string }
  | { type: "timer"; at: number }
  | { type: "fundingPaid"; at: number; market: string; amount: string }
  /** Funding của market (engine lấy từ market_stats / marketdata). */
  | { type: "fundingRate"; at: number; market: string; current: string; avg7d: string | null }
  /** Margin ratio của account Perps (tỷ lệ thô). */
  | { type: "marginRatio"; at: number; ratio: string };

export type StrategyAction =
  | { type: "place"; order: OrderIntent }
  | { type: "cancel"; clOrdID: string }
  | { type: "pause"; reason: ReasonCode }
  | { type: "stop"; reason: ReasonCode; close: boolean }
  | { type: "flag"; needsAttention: boolean }
  /** Một dòng "Decisions & actions" (bot_events). */
  | { type: "log"; decision: string; why: string };

export interface StepContext {
  botId: string;
  version: number;
  rules: Record<string, MarketRules>;
  /** Phí một chiều (tỷ lệ thô, ví dụ "0.0005") dùng để kiểm tra bước grid / TP. */
  feeRate: string;
}

export interface StepResult<S> {
  actions: StrategyAction[];
  state: S;
}

export type StepFn<C, S> = (
  config: C,
  state: S,
  event: StrategyEvent,
  ctx: StepContext,
) => StepResult<S>;

export interface StrategyModule<C, S> {
  initialState: (config: C) => S;
  step: StepFn<C, S>;
}

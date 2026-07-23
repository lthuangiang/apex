import type { BotSharedState } from './BotSharedState.js';

/**
 * Represents the state of a single leg in a hedge pair
 */
export interface LegState {
  symbol: string;
  side: 'long' | 'short';
  size: number;
  entryPrice: number;
  unrealizedPnl: number;
}

/**
 * Represents an active pair of hedge legs (long + short)
 */
export interface ActiveLegPair {
  legA: LegState;
  legB: LegState;
  entryTimestamp: string;
  combinedPnl: number;
}

/**
 * Shared state for a PairBot instance
 * Extends BotSharedState with pair-trading-specific fields
 */
export interface PairBotSharedState extends BotSharedState {
  hedgePosition: ActiveLegPair | null;
  hedgeBotState: 'IDLE' | 'OPENING' | 'WAITING_FILL' | 'IN_PAIR' | 'CLOSING' | 'COOLDOWN';
}

/**
 * Status object returned by PairBot.getStatus()
 * Compatible with BotStatus but includes hedgePosition instead of openPosition
 */
export interface PairBotStatus {
  id: string;
  name: string;
  exchange: string;
  status: 'active' | 'inactive' | 'paused';
  symbol: string;          // set to "symbolA/symbolB" for display
  tags: string[];
  sessionPnl: number;
  sessionVolume: number;
  sessionFees: number;
  efficiencyBps: number;
  costPerMillion: number;
  walletAddress: string;
  uptime: number;          // minutes
  hasPosition: boolean;
  openPosition: null;      // always null — hedge uses hedgePosition instead
  progress: number;        // 0-100

  // Hedge-specific extension
  hedgePosition: ActiveLegPair | null;
}

/**
 * Trade log record for a completed pair trade cycle
 * Written via TradeLogger after each AtomicClose
 */
export interface PairTradeRecord {
  id: string;
  botId: string;
  timestamp: string;           // exit time (ISO 8601)
  exchange: string;
  symbolA: string;
  symbolB: string;
  legValueUsd: number;
  entryPriceA: number;
  entryPriceB: number;
  exitPriceA: number;
  exitPriceB: number;
  sizeA: number;
  sizeB: number;
  pnlA: number;
  pnlB: number;
  combinedPnl: number;
  holdDurationSecs: number;
  exitReason: 'PROFIT_TARGET' | 'MAX_LOSS' | 'MEAN_REVERSION' | 'TIME_EXPIRY' | 'FORCE';
  entryTimestamp: string;
  exitTimestamp: string;
  signalScoreA: number;
  signalScoreB: number;
  longSymbol: string;
  shortSymbol: string;
}

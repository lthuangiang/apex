import type { OpenPositionState } from '../ai/sharedState.js';

/**
 * Bot configuration interface
 * Defines all settings needed to create and run a bot instance
 */
export interface BotConfig {
  // Identity
  id: string;                    // e.g. "sodex-bot", "dango-bot"
  name: string;                  // Display name: "Bot SoDEX"
  exchange: 'sodex' | 'dango' | 'decibel';
  symbol: string;                // e.g. "BTC-USD"
  tags: string[];                // e.g. ["TWAP", "Aggressive"]
  autoStart: boolean;

  // Trading config
  mode: 'farm' | 'trade';
  orderSizeMin: number;
  orderSizeMax: number;

  // Credentials (env var prefix)
  credentialKey: string;         // e.g. "SODEX" → reads SODEX_API_KEY, SODEX_API_SECRET

  // Logging
  tradeLogBackend: 'json' | 'sqlite';
  tradeLogPath: string;          // e.g. "./trades-sodex.json"
  
  // Optional overridable fields (for config persistence)
  farmMinHoldSecs?: number;
  farmMaxHoldSecs?: number;
  farmTpUsd?: number;
  farmSlPercent?: number;
  farmScoreEdge?: number;
  farmMinConfidence?: number;
  farmEarlyExitSecs?: number;
  farmEarlyExitPnl?: number;
  farmExtraWaitSecs?: number;
  farmBlockedHours?: string;
  farmCooldownSecs?: number;
  tradeTpPercent?: number;
  tradeSlPercent?: number;
  cooldownMinMins?: number;
  cooldownMaxMins?: number;
  minPositionValueUsd?: number;
}

/**
 * Bot status interface
 * Data returned by API for dashboard display
 */
export interface BotStatus {
  id: string;
  name: string;
  exchange: string;
  status: 'active' | 'inactive';
  symbol: string;
  tags: string[];
  sessionPnl: number;
  sessionVolume: number;
  sessionFees: number;
  efficiencyBps: number;
  walletAddress: string;
  uptime: number;              // minutes
  hasPosition: boolean;
  openPosition: OpenPositionState | null;
  progress: number;            // 0-100
}

/**
 * HedgeBot configuration interface
 * Defines all settings needed to create and run a Correlation Hedging Bot instance
 */
export interface HedgeBotConfig {
  // Identity
  id: string;
  name: string;
  botType: 'hedge';                          // discriminant field
  exchange: 'sodex' | 'dango' | 'decibel';
  tags: string[];
  autoStart: boolean;
  credentialKey: string;

  // Logging
  tradeLogBackend: 'json' | 'sqlite';
  tradeLogPath: string;

  // Hedge-specific
  symbolA: string;                           // e.g. "BTC-USD"
  symbolB: string;                           // e.g. "ETH-USD"
  legValueUsd: number;                       // USD notional per leg
  holdingPeriodSecs: number;                 // max hold time before TIME_EXPIRY
  profitTargetUsd: number;                   // CombinedPnL threshold for PROFIT_TARGET
  maxLossUsd: number;                        // CombinedPnL threshold for MAX_LOSS
  volumeSpikeMultiplier: number;             // e.g. 2.0 = 2× rolling average
  volumeRollingWindow: number;               // number of samples in rolling window
  fundingRateWeight: number;                 // 0–1, weight for funding rate adjustment
  cooldownSecs?: number;                     // post-close cooldown (default: 30)
}

/**
 * Aggregated statistics across all bots
 */
export interface AggregatedStats {
  totalVolume: number;
  activeBotCount: number;
  totalFees: number;
  totalPnl: number;
}

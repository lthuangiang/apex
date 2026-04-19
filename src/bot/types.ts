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
 * Aggregated statistics across all bots
 */
export interface AggregatedStats {
  totalVolume: number;
  activeBotCount: number;
  totalFees: number;
  totalPnl: number;
}

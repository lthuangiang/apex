import type { BotSharedState } from './BotSharedState.js';

// ── Configuration ─────────────────────────────────────────────────────────────

/**
 * Supported exchanges for Delta-Neutral farming.
 * Primary leg earns OI points; hedge leg neutralizes directional risk.
 */
export type DeltaNeutralExchange = 'sodex' | 'dango' | 'decibel' | 'hibachi' | 'ondoperps' | 'perpl';

/**
 * DeltaNeutralBot configuration — stored in bot-configs.json under botType: "delta-neutral"
 *
 * Key difference from PairBotConfig: uses TWO different exchanges (cross-exchange)
 * so the primary leg can accumulate OI points on the target exchange while the
 * hedge leg neutralizes directional risk on a separate venue.
 */
export interface DeltaNeutralConfig {
  // Identity
  id: string;
  name: string;
  botType: 'delta-neutral' | 'oi-farmer';       // discriminant field ('oi-farmer' kept for backward compat)
  tags: string[];
  autoStart: boolean;

  // Logging
  tradeLogBackend: 'json' | 'sqlite';
  tradeLogPath: string;

  // ── Cross-Exchange Legs ─────────────────────────────────────────────────────
  // Primary leg: the exchange where OI earns points (e.g. Perpl)
  exchangeA: DeltaNeutralExchange;
  credentialKeyA: string;                        // env var prefix for primary exchange

  // Hedge leg: the exchange used to neutralize directional risk (e.g. Ondo, SoDEX)
  exchangeB: DeltaNeutralExchange;
  credentialKeyB: string;                        // env var prefix for hedge exchange

  // ── Position Parameters ─────────────────────────────────────────────────────
  symbol: string;                                // same symbol on both exchanges (e.g. "NVDA-USD")
  /** Symbol override for exchangeA if naming differs (e.g. "NVDA-PERP" on Perpl) */
  symbolA?: string;
  /** Symbol override for exchangeB if naming differs (e.g. "NVDAUSD" on Ondo) */
  symbolB?: string;
  legValueUsd: number;                           // USD notional per leg (legacy/fixed mode)
  /** Min notional USD for leg A (random between min-max, leg B auto-matches) */
  orderSizeMinUsd?: number;
  /** Max notional USD for leg A */
  orderSizeMaxUsd?: number;
  leverage?: number;                             // target leverage (default: 5)

  // ── Direction ───────────────────────────────────────────────────────────────
  /** Which direction to take on the primary (points) exchange.
   *  'long' = long on exchangeA, short on exchangeB
   *  'short' = short on exchangeA, long on exchangeB
   *  'auto' = choose based on funding rate (short on positive funding side)
   */
  primaryDirection: 'long' | 'short' | 'auto';

  // ── Hold & Exit Rules ───────────────────────────────────────────────────────
  /** Minimum hold time in seconds before allowing voluntary exit (default: 14400 = 4h) */
  minHoldSecs: number;
  /** Maximum hold time in seconds before forced rotation (default: 259200 = 72h) */
  maxHoldSecs: number;
  /** Max unrealized loss (USD) on combined position before emergency exit */
  maxLossUsd: number;
  /** Take profit: exit when combined PnL >= this USD amount AND holding time > minHoldSecs (0 = disabled) */
  takeProfitUsd?: number;
  /** Max delta divergence (USD) between legs before rebalance trigger */
  maxDeltaDivergenceUsd: number;

  // ── Funding Rate ────────────────────────────────────────────────────────────
  /** If funding rate on primary leg exceeds this (per-period), flip direction or exit.
   *  e.g. 0.001 = 0.1% per funding period. Default: 0.005 (0.5%) */
  maxFundingRateThreshold: number;
  /** Auto-flip direction when funding becomes unfavorable (default: false) */
  autoFlipOnFunding: boolean;
  /** Seconds to wait for funding rate data before falling back to default direction.
   *  Only applies when primaryDirection = 'auto'. Retries every 5s. Default: 30 */
  fundingFetchTimeoutSecs?: number;

  // ── Rebalance ───────────────────────────────────────────────────────────────
  /** Check interval in seconds for health monitoring (default: 60) */
  tickIntervalSecs: number;
  /** Cooldown in seconds after a close before re-opening (default: 300) */
  cooldownSecs: number;

  // ── Entry Execution Strategy ────────────────────────────────────────────────
  /** Entry mode: 'taker' = IOC market orders (fast, higher fees),
   *  'maker-chunked' = split into PostOnly chunks (slower, ~70% less fees) */
  entryMode?: 'taker' | 'maker-chunked';
  /** USD value per chunk when using maker-chunked mode (default: 100) */
  chunkSizeUsd?: number;
  /** Seconds to wait for each chunk fill before cancel+retry (default: 30) */
  chunkTimeoutSecs?: number;
  /** Max maker attempts per chunk before escalating to taker (default: 3) */
  maxMakerAttempts?: number;
  /** Hard deadline in seconds for total entry — taker all remaining (default: 300) */
  maxTotalEntryTimeSecs?: number;
}

// ── State Machine ─────────────────────────────────────────────────────────────

export type DeltaNeutralBotState =
  | 'IDLE'          // No position, waiting to enter
  | 'OPENING'       // Placing entry orders on both legs
  | 'WAITING_FILL'  // Orders placed, waiting for fills
  | 'ACTIVE'        // Both legs filled, holding delta-neutral position
  | 'REBALANCING'   // Adjusting leg sizes due to delta drift
  | 'CLOSING'       // Placing close orders on both legs
  | 'COOLDOWN';     // Post-close waiting period

// ── Leg State ─────────────────────────────────────────────────────────────────

export interface DeltaNeutralLegState {
  exchange: DeltaNeutralExchange;
  symbol: string;
  side: 'long' | 'short';
  size: number;
  entryPrice: number;
  currentPrice: number;
  unrealizedPnl: number;
  /** Notional value = size × currentPrice */
  notionalUsd: number;
}

// ── Active Position ───────────────────────────────────────────────────────────

export interface DeltaNeutralPosition {
  primaryLeg: DeltaNeutralLegState;       // The leg earning OI points
  hedgeLeg: DeltaNeutralLegState;         // The hedge leg
  entryTimestamp: string;             // ISO 8601
  combinedPnl: number;               // primaryLeg.pnl + hedgeLeg.pnl
  /** Net USD exposure: |primaryNotional - hedgeNotional| */
  deltaExposureUsd: number;
  /** Cumulative OI contribution: notional × hours held */
  oiHoursAccumulated: number;
  /** Funding received/paid since entry (positive = received) */
  netFundingUsd: number;
}

// ── Shared State ──────────────────────────────────────────────────────────────

export interface DeltaNeutralSharedState extends BotSharedState {
  oiFarmerState: DeltaNeutralBotState;
  position: DeltaNeutralPosition | null;

  // ── OI Farming Metrics ────────────────────────────────────────────────────
  /** Total OI-hours accumulated this session (notional × hours) */
  totalOiHours: number;
  /** Total funding received this session (USD) */
  totalFundingReceived: number;
  /** Total funding paid this session (USD) */
  totalFundingPaid: number;
  /** Number of completed hold cycles this session */
  completedCycles: number;
  /** Average hold duration across completed cycles (seconds) */
  avgHoldDurationSecs: number;
  /** Cost Per Million OI-hours (USD) — key efficiency metric */
  cpmUsd: number;
}

// ── Status (for dashboard) ────────────────────────────────────────────────────

export interface DeltaNeutralStatus {
  id: string;
  name: string;
  botType: 'delta-neutral' | 'oi-farmer';
  exchangeA: string;
  exchangeB: string;
  maxHoldSecs: number;
  status: 'active' | 'inactive' | 'paused';
  symbol: string;
  tags: string[];
  sessionPnl: number;
  sessionVolume: number;
  sessionFees: number;
  efficiencyBps: number;
  costPerMillion: number;
  walletAddress: string;
  uptime: number;                    // minutes
  hasPosition: boolean;
  openPosition: null;                // not used — uses position field instead
  progress: number;                  // 0-100

  // OI Farmer / Delta-Neutral specific
  oiFarmerState: DeltaNeutralBotState;
  position: DeltaNeutralPosition | null;
  totalOiHours: number;
  cpmUsd: number;
  totalFundingReceived: number;
  totalFundingPaid: number;
  completedCycles: number;
  recentTrades?: Array<{
    time: string;
    holdMins: number;
    pnlA: number;
    pnlB: number;
    combined: number;
    reason: string;
  }>;
}

// ── Trade Record ──────────────────────────────────────────────────────────────

export interface DeltaNeutralTradeRecord {
  id: string;
  botId: string;
  timestamp: string;                 // exit time (ISO 8601)
  exchangeA: string;
  exchangeB: string;
  symbol: string;
  legValueUsd: number;
  primarySide: 'long' | 'short';

  // Entry
  entryPriceA: number;
  entryPriceB: number;
  sizeA: number;
  sizeB: number;
  entryTimestamp: string;

  // Exit
  exitPriceA: number;
  exitPriceB: number;
  exitTimestamp: string;
  exitReason: DeltaNeutralExitReason;

  // P&L
  pnlA: number;
  pnlB: number;
  combinedPnl: number;
  netFundingUsd: number;
  totalFeesUsd: number;

  // OI Metrics
  holdDurationSecs: number;
  oiHours: number;                   // notional × hours for this cycle
  cpmUsd: number;                    // cost per million for this cycle
}

export type DeltaNeutralExitReason =
  | 'MAX_HOLD'         // maxHoldSecs reached — normal rotation
  | 'MAX_LOSS'         // maxLossUsd breached — emergency exit
  | 'TAKE_PROFIT'      // combined PnL >= takeProfitUsd target
  | 'FUNDING_FLIP'     // funding rate became unfavorable
  | 'MANUAL'           // user-triggered stop
  | 'DELTA_DIVERGE'    // legs diverged beyond threshold
  | 'MARGIN_RISK';     // margin ratio too low on one leg

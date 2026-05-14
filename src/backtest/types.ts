/**
 * Backtest / Dry-Run Engine — Shared Types
 *
 * All shared interfaces, types, and error classes for the backtesting system.
 *
 * Requirements: 1.4, 1.5, 2.13, 3.6, 3.10, 8.1–8.8
 */

// ---------------------------------------------------------------------------
// Re-exports from ExchangeAdapter
// ---------------------------------------------------------------------------

export type { Kline, Order, Position, RawTrade } from '../adapters/ExchangeAdapter.js';

// ---------------------------------------------------------------------------
// FillMode
// ---------------------------------------------------------------------------

/**
 * Controls how simulated order fills are priced.
 *
 * - `optimistic`  — fill at the exact limit price (best case)
 * - `realistic`   — fill at the candle close price (default)
 * - `pessimistic` — fill with slippage applied (worst case)
 *
 * Requirement 8.4, 8.5
 */
export type FillMode = 'optimistic' | 'realistic' | 'pessimistic';

// ---------------------------------------------------------------------------
// BacktestAdapterConfig
// ---------------------------------------------------------------------------

/**
 * Configuration for the BacktestAdapter simulation parameters.
 *
 * Requirements: 8.1–8.5
 */
export interface BacktestAdapterConfig {
  /** Maker fee in basis points (0–10000). e.g. 10 = 0.1% */
  makerFeeBps: number;
  /** Taker fee in basis points (0–10000). e.g. 15 = 0.15% */
  takerFeeBps: number;
  /** Simulated slippage in basis points (0–10000). e.g. 5 = 0.05% */
  slippageBps: number;
  /**
   * Fill mode for order simulation.
   * Defaults to `'realistic'` if not specified.
   * Requirement 8.5
   */
  fillMode: FillMode;
}

// ---------------------------------------------------------------------------
// BacktestRunConfig
// ---------------------------------------------------------------------------

/**
 * Input configuration for a single backtest run.
 *
 * Requirements: 8.1–8.12
 */
export interface BacktestRunConfig {
  /** Existing bot config ID to test, OR provide `botConfig` inline. */
  botId: string;
  /** Optional inline bot config override (takes precedence over `botId` lookup). */
  botConfig?: Record<string, unknown>;

  /** Start of the backtest period (ISO date string, e.g. "2024-01-01"). */
  from: string;
  /** End of the backtest period (ISO date string, e.g. "2024-03-31"). */
  to: string;
  /**
   * Candle interval.
   * Requirement 8.7
   */
  interval: '1m' | '5m' | '15m' | '1h' | '4h' | '1d';

  /**
   * Starting simulated balance in USD.
   * Valid range: [0.01, 1_000_000_000].
   * Requirement 8.6
   */
  initialBalance: number;
  /**
   * Maker fee in basis points (0–10000).
   * Requirement 8.1
   */
  makerFeeBps: number;
  /**
   * Taker fee in basis points (0–10000).
   * Requirement 8.2
   */
  takerFeeBps: number;
  /**
   * Simulated slippage in basis points (0–10000).
   * Requirement 8.3
   */
  slippageBps: number;

  /**
   * Data source preference.
   * - `local`        — only use local cached files
   * - `exchange_api` — always fetch from exchange REST API
   * - `auto`         — use local if available, otherwise fetch from API
   * Requirement 8.8
   */
  dataSource: 'local' | 'exchange_api' | 'auto';

  /**
   * Fill mode for order simulation.
   * Defaults to `'realistic'` if not specified.
   * Requirement 8.4, 8.5
   */
  fillMode?: FillMode;

  /**
   * Speed multiplier for the tick loop.
   * - `0` or omitted → maximum speed (no artificial delay)
   * - `> 0` → delay of `(candleIntervalMs / speedMultiplier)` between ticks
   * Requirement 4.5, 4.6
   */
  speedMultiplier?: number;
}

// ---------------------------------------------------------------------------
// SimulatedTrade
// ---------------------------------------------------------------------------

/**
 * A completed simulated trade record produced by the BacktestAdapter.
 *
 * Requirements: 2.9, 2.11, 5.10
 */
export interface SimulatedTrade {
  /** Unique trade ID. */
  id: string;
  /** Trading symbol, e.g. "BTC-USD". */
  symbol: string;
  /** Direction of the trade. */
  side: 'long' | 'short';
  /** Price at which the position was entered. */
  entryPrice: number;
  /** Price at which the position was exited. */
  exitPrice: number;
  /** Position size (base asset units). */
  size: number;
  /** ISO timestamp of entry fill. */
  entryTime: string;
  /** ISO timestamp of exit fill. */
  exitTime: string;
  /** Duration of the trade in seconds. */
  holdingPeriodSecs: number;
  /** PnL before fees. */
  grossPnl: number;
  /**
   * PnL after fees.
   * Invariant: `netPnl === grossPnl - feePaid`
   * Requirement 5.10
   */
  netPnl: number;
  /** Total fees paid for this trade (entry + exit). */
  feePaid: number;
  /**
   * Reason the trade was closed.
   * e.g. 'PROFIT_TARGET' | 'MAX_LOSS' | 'TIME_EXPIRY' | 'SIGNAL'
   */
  exitReason: string;
}

// ---------------------------------------------------------------------------
// BalanceSnapshot
// ---------------------------------------------------------------------------

/**
 * A point-in-time snapshot of the simulated account state.
 * One snapshot is recorded per candle processed.
 *
 * Requirements: 4.3, 4.4, 5.9
 */
export interface BalanceSnapshot {
  /** ISO timestamp of the candle this snapshot corresponds to. */
  timestamp: string;
  /** Current simulated cash balance (USD). */
  balance: number;
  /** Equity = balance + unrealized PnL across all open positions. */
  equity: number;
  /** Drawdown from peak equity observed so far (minimum 0). */
  drawdown: number;
}

// ---------------------------------------------------------------------------
// PendingOrder
// ---------------------------------------------------------------------------

/**
 * An order that has been placed by the bot but not yet filled.
 * Stored internally by BacktestAdapter.
 *
 * Requirements: 1.4, 2.12
 */
export interface PendingOrder {
  /** Unique order ID (UUID). */
  id: string;
  /** Trading symbol. */
  symbol: string;
  /** Order side. */
  side: 'buy' | 'sell';
  /** Limit price. */
  price: number;
  /** Order size (base asset units). */
  size: number;
  /** Whether this is a reduce-only order. */
  reduceOnly: boolean;
  /**
   * The candle index at which this order was placed.
   * Used to enforce fill monotonicity (Requirement 2.12):
   * an order placed at index `i` cannot fill during the same `advanceTo` call.
   */
  placedAtCandleIndex: number;
  /** ISO timestamp when the order was placed. */
  placedAt: string;
}

// ---------------------------------------------------------------------------
// BacktestProgress
// ---------------------------------------------------------------------------

/**
 * Progress event emitted by BacktestRunner during execution.
 * Delivered via SSE to the dashboard UI.
 *
 * Requirements: 6.7, 7.3
 */
export interface BacktestProgress {
  /** The run ID this progress event belongs to. */
  runId: string;
  /** Number of candles processed so far. */
  processed: number;
  /** Total number of candles to process. */
  total: number;
  /** Current simulated cash balance. */
  currentBalance: number;
  /** Current equity (balance + unrealized PnL). */
  currentEquity: number;
  /** Percentage complete (0–100). */
  percentComplete: number;
}

// ---------------------------------------------------------------------------
// BacktestMetrics
// ---------------------------------------------------------------------------

/**
 * Aggregated performance metrics for a completed backtest run.
 *
 * Requirements: 5.1–5.11
 */
export interface BacktestMetrics {
  /** Total net PnL across all trades (USD). */
  totalPnl: number;
  /** Total net PnL as a percentage of initial balance. */
  totalPnlPercent: number;
  /**
   * Fraction of trades with netPnl > 0.
   * Invariant: 0 ≤ winRate ≤ 1
   * Requirement 5.2, 5.3
   */
  winRate: number;
  /** Total number of completed trades. */
  totalTrades: number;
  /** Number of trades with netPnl > 0. */
  winningTrades: number;
  /** Number of trades with netPnl ≤ 0. */
  losingTrades: number;
  /**
   * Maximum peak-to-trough equity decline (USD).
   * Invariant: maxDrawdown ≥ 0
   * Requirement 5.4
   */
  maxDrawdown: number;
  /** Max drawdown as a percentage of peak equity. */
  maxDrawdownPercent: number;
  /**
   * Annualised Sharpe ratio.
   * = (meanDailyReturn / stdDevDailyReturn) * sqrt(252)
   * Returns 0 if fewer than 2 calendar days of data.
   * Requirement 5.5
   */
  sharpeRatio: number;
  /**
   * Gross profit / |gross loss|.
   * Returns Infinity if no losing trades and gross profit > 0.
   * Returns 0 if no winning trades or no trades.
   * Requirement 5.6
   */
  profitFactor: number;
  /** Average net PnL per trade (USD). */
  avgTradeReturn: number;
  /** Average trade duration in seconds. */
  avgHoldingPeriodSecs: number;
  /** Sum of all fees paid across all trades (USD). */
  totalFeesPaid: number;
  /** Total notional volume traded (USD). */
  totalVolume: number;
}

// ---------------------------------------------------------------------------
// BacktestResult
// ---------------------------------------------------------------------------

/**
 * The complete output of a backtest run.
 *
 * Requirements: 4.10, 4.11, 5.1–5.11, 6.5, 6.7
 */
export interface BacktestResult {
  /** Unique identifier for this run. */
  runId: string;
  /** Terminal status of the run. */
  status: 'completed' | 'aborted' | 'error';
  /** The configuration used for this run. */
  config: BacktestRunConfig;

  /** Aggregated performance metrics. */
  metrics: BacktestMetrics;

  /**
   * Equity curve — one entry per candle processed.
   * Invariant: equityCurve.length === candlesProcessed
   * Requirement 5.9
   */
  equityCurve: BalanceSnapshot[];

  /**
   * Trade-by-trade log, sorted ascending by entryTime.
   * Requirement 5.8
   */
  trades: SimulatedTrade[];

  /** ISO timestamp when the run started. */
  startedAt: string;
  /** ISO timestamp when the run completed or was aborted. */
  completedAt: string;
  /** Number of candles processed before completion/abort. */
  candlesProcessed: number;
  /** Wall-clock duration of the run in milliseconds. */
  durationMs: number;

  /**
   * Error message if status is `'error'`.
   * Requirement 4.2, 9.1, 9.6
   */
  error?: string;

  /**
   * Per-candle errors encountered during the tick loop.
   * Requirement 4.9, 9.4
   */
  errors?: Array<{
    /** ISO timestamp of the candle that caused the error. */
    candleTimestamp: string;
    /** Error message. */
    message: string;
  }>;

  /**
   * Data quality information.
   * Requirement 9.3
   */
  dataQuality?: {
    /** Number of data gaps detected in the OHLCV series. */
    gapCount: number;
  };
}

// ---------------------------------------------------------------------------
// Error Classes
// ---------------------------------------------------------------------------

/**
 * Thrown when `place_limit_order` is called with invalid parameters
 * (price ≤ 0 or size ≤ 0).
 *
 * Requirement 1.5, 2.13
 */
export class InvalidOrderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidOrderError';
    // Maintain proper prototype chain in transpiled ES5
    Object.setPrototypeOf(this, InvalidOrderError.prototype);
  }
}

/**
 * Thrown when a fill would cause the simulated balance to go negative.
 * The order is left in the pending queue; balance and position are unchanged.
 *
 * Requirement 2.13
 */
export class InsufficientBalanceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InsufficientBalanceError';
    Object.setPrototypeOf(this, InsufficientBalanceError.prototype);
  }
}

/**
 * Thrown by `HistoricalDataFeed.loadKlines()` when no data is found
 * for the requested symbol, interval, and date range from any source.
 *
 * Requirement 3.6
 */
export class NoDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NoDataError';
    Object.setPrototypeOf(this, NoDataError.prototype);
  }
}

/**
 * Thrown by `HistoricalDataFeed` when the exchange REST API returns
 * an HTTP error during data fetch.
 *
 * Requirement 3.10
 */
export class DataFetchError extends Error {
  /** HTTP status code returned by the exchange API. */
  readonly statusCode: number;

  constructor(message: string, statusCode: number) {
    super(message);
    this.name = 'DataFetchError';
    this.statusCode = statusCode;
    Object.setPrototypeOf(this, DataFetchError.prototype);
  }
}

/**
 * Thrown by `HistoricalDataFeed` when loading klines exceeds the
 * 10-second timeout threshold.
 *
 * Requirement 10.4
 */
export class LoadTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LoadTimeoutError';
    Object.setPrototypeOf(this, LoadTimeoutError.prototype);
  }
}

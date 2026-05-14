/**
 * BacktestMetricsCollector
 *
 * Collects equity curve snapshots and trade records during a backtest run,
 * then computes all performance metrics when `finalize()` is called.
 *
 * Requirements: 5.1–5.11
 */

import type {
  BacktestRunConfig,
  BacktestResult,
  BacktestMetrics,
  BalanceSnapshot,
  SimulatedTrade,
} from './types.js';

export class BacktestMetricsCollector {
  private readonly runId: string;
  private readonly config: BacktestRunConfig;
  private readonly startedAt: string;

  /** Equity curve — one entry per `recordTick()` call, in recording order. */
  private equityCurve: BalanceSnapshot[] = [];

  /** Trade log — appended via `recordTrade()`. */
  private tradeLog: SimulatedTrade[] = [];

  constructor(runId: string, config: BacktestRunConfig) {
    this.runId = runId;
    this.config = config;
    this.startedAt = new Date().toISOString();
  }

  // ---------------------------------------------------------------------------
  // Recording
  // ---------------------------------------------------------------------------

  /**
   * Append a balance snapshot to the equity curve.
   * Called once per candle processed by the BacktestRunner.
   *
   * Requirement 5.9
   */
  recordTick(snapshot: BalanceSnapshot): void {
    this.equityCurve.push(snapshot);
  }

  /**
   * Append a completed simulated trade to the trade log.
   *
   * Requirement 5.8
   */
  recordTrade(trade: SimulatedTrade): void {
    this.tradeLog.push(trade);
  }

  // ---------------------------------------------------------------------------
  // Finalization
  // ---------------------------------------------------------------------------

  /**
   * Compute all performance metrics and return the complete `BacktestResult`.
   *
   * If called before any `recordTick()` call, returns a zero-value result.
   *
   * Requirement 5.1–5.11
   */
  finalize(): BacktestResult {
    const completedAt = new Date().toISOString();
    const startedAtMs = new Date(this.startedAt).getTime();
    const completedAtMs = new Date(completedAt).getTime();

    // Requirement 5.11 — zero-value result if no ticks recorded
    if (this.equityCurve.length === 0) {
      return this._zeroResult(completedAt, completedAtMs - startedAtMs);
    }

    const trades = this._sortedTrades();
    const metrics = this._computeMetrics(trades, this.equityCurve);

    return {
      runId: this.runId,
      status: 'completed',
      config: this.config,
      metrics,
      equityCurve: [...this.equityCurve],
      trades,
      startedAt: this.startedAt,
      completedAt,
      candlesProcessed: this.equityCurve.length,
      durationMs: completedAtMs - startedAtMs,
    };
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Returns trades sorted ascending by `entryTime`.
   * Requirement 5.8
   */
  private _sortedTrades(): SimulatedTrade[] {
    return [...this.tradeLog].sort(
      (a, b) => new Date(a.entryTime).getTime() - new Date(b.entryTime).getTime(),
    );
  }

  /**
   * Compute all `BacktestMetrics` from the trade log and equity curve.
   */
  private _computeMetrics(
    trades: SimulatedTrade[],
    equityCurve: BalanceSnapshot[],
  ): BacktestMetrics {
    // -------------------------------------------------------------------------
    // Basic trade stats
    // -------------------------------------------------------------------------
    const totalTrades = trades.length;
    const winningTrades = trades.filter((t) => t.netPnl > 0);
    const losingTrades = trades.filter((t) => t.netPnl <= 0);

    // Requirement 5.1 — totalPnl = Σ(trade.netPnl)
    const totalPnl = trades.reduce((sum, t) => sum + t.netPnl, 0);

    // Requirement 5.2, 5.3 — winRate = winningTrades / totalTrades; 0 if no trades
    const winRate = totalTrades > 0 ? winningTrades.length / totalTrades : 0;

    // Requirement 5.7 — totalFeesPaid = Σ(trade.feePaid)
    const totalFeesPaid = trades.reduce((sum, t) => sum + t.feePaid, 0);

    // -------------------------------------------------------------------------
    // Drawdown (Requirement 5.4)
    // -------------------------------------------------------------------------
    let peakEquity = equityCurve[0].equity;
    let maxDrawdown = 0;
    for (const snapshot of equityCurve) {
      if (snapshot.equity > peakEquity) {
        peakEquity = snapshot.equity;
      }
      const drawdown = peakEquity - snapshot.equity;
      if (drawdown > maxDrawdown) {
        maxDrawdown = drawdown;
      }
    }
    const maxDrawdownPercent = peakEquity > 0 ? (maxDrawdown / peakEquity) * 100 : 0;

    // -------------------------------------------------------------------------
    // Sharpe ratio (Requirement 5.5)
    // -------------------------------------------------------------------------
    const sharpeRatio = this._computeSharpeRatio(equityCurve);

    // -------------------------------------------------------------------------
    // Profit factor (Requirement 5.6)
    // -------------------------------------------------------------------------
    const grossProfit = winningTrades.reduce((sum, t) => sum + t.netPnl, 0);
    const grossLoss = Math.abs(losingTrades.reduce((sum, t) => sum + t.netPnl, 0));

    let profitFactor: number;
    if (totalTrades === 0 || winningTrades.length === 0) {
      profitFactor = 0;
    } else if (losingTrades.length === 0) {
      // No losers and gross profit > 0 → Infinity
      profitFactor = grossProfit > 0 ? Infinity : 0;
    } else {
      profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;
    }

    // -------------------------------------------------------------------------
    // Derived metrics
    // -------------------------------------------------------------------------
    const initialBalance = equityCurve[0].balance;
    const totalPnlPercent = initialBalance > 0 ? (totalPnl / initialBalance) * 100 : 0;
    const avgTradeReturn = totalTrades > 0 ? totalPnl / totalTrades : 0;
    const avgHoldingPeriodSecs =
      totalTrades > 0
        ? trades.reduce((sum, t) => sum + t.holdingPeriodSecs, 0) / totalTrades
        : 0;
    const totalVolume = trades.reduce((sum, t) => sum + t.entryPrice * t.size * 2, 0);

    return {
      totalPnl,
      totalPnlPercent,
      winRate,
      totalTrades,
      winningTrades: winningTrades.length,
      losingTrades: losingTrades.length,
      maxDrawdown,
      maxDrawdownPercent,
      sharpeRatio,
      profitFactor,
      avgTradeReturn,
      avgHoldingPeriodSecs,
      totalFeesPaid,
      totalVolume,
    };
  }

  /**
   * Compute the annualised Sharpe ratio from the equity curve.
   *
   * Algorithm:
   * 1. Group snapshots by calendar day (YYYY-MM-DD).
   * 2. For each consecutive pair of days, compute daily return as
   *    percentage change between the first equity of day[i] and day[i+1].
   * 3. Sharpe = (mean / stdDev) * sqrt(252).
   * 4. Return 0 if fewer than 2 calendar days.
   *
   * Requirement 5.5
   */
  private _computeSharpeRatio(equityCurve: BalanceSnapshot[]): number {
    // Group by calendar day
    const dayMap = new Map<string, number>(); // day → first equity of that day
    for (const snapshot of equityCurve) {
      const day = snapshot.timestamp.slice(0, 10); // "YYYY-MM-DD"
      if (!dayMap.has(day)) {
        dayMap.set(day, snapshot.equity);
      }
    }

    const days = Array.from(dayMap.keys()).sort(); // ascending
    if (days.length < 2) {
      return 0;
    }

    // Compute daily returns as % change between consecutive days
    const dailyReturns: number[] = [];
    for (let i = 1; i < days.length; i++) {
      const prevEquity = dayMap.get(days[i - 1])!;
      const currEquity = dayMap.get(days[i])!;
      if (prevEquity === 0) {
        dailyReturns.push(0);
      } else {
        dailyReturns.push((currEquity - prevEquity) / prevEquity);
      }
    }

    const mean = dailyReturns.reduce((sum, r) => sum + r, 0) / dailyReturns.length;

    if (dailyReturns.length < 2) {
      // Only one return value — stdDev is 0, Sharpe is undefined → return 0
      return 0;
    }

    const variance =
      dailyReturns.reduce((sum, r) => sum + (r - mean) ** 2, 0) / (dailyReturns.length - 1);
    const stdDev = Math.sqrt(variance);

    if (stdDev === 0) {
      return 0;
    }

    return (mean / stdDev) * Math.sqrt(252);
  }

  /**
   * Build a zero-value `BacktestResult` for the case where `finalize()` is
   * called before any `recordTick()` call.
   *
   * Requirement 5.11
   */
  private _zeroResult(completedAt: string, durationMs: number): BacktestResult {
    const zeroMetrics: BacktestMetrics = {
      totalPnl: 0,
      totalPnlPercent: 0,
      winRate: 0,
      totalTrades: 0,
      winningTrades: 0,
      losingTrades: 0,
      maxDrawdown: 0,
      maxDrawdownPercent: 0,
      sharpeRatio: 0,
      profitFactor: 0,
      avgTradeReturn: 0,
      avgHoldingPeriodSecs: 0,
      totalFeesPaid: 0,
      totalVolume: 0,
    };

    return {
      runId: this.runId,
      status: 'completed',
      config: this.config,
      metrics: zeroMetrics,
      equityCurve: [],
      trades: [],
      startedAt: this.startedAt,
      completedAt,
      candlesProcessed: 0,
      durationMs,
    };
  }
}
